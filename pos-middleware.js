/**
 * pos-middleware.js
 * 
 * Injects our tracking_id + customer_id into Square and Toast
 * WITHOUT replacing the SMB's existing POS workflow.
 * 
 * Strategy per POS:
 *  - Square: uses Order metadata (reference_id + note fields)
 *  - Toast: uses externalId + orderSource on each check
 * 
 * The SMB keeps using Square/Toast normally.
 * We attach to every transaction silently in the background.
 */

const { createClient } = require('@supabase/supabase-js');
const { Client, Environment } = require('square');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── SQUARE INJECTION ─────────────────────────────────────────────────────────

/**
 * Called right before or after a Square order/booking is created.
 * Injects our call_id + customer_id into the order's reference_id and metadata.
 * 
 * Usage: Call this from your booking form submit handler, passing
 * the Square order ID and our internal call/customer IDs.
 */
async function injectSquareOrder({ squareOrderId, squareLocationId, callId, customerId, businessId }) {
  const squareClient = getSquareClient(businessId);

  try {
    // Fetch the existing order first (to get current version)
    const { result: orderResult } = await squareClient.ordersApi.retrieveOrder(squareOrderId);
    const order = orderResult.order;

    // Update with our tracking metadata
    const { result } = await squareClient.ordersApi.updateOrder(squareOrderId, {
      order: {
        locationId: squareLocationId,
        version: order.version,
        referenceId: callId,             // our call_id in Square's reference_id field
        metadata: {
          ...order.metadata,
          crt_call_id: callId,           // crt = call revenue tracker
          crt_customer_id: customerId,
          crt_business_id: businessId,
          crt_injected_at: new Date().toISOString(),
        },
      },
      idempotencyKey: `inject-${squareOrderId}-${callId}`,
    });

    console.log(`Square order ${squareOrderId} tagged with call ${callId}`);

    // Save injection record to our DB
    await supabase.from('bookings').upsert({
      call_id: callId,
      customer_id: customerId,
      business_id: businessId,
      external_id: squareOrderId,
      booking_source: 'square',
      status: 'confirmed',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'external_id' });

    return result.order;
  } catch (err) {
    console.error('Square injection failed:', err.message);
    throw err;
  }
}

/**
 * Attach our tracking to a Square Booking (appointments API).
 * Square bookings don't have full order metadata so we use sellerNote.
 */
async function injectSquareBooking({ squareBookingId, callId, customerId, businessId }) {
  const squareClient = getSquareClient(businessId);

  try {
    const { result: bookingResult } = await squareClient.bookingsApi.retrieveBooking(squareBookingId);
    const booking = bookingResult.booking;

    await squareClient.bookingsApi.updateBooking(squareBookingId, {
      booking: {
        version: booking.version,
        sellerNote: [booking.sellerNote, `CRT:${callId}`].filter(Boolean).join(' | '),
      },
      idempotencyKey: `inject-booking-${squareBookingId}-${callId}`,
    });

    await supabase.from('bookings').upsert({
      call_id: callId,
      customer_id: customerId,
      business_id: businessId,
      external_id: squareBookingId,
      booking_source: 'square',
      status: 'confirmed',
      scheduled_at: booking.startAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'external_id' });

    console.log(`Square booking ${squareBookingId} tagged with call ${callId}`);
  } catch (err) {
    console.error('Square booking injection failed:', err.message);
    throw err;
  }
}

// ─── TOAST INJECTION ──────────────────────────────────────────────────────────

/**
 * Toast uses externalId on each check.
 * We set externalId = our call_id so we can reconcile payments later.
 * 
 * Toast API: PATCH /orders/{guid}
 */
