/**
 * journey-engine.js
 * 
 * Runs on a cron (every 5 minutes via Railway / Render cron job).
 * Finds scheduled journeys that are due → fires SMS (Twilio) + email (Resend).
 * 
 * Message flow per customer:
 *   T+0  (payment confirmed): journey created
 *   T+Nh (follow_up_days × 24h): SMS + email sent with offer + review link
 */

const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { Resend } = require('resend');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── CRON ENTRY POINT ─────────────────────────────────────────────────────────
/**
 * Call this every 5 minutes from your cron job:
 *   node -e "require('./journey-engine').runDueJourneys()"
 * 
 * Or in server.js:
 *   setInterval(() => require('./journey-engine').runDueJourneys(), 5 * 60 * 1000);
 */
async function runDueJourneys() {
  const now = new Date().toISOString();

  const { data: dueJourneys, error } = await supabase
    .from('journeys')
    .select(`
      *,
      businesses(name, google_review_url, twilio_number),
      locations(name, google_review_url, twilio_number),
      customers(name, phone, email)
    `)
    .eq('status', 'scheduled')
    .lte('scheduled_send_at', now)
    .limit(50); // process in batches

  if (error) { console.error('Journey fetch error:', error); return; }
  if (!dueJourneys?.length) { console.log('No journeys due'); return; }

  console.log(`Processing ${dueJourneys.length} due journeys`);

  for (const journey of dueJourneys) {
    try {
      await fireJourney(journey);
    } catch (err) {
      console.error(`Journey ${journey.id} failed:`, err.message);
      await supabase.from('journeys').update({ status: 'failed' }).eq('id', journey.id);
    }
  }
}

// ─── FIRE A SINGLE JOURNEY ────────────────────────────────────────────────────
async function fireJourney(journey) {
  const customer = journey.customers;
  const business = journey.businesses;
  const location = journey.locations;

  // Opt-out check
  if (customer?.phone) {
    const { data: optOut } = await supabase
      .from('opt_outs')
      .select('id')
      .eq('phone', customer.phone)
      .eq('business_id', journey.business_id)
      .limit(1)
      .single();

    if (optOut) {
      console.log(`Customer ${customer.phone} opted out — skipping journey ${journey.id}`);
      await supabase.from('journeys').update({ status: 'opted_out' }).eq('id', journey.id);
      return;
    }
  }

  const businessName = location?.name || business?.name || 'us';
  const reviewUrl = location?.google_review_url || business?.google_review_url;
  const fromNumber = location?.twilio_number || business?.twilio_number || process.env.TWILIO_FROM_NUMBER;

  const results = { sms: null, email: null };

  // ── Send SMS ──────────────────────────────────────────────────
  if (customer?.phone) {
    const smsBody = buildSMSBody({
      customerName: customer.name,
      businessName,
      serviceName: journey.service_name,
      offerText: journey.offer_text,
      reviewUrl,
    });

    try {
      const msg = await twilioClient.messages.create({
        body: smsBody,
        from: fromNumber,
        to: customer.phone,
      });

      results.sms = await supabase.from('messages').insert({
        journey_id: journey.id,
        business_id: journey.business_id,
        customer_id: journey.customer_id,
        channel: 'sms',
        direction: 'outbound',
        to_address: customer.phone,
        from_address: fromNumber,
        body: smsBody,
        provider: 'twilio',
        provider_id: msg.sid,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      console.log(`SMS sent to ${customer.phone} for journey ${journey.id}`);
    } catch (err) {
      console.error(`SMS failed for ${customer.phone}:`, err.message);
    }
  }

  // ── Send Email ────────────────────────────────────────────────
  if (customer?.email) {
    const { subject, html } = buildEmailBody({
      customerName: customer.name,
      businessName,
      serviceName: journey.service_name,
      offerText: journey.offer_text,
      reviewUrl,
    });

    try {
      const emailResult = await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL,
        to: customer.email,
        subject,
        html,
      });

      await supabase.from('messages').insert({
        journey_id: journey.id,
        business_id: journey.business_id,
        customer_id: journey.customer_id,
        channel: 'email',
        direction: 'outbound',
        to_address: customer.email,
        from_address: process.env.RESEND_FROM_EMAIL,
        subject,
        body: html,
        provider: 'resend',
        provider_id: emailResult.id,
        status: 'sent',
        sent_at: new Date().toISOString(),
      });

      console.log(`Email sent to ${customer.email} for journey ${journey.id}`);
    } catch (err) {
      console.error(`Email failed for ${customer.email}:`, err.message);
    }
  }

  // ── Mark journey complete ─────────────────────────────────────
  await supabase.from('journeys').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', journey.id);
}

