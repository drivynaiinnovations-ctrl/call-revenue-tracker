/**
 * service-detection.js
 * 
 * The full 4-level service detection waterfall:
 * 
 *   Level 1: Booking page dropdown → confidence: 'dropdown'      (1.00)
 *   Level 2: Call transcript → Claude API → confidence: 'transcript'
 *   Level 3: SMS to SMB owner → numbered + free text reply
 *   Level 4: Flag as 'unconfirmed' in dashboard
 */

const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONFIDENCE_THRESHOLD = 0.70; // below this → SMS confirmation

// ─── LEVEL 1: Booking page dropdown ──────────────────────────────────────────
/**
 * Called when a booking form is submitted with a service dropdown selection.
 * This is the highest-confidence path — customer chose it explicitly.
 * 
 * @param {string} callId
 * @param {string} selectedService  - value from dropdown
 * @param {string} businessId
 * @param {string} locationId
 */
async function detectFromDropdown(callId, selectedService, businessId, locationId) {
  // Match to service catalog
  const { data: catalog } = await supabase
    .from('service_catalog')
    .select('*')
    .eq('business_id', businessId)
    .ilike('name', `%${selectedService}%`)
    .limit(1)
    .single();

  const result = {
    service: catalog?.name || selectedService,
    confidence: 1.0,
    confidence_source: 'dropdown',
    service_catalog_id: catalog?.id || null,
    estimated_cost_min: catalog?.estimated_min || 0,
    estimated_cost_max: catalog?.estimated_max || 0,
  };

  await saveTranscriptResult(callId, businessId, locationId, null, result);
  return result;
}

// ─── LEVEL 2: Claude transcript parser ───────────────────────────────────────
/**
 * Sends transcript to Claude. Claude extracts service type, cost estimate,
 * and urgency. Returns confidence score.
 * 
 * If confidence < CONFIDENCE_THRESHOLD → triggers Level 3 (SMS).
 */
async function detectFromTranscript(callId, transcript, businessId, locationId) {
  // Load industry catalog for this business
  const { data: business } = await supabase
    .from('businesses')
    .select('industry')
    .eq('id', businessId)
    .single();

  const { data: catalog } = await supabase
    .from('service_catalog')
    .select('code, name, keywords')
    .or(`business_id.eq.${businessId},industry.eq.${business?.industry}`)
    .eq('active', true)
    .order('code');

  const catalogList = catalog?.map(s => `${s.code}. ${s.name} (keywords: ${s.keywords?.join(', ')})`).join('\n') || '';

  // Ask Claude to parse the transcript
  const prompt = `You are analyzing a service call transcript for a ${business?.industry || 'home services'} company.

Extract the following from this transcript and return ONLY valid JSON:
- service_name: The specific service performed or requested (string)
- service_code: The matching catalog code number (integer, or null if no match)
- estimated_cost_cents: Your best estimate of the job cost in cents based on context (integer, or null)
- confidence: How confident you are this is correct (float 0.0-1.0)
- reasoning: One sentence explaining your extraction (string)
- urgency: Was this an emergency call? (boolean)

Service catalog for matching:
${catalogList}

Transcript:
"""
${transcript}
"""

Return ONLY a JSON object, no other text.`;

  let extraction = null;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0].text.trim();
    extraction = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('Claude extraction failed:', err.message);
    extraction = { service_name: null, confidence: 0, reasoning: 'parse error' };
  }

  // Match to catalog
  let catalogMatch = null;
  if (extraction.service_code != null) {
    const { data } = await supabase
      .from('service_catalog')
      .select('*')
      .or(`business_id.eq.${businessId},industry.eq.${business?.industry}`)
      .eq('code', extraction.service_code)
      .limit(1)
      .single();
    catalogMatch = data;
  }

  const result = {
    service: extraction.service_name || catalogMatch?.name,
    confidence: extraction.confidence || 0,
    confidence_source: 'transcript',
    service_catalog_id: catalogMatch?.id || null,
    estimated_cost_min: catalogMatch?.estimated_min || 0,
    estimated_cost_max: catalogMatch?.estimated_max || extraction.estimated_cost_cents || 0,
    extraction_raw: extraction,
    needs_confirmation: (extraction.confidence || 0) < CONFIDENCE_THRESHOLD,
  };

  await saveTranscriptResult(callId, businessId, locationId, transcript, result);

  // If confidence too low → Level 3
  if (result.needs_confirmation) {
    console.log(`Low confidence (${extraction.confidence}) for call ${callId} → triggering SMS confirmation`);
    await triggerSMSConfirmation(callId, businessId, locationId, extraction);
  }

  return result;
}

