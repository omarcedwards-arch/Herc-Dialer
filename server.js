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

// ── 8. Bright Data search — Google Maps Dataset API ──
const DATASET_ID = 'gd_m8ebnr0q2qlklc02fz';
const BD_BASE    = 'https://api.brightdata.com/datasets/v3';

const CITY_COORDS = {
  'dallas tx': [32.7767, -96.797], 'fort worth tx': [32.7555, -97.3308],
  'houston tx': [29.7604, -95.3698], 'san antonio tx': [29.4241, -98.4936],
  'austin tx': [30.2672, -97.7431], 'midland tx': [31.9973, -102.0779],
  'odessa tx': [31.8457, -102.3676], 'el paso tx': [31.7619, -106.485],
  'corpus christi tx': [27.8006, -97.3964], 'beaumont tx': [30.0802, -94.1266],
  'oklahoma city ok': [35.4676, -97.5164], 'tulsa ok': [36.154, -95.9928],
  'shreveport la': [32.5252, -93.7502], 'baton rouge la': [30.4515, -91.1871],
  'new orleans la': [29.9511, -90.0715], 'lake charles la': [30.2266, -93.2174],
  'phoenix az': [33.4484, -112.074], 'denver co': [39.7392, -104.9903],
  'kansas city mo': [39.0997, -94.5786], 'memphis tn': [35.1495, -90.049],
  'nashville tn': [36.1627, -86.7816], 'atlanta ga': [33.749, -84.388],
  'birmingham al': [33.5186, -86.8104], 'charlotte nc': [35.2271, -80.8431],
  'chicago il': [41.8781, -87.6298], 'detroit mi': [42.3314, -83.0458],
  'pittsburgh pa': [40.4406, -79.9959], 'philadelphia pa': [39.9526, -75.1652],
  'los angeles ca': [34.0522, -118.2437], 'orlando fl': [28.5383, -81.3792],
  'tampa fl': [27.9506, -82.4572], 'jacksonville fl': [30.3322, -81.6557],
  'miami fl': [25.7617, -80.1918], 'avon park fl': [27.5964, -81.5059],
  'lake placid fl': [27.2939, -81.3637], 'okeechobee fl': [27.2436, -80.8298],
  'belle glade fl': [26.6845, -80.6687], 'pahokee fl': [26.8198, -80.6626],
};
const cityKey = s => String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const geocodeCache = {};
async function geocode(city) {
  const k = cityKey(city);
  if (CITY_COORDS[k]) return CITY_COORDS[k];
  if (geocodeCache[k]) return geocodeCache[k];
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(city)}`,
    { headers: { 'User-Agent': 'ECEquipmentLeads/1.0' } }
  );
  const d = await r.json().catch(() => []);
  if (!d[0]) throw new Error(`Couldn't find "${city}". Try "City ST", e.g. "Dallas TX".`);
  geocodeCache[k] = [Number(d[0].lat), Number(d[0].lon)];
  return geocodeCache[k];
}

app.post('/search', async (req, res) => {
  const { keyword, city } = req.body;
  if (!keyword || !city) return res.status(400).json({ error: 'keyword and city required' });

  const BD_API_KEY = process.env.BD_API_KEY || process.env.BRIGHTDATA_API_KEY;
  if (!BD_API_KEY) return res.status(500).json({ error: 'BD_API_KEY not set on server' });

  const limit = Math.min(Math.max(Number(req.body.limit) || 50, 1), 200);

  try {
    const [lat, lon] = await geocode(city);

    const triggerUrl = `${BD_BASE}/trigger?dataset_id=${DATASET_ID}&include_errors=true&type=discover_new&discover_by=location&limit_per_input=${limit}`;
    const triggerRes = await fetch(triggerUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BD_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ country: 'US', lat: String(lat), long: String(lon), zoom_level: '11', keyword }])
    });
    const triggerData = await triggerRes.json().catch(() => ({}));
    if (!triggerRes.ok || !triggerData.snapshot_id) {
      console.error('BD trigger failed:', JSON.stringify(triggerData));
      return res.status(502).json({ error: `Bright Data trigger failed: ${triggerData.message || triggerData.error || triggerRes.status}` });
    }
    const snapshotId = triggerData.snapshot_id;
    console.log(`BD snapshot started: ${snapshotId} | "${keyword}" near ${city} (${lat}, ${lon})`);

    const auth = { 'Authorization': `Bearer ${BD_API_KEY}` };
    let items = null;
    for (let attempt = 0; attempt < 18; attempt++) {
      await new Promise(r => setTimeout(r, 5000));
      const prog = await (await fetch(`${BD_BASE}/progress/${encodeURIComponent(snapshotId)}`, { headers: auth })).json().catch(() => ({}));
      console.log(`BD poll ${attempt + 1}: status=${prog.status}`);
      if (prog.status === 'failed') {
        return res.status(502).json({ error: `Bright Data job failed: ${prog.error || 'unknown'}`, results: [] });
      }
      if (prog.status !== 'ready') continue;

      const snapRes = await fetch(`${BD_BASE}/snapshot/${encodeURIComponent(snapshotId)}?format=json`, { headers: auth });
      if (snapRes.status === 202) continue;
      items = await snapRes.json().catch(() => []);
      break;
    }

    if (!items) return res.status(504).json({ error: 'Bright Data timed out. Try again in a minute.', results: [] });

    const results = (Array.isArray(items) ? items : [])
      .filter(it => !it.error && (it.name