async function injectToastOrder({ toastOrderGuid, callId, customerId, businessId, locationId }) {
  // Get Toast credentials for this business
  const { data: location } = await supabase
    .from('locations')
    .select('toast_location_id')
    .eq('id', locationId)
    .single();

  const toastToken = await getToastToken(businessId);

  try {
    // Toast: patch the order's externalId
    const response = await fetch(
      `https://ws-api.toasttab.com/orders/v2/orders/${toastOrderGuid}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${toastToken}`,
          'Content-Type': 'application/json',
          'Toast-Restaurant-External-ID': location?.toast_location_id,
        },
        body: JSON.stringify({
          externalId: callId,             // Our call_id as Toast's externalId
          source: 'PARTNER',
          // Store extra refs in the check's externalId chain
        }),
      }
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Toast PATCH failed: ${response.status} ${errBody}`);
    }

    // Save to our DB
    await supabase.from('bookings').upsert({
      call_id: callId,
      customer_id: customerId,
      business_id: businessId,
      location_id: locationId,
      external_id: toastOrderGuid,
      booking_source: 'toast',
      status: 'confirmed',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'external_id' });

    console.log(`Toast order ${toastOrderGuid} tagged with call ${callId}`);
  } catch (err) {
    console.error('Toast injection failed:', err.message);
    throw err;
  }
}

// ─── SQUARE PAYMENT WEBHOOK: read back our injected tags ─────────────────────
/**
 * When Square fires payment.completed, we read back our metadata
 * to tie the payment to the original call. 
 * Called from server.js /webhooks/square handler.
 */
async function reconcileSquarePayment(squarePaymentEvent) {
  const payment = squarePaymentEvent.data?.object?.payment;
  if (!payment) return null;

  const orderId = payment.order_id;
  if (!orderId) return null;

  // Try to find booking by Square order ID (which we injected earlier)
  const { data: booking } = await supabase
    .from('bookings')
    .select('*, calls(*)')
    .eq('external_id', orderId)
    .single();

  const callId = booking?.call_id || payment.referenceId;
  const amountCents = payment.amount_money?.amount || 0;

  if (!callId) {
    console.warn(`Square payment ${payment.id} — no call_id found in order ${orderId}`);
    return null;
  }

  // Write revenue record
  const { data: revenue } = await supabase.from('revenue').upsert({
    booking_id: booking?.id,
    call_id: callId,
    customer_id: booking?.customer_id,
    source: booking?.calls?.source || 'square_pos',
    campaign: booking?.calls?.campaign,
    payment_source: 'square',
    external_id: payment.id,
    amount_cents: amountCents,
    paid_at: payment.updated_at,
  }, { onConflict: 'external_id' }).select().single();

  // Update booking
  if (booking?.id) {
    await supabase.from('bookings').update({
      revenue_id: revenue?.id,
      amount_cents: amountCents,
      status: 'completed',
      updated_at: new Date().toISOString(),
    }).eq('id', booking.id);
  }

  console.log(`Square payment reconciled: $${(amountCents / 100).toFixed(2)} → call ${callId}`);

  // Trigger journey (if service already confirmed)
  const { data: transcript } = await supabase
    .from('transcripts')
    .select('extracted_service, service_catalog_id, needs_confirmation')
    .eq('call_id', callId)
    .single();

  if (transcript?.extracted_service && !transcript.needs_confirmation) {
    const { scheduleJourney } = require('./service-detection');
    await scheduleJourney(
      callId,
      transcript.extracted_service,
      transcript.service_catalog_id,
      booking?.calls?.business_id,
      booking?.location_id
    );
  }

  return revenue;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getSquareClient(businessId) {
  // In production: load per-business Square credentials from DB/vault
  // For now: use env vars (single-tenant bootstrap)
  return new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.NODE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
  });
}

async function getToastToken(businessId) {
  // Toast uses client_credentials OAuth
  const response = await fetch('https://ws-api.toasttab.com/authentication/v1/authentication/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  });
  const data = await response.json();
  return data.token?.accessToken;
}

// ─── BOOKING FORM HELPER: detect dropdown + inject ───────────────────────────
/**
 * Called from your booking page's form submit.
 * Detects if a service was selected from dropdown, injects to POS.
 * 
 * Frontend usage:
 *   POST /api/booking/submit
 *   { callId, selectedService, squareOrderId, customerPhone }
 */
async function handleBookingSubmit(req, res) {
  const { callId, selectedService, squareOrderId, squareBookingId, toastOrderGuid, locationId, businessId } = req.body;

  // Find or create customer
  let customerId = null;
  if (req.body.customerPhone) {
    const { data: customer } = await supabase
      .from('customers')
      .upsert({
        phone: req.body.customerPhone.replace(/\D/g, '').slice(-10),
        name: req.body.customerName,
        email: req.body.customerEmail,
        location_id: locationId,
        business_id: businessId,
      }, { onConflict: 'phone' })
      .select()
      .single();
    customerId = customer?.id;
  }

  // Inject to POS
  const injections = [];
  if (squareOrderId)   injections.push(injectSquareOrder({ squareOrderId, squareLocationId: req.body.squareLocationId, callId, customerId, businessId }));
  if (squareBookingId) injections.push(injectSquareBooking({ squareBookingId, callId, customerId, businessId }));
  if (toastOrderGuid)  injections.push(injectToastOrder({ toastOrderGuid, callId, customerId, businessId, locationId }));

  await Promise.allSettled(injections);

  // Run service detection waterfall (Level 1: dropdown)
  if (selectedService) {
    const { detectFromDropdown } = require('./service-detection');
    await detectFromDropdown(callId, selectedService, businessId, locationId);
  }

  res.json({ success: true, customerId, callId });
}

module.exports = {
  injectSquareOrder,
  injectSquareBooking,
  injectToastOrder,
  reconcileSquarePayment,
  handleBookingSubmit,
};
