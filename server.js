const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUM  = process.env.TWILIO_PHONE_NUMBER;
const MY_CELL     = process.env.MY_PHONE_NUMBER;

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Health check
app.get('/', (req, res) => res.json({ status: 'Dialer server running', number: TWILIO_NUM }));

// ── 1. Initiate outbound call ──
app.post('/call', async (req, res) => {
  const { leadPhone, leadName } = req.body;
  if (!leadPhone) return res.status(400).json({ error: 'leadPhone required' });
  try {
    const baseUrl = `https://${req.get('host')}`;
    const call = await client.calls.create({
      to: MY_CELL,
      from: TWILIO_NUM,
      url: `${baseUrl}/twiml/connect?leadPhone=${encodeURIComponent(leadPhone)}&leadName=${encodeURIComponent(leadName || 'the company')}`,
      statusCallback: `${baseUrl}/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed']
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Call error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. TwiML: connect my cell to the lead ──
app.post('/twiml/connect', (req, res) => {
  const { leadPhone, leadName } = req.query;
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, `Connecting you to ${leadName}.`);
  const dial = twiml.dial({ callerId: TWILIO_NUM, timeout: 30 });
  dial.number(leadPhone);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 3. Voicemail drop ──
app.post('/voicemail', async (req, res) => {
  const { leadPhone, vmMessage } = req.body;
  if (!leadPhone) return res.status(400).json({ error: 'leadPhone required' });
  const message = vmMessage || "Hi, this is Edwards Carriers calling about heavy equipment transportation. We move equipment nationwide and are heading to your area soon. If you have any equipment that needs to be relocated, please give us a call back. Thank you.";
  try {
    const call = await client.calls.create({
      to: leadPhone,
      from: TWILIO_NUM,
      url: `https://${req.get('host')}/twiml/voicemail?msg=${encodeURIComponent(message)}`
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Voicemail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. TwiML: play voicemail message ──
app.post('/twiml/voicemail', (req, res) => {
  const msg = req.query.msg || "Please call us back regarding heavy equipment transport.";
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', rate: '90%' }, msg);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 5. Incoming call forwarding ──
app.post('/incoming', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Please hold while we connect your call.');
  const dial = twiml.dial({ timeout: 20 });
  dial.number(MY_CELL);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 6. Phone number lookup (mobile vs landline) ──
// POST /lookup  { phones: ["+15551234567", ...] }
// Returns { results: { "+15551234567": "mobile", ... } }
app.post('/lookup', async (req, res) => {
  const { phones } = req.body;
  if (!phones || !phones.length) return res.status(400).json({ error: 'phones array required' });

  const results = {};
  for (const phone of phones) {
    try {
      const lookup = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
      const lineType = lookup.lineTypeIntelligence && lookup.lineTypeIntelligence.type
        ? lookup.lineTypeIntelligence.type
        : 'unknown';
      // Normalize to mobile / landline / voip / unknown
      if (lineType === 'mobile' || lineType === 'personal') results[phone] = 'Mobile';
      else if (lineType === 'landline' || lineType === 'fixedVoip') results[phone] = 'Landline';
      else if (lineType === 'voip' || lineType === 'nonFixedVoip') results[phone] = 'VoIP';
      else results[phone] = 'Unknown';
    } catch (err) {
      console.error('Lookup error for', phone, ':', err.message);
      results[phone] = 'Unknown';
    }
  }
  res.json({ success: true, results });
});

// ── 7. Call status log ──
app.post('/call-status', (req, res) => {
  console.log('Call status:', req.body.CallStatus, '| SID:', req.body.CallSid, '| To:', req.body.To);
  res.sendStatus(200);
});

// ── 8. Apify search — Google Maps Scraper (compass/crawler-google-places) ──
// Runs one Apify actor run per keyword in parallel, polls until done, merges results.
//
// POST /search  { keyword: "heavy equipment rental", city: "Dallas, TX" }
// POST /search  { keywords: [...], city: "Dallas, TX" }
// Returns { results: [{ name, address, phone, website, mapsUrl }] }

const APIFY_BASE  = 'https://api.apify.com/v2';
const APIFY_ACTOR = 'compass~crawler-google-places';

// Trigger one Apify actor run for one keyword+city, return runId
async function apifyTrigger(apiKey, keyword, city, limit) {
  const searchQuery = `${keyword} near ${city}`;
  const r = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      searchStringsArray: [searchQuery],
      maxCrawledPlacesPerSearch: limit,
      language: 'en',
      countryCode: 'us',
      includeHistogram: false,
      includeOpeningHours: false,
      includePeopleAlsoSearch: false,
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.data || !d.data.id) throw new Error(`Apify trigger failed for "${keyword}": ${JSON.stringify(d)}`);
  return d.data.id;
}

// Poll one run until succeeded, then fetch dataset items
async function apifyFetch(apiKey, runId, maxWaitMs = 180000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6000));
    const r = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${apiKey}`);
    const d = await r.json().catch(() => ({}));
    const status = d.data && d.data.status;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT')
      throw new Error(`Apify run ${runId} ended with status: ${status}`);
    if (status !== 'SUCCEEDED') continue;
    // Fetch dataset items
    const datasetId = d.data.defaultDatasetId;
    const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${apiKey}&format=json&clean=true`);
    return await itemsRes.json().catch(() => []);
  }
  throw new Error('Apify timed out waiting for results');
}

// Normalize an Apify Google Maps record to our standard shape
function normalizeResult(it, city) {
  return {
    name:    it.title || it.name || '',
    phone:   it.phone || it.phoneUnformatted || '',
    address: it.address || it.street || '',
    website: it.website || it.url || '',
    gcat:    (Array.isArray(it.categoryName) ? it.categoryName[0] : it.categoryName) || it.category || '',
    mapsUrl: it.url || `https://www.google.com/maps/search/${encodeURIComponent((it.title || '') + ' ' + city)}`,
    placeId: it.placeId || `apify_${Math.random().toString(36).slice(2)}`
  };
}

// POST /search  { keyword, city }           — single keyword (legacy)
// POST /search  { keywords: [...], city }   — multiple keywords in parallel
app.post('/search', async (req, res) => {
  const city = String(req.body.city || '').trim();
  const keywords = req.body.keywords
    ? (Array.isArray(req.body.keywords) ? req.body.keywords : [req.body.keywords])
    : (req.body.keyword ? [String(req.body.keyword)] : []);

  if (!city || !keywords.length) return res.status(400).json({ error: 'city and keyword(s) required' });

  const APIFY_KEY = process.env.APIFY_API_KEY;
  if (!APIFY_KEY) return res.status(500).json({ error: 'APIFY_API_KEY not set on server' });

  const limit = Math.min(Math.max(Number(req.body.limit) || 20, 1), 100);

  try {
    console.log(`/search: ${keywords.length} keywords near ${city}, limit ${limit} each`);

    // Trigger ALL keywords in parallel
    const runIds = await Promise.all(
      keywords.map(kw => apifyTrigger(APIFY_KEY, kw, city, limit).catch(e => { console.error(e.message); return null; }))
    );
    console.log(`Triggered ${runIds.filter(Boolean).length}/${keywords.length} Apify runs`);

    // Fetch ALL runs in parallel (each polls independently)
    const allItems = await Promise.all(
      runIds.map((rid, i) => rid
        ? apifyFetch(APIFY_KEY, rid).catch(e => { console.error(`Fetch error for "${keywords[i]}":`, e.message); return []; })
        : Promise.resolve([])
      )
    );

    // Merge, deduplicate by name
    const seenNames = new Set();
    const results = [];
    allItems.forEach(items => {
      (Array.isArray(items) ? items : [])
        .filter(it => it.title || it.name)
        .forEach(it => {
          const norm = normalizeResult(it, city);
          if (!norm.name) return;
          const key = norm.name.toLowerCase().replace(/\s+/g, '');
          if (seenNames.has(key)) return;
          seenNames.add(key);
          results.push(norm);
        });
    });

    console.log(`/search complete: ${results.length} unique results from ${keywords.length} keywords in ${city}`);
    res.json({ success: true, results, count: results.length });

  } catch (err) {
    console.error('Apify search error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dialer server running on port ${PORT}`));
