const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.raw({ type: 'application/json' })); // for webhook signature verification

// ─── Supabase client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateCallId() {
  return 'call_' + crypto.randomBytes(8).toString('hex');
}

function generateCustomerId() {
  return 'cust_' + crypto.randomBytes(8).toString('hex');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/**
 * POST /api/calls/inbound
 * Called by your Voice AI (Bland, Vapi, Twilio, etc.) when a call starts.
 * Creates a customer record + call session.
 *
 * Body: { phone, name?, source, campaign?, metadata? }
 */
app.post('/api/calls/inbound', async (req, res) => {
  try {
    const { phone, name, source = 'voice_ai', campaign, metadata } = req.body;

    if (!phone) return res.status(400).json({ error: 'phone is required' });

    // Upsert customer by phone number
    const { data: customer, error: custErr } = await supabase
      .from('customers')
      .upsert({ phone, name, updated_at: new Date().toISOString() }, { onConflict: 'phone' })
      .select()
      .single();

    if (custErr) throw custErr;

    // Create call record
    const callId = generateCallId();
    const { data: call, error: callErr } = await supabase
      .from('calls')
      .insert({
        id: callId,
        customer_id: customer.id,
        phone,
        source,
        campaign,
        status: 'active',
        metadata,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (callErr) throw callErr;

    res.json({ call_id: callId, customer_id: customer.id, message: 'Call session created' });
  } catch (err) {
    console.error('inbound error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/calls/:callId/end
 * Called when a call ends. Updates duration + status.
 *
 * Body: { duration_seconds, outcome? }
 */
app.post('/api/calls/:callId/end', async (req, res) => {
  try {
    const { callId } = req.params;
    const { duration_seconds, outcome } = req.body;

    const { error } = await supabase
      .from('calls')
      .update({
        status: 'completed',
        duration_seconds,
        outcome,
        ended_at: new Date().toISOString(),
      })
      .eq('id', callId);

    if (error) throw error;
    res.json({ message: 'Call ended', call_id: callId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/bookings
 * Create a booking tied to a call.
 * Can be called directly by your booking integration or by a webhook handler.
 *
 * Body: { call_id, customer_id?, service, amount, scheduled_at, booking_source }
 */
app.post('/api/bookings', async (req, res) => {
  try {
    const { call_id, customer_id, service, amount, scheduled_at, booking_source, external_id } = req.body;

    // Resolve customer from call if not provided
    let resolvedCustomerId = customer_id;
    if (!resolvedCustomerId && call_id) {
      const { data: call } = await supabase
        .from('calls')
        .select('customer_id')
        .eq('id', call_id)
        .single();
      resolvedCustomerId = call?.customer_id;
    }

    const { data: booking, error } = await supabase
      .from('bookings')
      .insert({
        call_id,
        customer_id: resolvedCustomerId,
        service,
        amount_cents: Math.round((amount || 0) * 100),
        status: 'pending',
        scheduled_at,
        booking_source,
        external_id,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    // Update call to indicate it generated a booking
    if (call_id) {
      await supabase
        .from('calls')
        .update({ converted: true, booking_id: booking.id })
        .eq('id', call_id);
    }

    res.json({ booking_id: booking.id, message: 'Booking created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOKS ─────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/square
 * Square payment webhooks: payment.completed, booking.created, etc.
 */
app.post('/webhooks/square', async (req, res) => {
  try {
    // Verify Square signature
    const sig = req.headers['x-square-hmacsha256-signature'];
    const body = req.body.toString();
    const expected = crypto
      .createHmac('sha256', process.env.SQUARE_WEBHOOK_SECRET || '')
      .update(process.env.SQUARE_WEBHOOK_URL + body)
      .digest('base64');

    if (process.env.SQUARE_WEBHOOK_SECRET && sig !== expected) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(body);
    const type = event.type;

    if (type === 'payment.completed') {
      const payment = event.data.object.payment;
      const amountCents = payment.amount_money?.amount || 0;
      const phone = payment.buyer_email_address; // or parse from metadata
      const externalId = payment.id;

      // Find booking by external_id or phone, update revenue
      await reconcileRevenue({
        externalId,
        amountCents,
        source: 'square',
        paidAt: payment.updated_at,
      });
    }

    if (type === 'booking.created') {
      const booking = event.data.object.booking;
      // Map Square booking → our booking record
      await supabase.from('bookings').upsert({
        external_id: booking.id,
        booking_source: 'square',
        status: 'confirmed',
        scheduled_at: booking.start_at,
        amount_cents: 0, // updated on payment
        updated_at: new Date().toISOString(),
      }, { onConflict: 'external_id' });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('square webhook error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/calendly
 * Calendly webhooks: invitee.created, invitee.canceled
 */
app.post('/webhooks/calendly', async (req, res) => {
  try {
    const { event, payload } = req.body;

    if (event === 'invitee.created') {
      const phone = payload.questions_and_answers?.find(
        q => q.question.toLowerCase().includes('phone')
      )?.answer;

      const { data: customer } = phone
        ? await supabase.from('customers').select().eq('phone', normalizePhone(phone)).single()
        : { data: null };

      await supabase.from('bookings').upsert({
        external_id: payload.uri,
        customer_id: customer?.id,
        booking_source: 'calendly',
        service: payload.event_type?.name,
        status: 'confirmed',
        scheduled_at: payload.scheduled_event?.start_time,
        amount_cents: 0,
        metadata: { calendly_name: payload.name, calendly_email: payload.email },
        created_at: new Date().toISOString(),
      }, { onConflict: 'external_id' });
    }

    if (event === 'invitee.canceled') {
      await supabase.from('bookings')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('external_id', payload.uri);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('calendly webhook error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /webhooks/toast
 * Toast POS webhooks: order.completed, payment.processed
 */
app.post('/webhooks/toast', async (req, res) => {
  try {
    const event = req.body;

    if (event.eventType === 'PAYMENT_PROCESSED') {
      const amountCents = Math.round(event.order?.totalAmount * 100 || 0);
      await reconcileRevenue({
        externalId: event.order?.guid,
        amountCents,
        source: 'toast',
        paidAt: new Date().toISOString(),
        phone: event.customer?.phone,
      });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('toast webhook error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── REVENUE RECONCILIATION ────────────────────────────────────────────────────

/**
 * Core function: match a payment to a booking → call → source attribution
 */
async function reconcileRevenue({ externalId, amountCents, source, paidAt, phone }) {
  // 1. Find booking by external_id
  let booking = null;
  if (externalId) {
    const { data } = await supabase
      .from('bookings')
      .select('*, calls(*)')
      .eq('external_id', externalId)
      .single();
    booking = data;
  }

  // 2. Fallback: find most recent unmatched booking by phone
  if (!booking && phone) {
    const normalized = normalizePhone(phone);
    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', normalized)
      .single();

    if (customer) {
      const { data } = await supabase
        .from('bookings')
        .select('*, calls(*)')
        .eq('customer_id', customer.id)
        .is('revenue_id', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      booking = data;
    }
  }

  // 3. Create revenue record
  const { data: revenue, error } = await supabase
    .from('revenue')
    .insert({
      booking_id: booking?.id || null,
      call_id: booking?.call_id || null,
      customer_id: booking?.customer_id || null,
      source: booking?.calls?.source || source,
      campaign: booking?.calls?.campaign || null,
      amount_cents: amountCents,
      payment_source: source,
      external_id: externalId,
      paid_at: paidAt,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  // 4. Update booking with revenue reference
  if (booking?.id) {
    await supabase
      .from('bookings')
      .update({
        revenue_id: revenue.id,
        amount_cents: amountCents,
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', booking.id);
  }

  console.log(`Revenue reconciled: $${(amountCents / 100).toFixed(2)} from ${source} → call ${booking?.call_id || 'unattributed'}`);
  return revenue;
}

// ─── ANALYTICS API ────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/overview
 * Dashboard stats for the SMB owner
 */
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 30 * 86400000).toISOString();
    const toDate = to || new Date().toISOString();

    // Total calls
    const { count: totalCalls } = await supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', fromDate)
      .lte('started_at', toDate);

    // Converted calls
    const { count: convertedCalls } = await supabase
      .from('calls')
      .select('*', { count: 'exact', head: true })
      .eq('converted', true)
      .gte('started_at', fromDate)
      .lte('started_at', toDate);

    // Total revenue
    const { data: revenueData } = await supabase
      .from('revenue')
      .select('amount_cents, source, campaign')
      .gte('paid_at', fromDate)
      .lte('paid_at', toDate);

    const totalRevenueCents = revenueData?.reduce((s, r) => s + r.amount_cents, 0) || 0;

    // Revenue by source
    const bySource = {};
    revenueData?.forEach(r => {
      bySource[r.source] = (bySource[r.source] || 0) + r.amount_cents;
    });

    // Top calls by revenue
    const { data: topCalls } = await supabase
      .from('calls')
      .select(`
        id, phone, source, campaign, started_at,
        bookings(service, amount_cents, status),
        revenue(amount_cents, paid_at, payment_source)
      `)
      .eq('converted', true)
      .gte('started_at', fromDate)
      .order('started_at', { ascending: false })
      .limit(20);

    res.json({
      period: { from: fromDate, to: toDate },
      summary: {
        total_calls: totalCalls,
        converted_calls: convertedCalls,
        conversion_rate: totalCalls ? ((convertedCalls / totalCalls) * 100).toFixed(1) : 0,
        total_revenue_cents: totalRevenueCents,
        total_revenue: (totalRevenueCents / 100).toFixed(2),
        revenue_per_call: totalCalls ? ((totalRevenueCents / totalCalls) / 100).toFixed(2) : 0,
      },
      revenue_by_source: Object.entries(bySource).map(([source, cents]) => ({
        source,
        revenue: (cents / 100).toFixed(2),
        revenue_cents: cents,
      })),
      top_calls: topCalls?.map(call => ({
        ...call,
        revenue_generated: ((call.revenue?.[0]?.amount_cents || 0) / 100).toFixed(2),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calls/:callId/attribution
 * "This call generated $X in revenue" — the money shot
 */
app.get('/api/calls/:callId/attribution', async (req, res) => {
  try {
    const { callId } = req.params;

    const { data: call, error } = await supabase
      .from('calls')
      .select(`
        id, phone, source, campaign, status, duration_seconds,
        started_at, ended_at, converted,
        customers(name, phone),
        bookings(id, service, scheduled_at, status, amount_cents, booking_source,
          revenue(amount_cents, paid_at, payment_source)
        )
      `)
      .eq('id', callId)
      .single();

    if (error) throw error;

    const revenueGenerated = call.bookings?.reduce((sum, b) => {
      return sum + (b.revenue?.[0]?.amount_cents || 0);
    }, 0) || 0;

    res.json({
      call_id: callId,
      customer: call.customers,
      source: call.source,
      campaign: call.campaign,
      duration_seconds: call.duration_seconds,
      started_at: call.started_at,
      bookings: call.bookings,
      attribution: {
        revenue_generated: (revenueGenerated / 100).toFixed(2),
        revenue_cents: revenueGenerated,
        message: revenueGenerated > 0
          ? `This call generated $${(revenueGenerated / 100).toFixed(2)} in revenue`
          : 'No revenue attributed yet',
        converted: call.converted,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function normalizePhone(phone) {
  return phone?.replace(/\D/g, '').slice(-10);
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Call Revenue Tracker API running on :${PORT}`));

module.exports = app;