// ─── LEVEL 3: SMS confirmation to SMB owner ───────────────────────────────────
/**
 * Sends a numbered menu + free-text option to the SMB owner.
 * Twilio inbound webhook handles their reply → handleSMBReply()
 */
async function triggerSMSConfirmation(callId, businessId, locationId, extractionHint) {
  const { data: business } = await supabase
    .from('businesses')
    .select('owner_phone, owner_name, industry, name')
    .eq('id', businessId)
    .single();

  if (!business?.owner_phone) {
    console.warn(`No owner phone for business ${businessId} — flagging as unconfirmed`);
    await flagUnconfirmed(callId, businessId);
    return;
  }

  // Load catalog for this industry
  const { data: catalog } = await supabase
    .from('service_catalog')
    .select('code, name')
    .or(`business_id.eq.${businessId},industry.eq.${business.industry}`)
    .eq('active', true)
    .order('code')
    .limit(9);

  // Get customer info for context
  const { data: call } = await supabase
    .from('calls')
    .select('phone, started_at, customers(name)')
    .eq('id', callId)
    .single();

  const customerName = call?.customers?.name || call?.phone || 'a customer';
  const callDate = call?.started_at
    ? new Date(call.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'recently';

  // Build numbered menu
  const menuLines = catalog?.map(s => `${s.code} - ${s.name}`).join('\n') || '';
  const hintLine = extractionHint?.service_name
    ? `\n(We think it may have been: ${extractionHint.service_name})\n`
    : '\n';

  const smsBody =
    `Hi ${business.owner_name || 'there'} 👋 — ${business.name} had a call with ${customerName} on ${callDate}. ` +
    `What service did you provide?\n${hintLine}` +
    `Reply with a number:\n${menuLines}\n0 - Other / Not Listed\n\n` +
    `Or just reply with the service name if not listed above.`;

  // Send SMS
  let twilioSid = null;
  try {
    const msg = await twilioClient.messages.create({
      body: smsBody,
      from: process.env.TWILIO_FROM_NUMBER,
      to: business.owner_phone,
    });
    twilioSid = msg.sid;
  } catch (err) {
    console.error('Twilio send failed:', err.message);
  }

  // Save confirmation record
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('service_confirmations').insert({
    call_id: callId,
    business_id: businessId,
    location_id: locationId,
    sms_sent_at: new Date().toISOString(),
    sms_body: smsBody,
    status: 'pending',
    expires_at: expiresAt,
  });

  console.log(`SMS confirmation sent to ${business.owner_phone} for call ${callId}`);
}

// ─── LEVEL 3b: Handle SMB reply (Twilio inbound webhook) ─────────────────────
/**
 * Called by POST /webhooks/twilio/inbound
 * 
 * Parses:
 *   - Single digit reply ("2") → numbered catalog lookup
 *   - Free text ("water heater replacement") → Claude mini parse OR keyword match
 *   - STOP / UNSUBSCRIBE → opt-out
 */
async function handleSMBReply(fromPhone, replyText) {
  const cleaned = replyText.trim();

  // Opt-out handling (TCPA)
  if (/^(stop|unsubscribe|cancel|quit|end)$/i.test(cleaned)) {
    await supabase.from('opt_outs').upsert({ phone: fromPhone, reason: 'STOP' }, { onConflict: 'phone,business_id' });
    return { message: 'You have been unsubscribed. Reply START to resubscribe.' };
  }

  // Find pending confirmation for this phone
  const { data: business } = await supabase
    .from('businesses')
    .select('id, industry')
    .eq('owner_phone', fromPhone)
    .single();

  if (!business) {
    console.warn(`No business found for phone ${fromPhone}`);
    return null;
  }

  const { data: confirmation } = await supabase
    .from('service_confirmations')
    .select('*')
    .eq('business_id', business.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!confirmation) {
    return { message: 'No pending service confirmation found.' };
  }

  let resolvedService = null;
  let resolvedCatalogId = null;
  let replyCode = null;
  let replyFreeText = null;

  // ── Path A: Numbered reply (single digit 0-9) ─────────────────
  const numericMatch = cleaned.match(/^([0-9])$/);
  if (numericMatch) {
    replyCode = parseInt(numericMatch[1]);
    const { data: catalogItem } = await supabase
      .from('service_catalog')
      .select('*')
      .or(`business_id.eq.${business.id},industry.eq.${business.industry}`)
      .eq('code', replyCode)
      .limit(1)
      .single();

    resolvedService = catalogItem?.name || `Service code ${replyCode}`;
    resolvedCatalogId = catalogItem?.id || null;
  }

  // ── Path B: Free text reply ───────────────────────────────────
  else {
    replyFreeText = cleaned;

    // First try keyword match against catalog
    const { data: catalog } = await supabase
      .from('service_catalog')
      .select('*')
      .or(`business_id.eq.${business.id},industry.eq.${business.industry}`)
      .eq('active', true);

    const lowerReply = cleaned.toLowerCase();
    let keywordMatch = null;
    let bestScore = 0;

    for (const item of (catalog || [])) {
      const score = (item.keywords || []).filter(kw => lowerReply.includes(kw)).length;
      if (score > bestScore) {
        bestScore = score;
        keywordMatch = item;
      }
    }

    if (keywordMatch && bestScore > 0) {
      resolvedService = keywordMatch.name;
      resolvedCatalogId = keywordMatch.id;
    } else {
      // Fallback: store the free text as-is
      resolvedService = cleaned;
    }
  }

  // Update confirmation record
  await supabase
    .from('service_confirmations')
    .update({
      reply_raw: replyText,
      reply_code: replyCode,
      reply_free_text: replyFreeText,
      resolved_service: resolvedService,
      resolved_catalog_id: resolvedCatalogId,
      status: 'replied',
      replied_at: new Date().toISOString(),
    })
    .eq('id', confirmation.id);

  // Update transcript with confirmed service
  await supabase
    .from('transcripts')
    .update({
      extracted_service: resolvedService,
      confidence: 1.0,
      confidence_source: 'sms_confirmed',
      service_catalog_id: resolvedCatalogId,
      needs_confirmation: false,
      confirmed_at: new Date().toISOString(),
    })
    .eq('call_id', confirmation.call_id);

  // Update booking with confirmed service
  await supabase
    .from('bookings')
    .update({ service: resolvedService, updated_at: new Date().toISOString() })
    .eq('call_id', confirmation.call_id);

  // Now we have enough data to schedule the customer journey
  await scheduleJourney(confirmation.call_id, resolvedService, resolvedCatalogId, business.id, confirmation.location_id);

  console.log(`SMB confirmed service "${resolvedService}" for call ${confirmation.call_id}`);
  return { resolved: resolvedService };
}

// ─── LEVEL 4: Flag as unconfirmed ────────────────────────────────────────────
async function flagUnconfirmed(callId, businessId) {
  await supabase
    .from('transcripts')
    .update({ needs_confirmation: true, confidence_source: 'unconfirmed' })
    .eq('call_id', callId);

  console.warn(`Call ${callId} flagged as unconfirmed — will appear in dashboard`);
}

// ─── SHARED: Save transcript + extraction result ──────────────────────────────
async function saveTranscriptResult(callId, businessId, locationId, rawText, result) {
  await supabase.from('transcripts').upsert({
    call_id: callId,
    business_id: businessId,
    location_id: locationId,
    raw_text: rawText || '',
    extracted_service: result.service,
    extracted_cost: result.estimated_cost_max || 0,
    confidence: result.confidence,
    confidence_source: result.confidence_source,
    service_catalog_id: result.service_catalog_id,
    extraction_raw: result.extraction_raw || null,
    needs_confirmation: result.needs_confirmation || false,
  }, { onConflict: 'call_id' });
}

// ─── MAIN ENTRY: Run the full waterfall ──────────────────────────────────────
/**
 * Called after every call ends.
 * Automatically picks the best detection path.
 * 
 * @param {object} opts
 * @param {string} opts.callId
 * @param {string} opts.businessId
 * @param {string} opts.locationId
 * @param {string} [opts.dropdownService]  - if booking form had a dropdown
 * @param {string} [opts.transcript]       - raw call transcript text
 */
async function detectService(opts) {
  const { callId, businessId, locationId, dropdownService, transcript } = opts;

  // Level 1: Dropdown
  if (dropdownService) {
    console.log(`[${callId}] Service detected via dropdown: "${dropdownService}"`);
    return detectFromDropdown(callId, dropdownService, businessId, locationId);
  }

  // Level 2: Transcript
  if (transcript && transcript.length > 50) {
    console.log(`[${callId}] Running transcript extraction (${transcript.length} chars)`);
    return detectFromTranscript(callId, transcript, businessId, locationId);
  }

  // Level 3: No transcript — send SMS directly
  console.log(`[${callId}] No transcript available — sending SMS to SMB`);
  await triggerSMSConfirmation(callId, businessId, locationId, null);
  return { service: null, confidence: 0, confidence_source: 'sms_pending' };
}

// ─── JOURNEY SCHEDULER (called once service confirmed) ───────────────────────
async function scheduleJourney(callId, serviceName, catalogId, businessId, locationId) {
  // Load catalog for timing + offer
  const { data: catalogItem } = catalogId
    ? await supabase.from('service_catalog').select('*').eq('id', catalogId).single()
    : { data: null };

  const followUpHours = (catalogItem?.follow_up_days || 1) * 24;
  const scheduledAt = new Date(Date.now() + followUpHours * 60 * 60 * 1000).toISOString();

  // Get call → booking → revenue → customer chain
  const { data: call } = await supabase
    .from('calls')
    .select('customer_id, bookings(id, revenue_id)')
    .eq('id', callId)
    .single();

  const { data: business } = await supabase
    .from('businesses')
    .select('google_review_url')
    .eq('id', businessId)
    .single();

  const { data: location } = await supabase
    .from('locations')
    .select('google_review_url')
    .eq('id', locationId)
    .single();

  const reviewUrl = location?.google_review_url || business?.google_review_url;
  const bookingId = call?.bookings?.[0]?.id;
  const revenueId = call?.bookings?.[0]?.revenue_id;

  // Check not already scheduled for this call
  const { data: existing } = await supabase
    .from('journeys')
    .select('id')
    .eq('call_id', callId)
    .limit(1)
    .single();

  if (existing) {
    console.log(`Journey already exists for call ${callId}`);
    return existing;
  }

  const { data: journey } = await supabase
    .from('journeys')
    .insert({
      business_id: businessId,
      location_id: locationId,
      customer_id: call?.customer_id,
      call_id: callId,
      booking_id: bookingId,
      revenue_id: revenueId,
      service_name: serviceName,
      service_catalog_id: catalogId,
      status: 'scheduled',
      trigger_event: 'payment_complete',
      scheduled_send_at: scheduledAt,
      offer_text: catalogItem?.offer_template,
      review_url: reviewUrl,
    })
    .select()
    .single();

  console.log(`Journey scheduled for call ${callId} → sends at ${scheduledAt}`);
  return journey;
}

module.exports = {
  detectService,
  detectFromDropdown,
  detectFromTranscript,
  handleSMBReply,
  triggerSMSConfirmation,
  scheduleJourney,
  flagUnconfirmed,
};