// ─── MESSAGE BUILDERS ─────────────────────────────────────────────────────────

function buildSMSBody({ customerName, businessName, serviceName, offerText, reviewUrl }) {
  const greeting = customerName ? `Hi ${customerName.split(' ')[0]}` : 'Hi there';
  const serviceStr = serviceName ? `your recent ${serviceName}` : 'your recent service';

  let body = `${greeting} — thank you for choosing ${businessName} for ${serviceStr}!`;

  if (offerText) {
    body += `\n\n${offerText}`;
  }

  if (reviewUrl) {
    body += `\n\nWe would love your feedback — it takes 30 seconds and means everything to our small business:\n${reviewUrl}`;
  }

  body += `\n\nReply STOP to unsubscribe.`;

  return body;
}

function buildEmailBody({ customerName, businessName, serviceName, offerText, reviewUrl }) {
  const firstName = customerName?.split(' ')[0] || 'there';
  const serviceStr = serviceName || 'your recent service';
  const subject = `Thank you for choosing ${businessName}${serviceName ? ` — ${serviceName}` : ''}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: #1a1a2e; padding: 32px 40px; }
    .header h1 { color: #00E5BE; margin: 0; font-size: 22px; font-weight: 700; }
    .header p { color: rgba(255,255,255,0.6); margin: 6px 0 0; font-size: 14px; }
    .body { padding: 36px 40px; }
    .body p { color: #444; line-height: 1.7; font-size: 15px; margin: 0 0 16px; }
    .offer-box { background: #f0fdf9; border: 1px solid #00E5BE44; border-radius: 8px; padding: 20px; margin: 24px 0; }
    .offer-box p { color: #1a1a2e; margin: 0; font-weight: 500; }
    .review-btn { display: inline-block; background: #00E5BE; color: #0a0a1a; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; margin: 8px 0 24px; }
    .footer { background: #f9f9f9; border-top: 1px solid #eee; padding: 20px 40px; }
    .footer p { color: #aaa; font-size: 12px; margin: 0; }
    .footer a { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${businessName}</h1>
      <p>Thank you for your business</p>
    </div>
    <div class="body">
      <p>Hi ${firstName},</p>
      <p>Thank you for trusting <strong>${businessName}</strong> with ${serviceStr}. We truly appreciate your business and hope everything is working perfectly.</p>

      ${offerText ? `
      <div class="offer-box">
        <p>🎁 ${offerText}</p>
      </div>
      ` : ''}

      ${reviewUrl ? `
      <p>If you have a moment, we would be incredibly grateful for a quick Google review. It takes less than a minute and helps our small business more than you know:</p>
      <a href="${reviewUrl}" class="review-btn">⭐ Leave a Review</a>
      <p style="font-size:13px;color:#888;">Every review makes a real difference — thank you in advance.</p>
      ` : ''}

      <p>If there is anything we can improve or if you have any questions about your service, please don't hesitate to reach out.</p>
      <p>With appreciation,<br><strong>The ${businessName} Team</strong></p>
    </div>
    <div class="footer">
      <p>You are receiving this because you recently used ${businessName}. <a href="#">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html };
}

// ─── WEBHOOK: Twilio inbound SMS handler ──────────────────────────────────────
// Add to server.js: app.post('/webhooks/twilio/inbound', handleTwilioInbound)
async function handleTwilioInbound(req, res) {
  const { From, Body } = req.body;
  const { handleSMBReply } = require('./service-detection');

  try {
    const result = await handleSMBReply(From, Body);
    // Twilio expects TwiML response
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${result?.message || `Got it — service confirmed as "${result?.resolved}". We will take it from here! ✓`}</Message>
</Response>`);
  } catch (err) {
    console.error('Inbound SMS error:', err);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }
}

// ─── WEBHOOK: Resend email events (open/click tracking) ──────────────────────
async function handleResendWebhook(req, res) {
  const event = req.body;

  if (event.type === 'email.clicked') {
    // Check if it was the review link
    const clickedUrl = event.data?.click?.link || '';
    if (clickedUrl.includes('google.com/maps') || clickedUrl.includes('review')) {
      await supabase
        .from('messages')
        .update({ review_link_clicked: true, clicked_at: new Date().toISOString(), status: 'clicked' })
        .eq('provider_id', event.data?.email_id);
    }
  }

  if (event.type === 'email.delivered') {
    await supabase
      .from('messages')
      .update({ status: 'delivered' })
      .eq('provider_id', event.data?.email_id);
  }

  res.json({ received: true });
}

module.exports = {
  runDueJourneys,
  fireJourney,
  handleTwilioInbound,
  handleResendWebhook,
};
