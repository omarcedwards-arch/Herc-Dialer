const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

// ── Credentials (set these as environment variables in Railway) ──
const ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUM   = process.env.TWILIO_PHONE_NUMBER;  // e.g. +12676828480
const MY_CELL      = process.env.MY_PHONE_NUMBER;       // e.g. +12159304665

const client = twilio(ACCOUNT_SID, AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

// Health check
app.get('/', (req, res) => res.json({ status: 'Dialer server running' }));

// ── 1. Initiate a call ──
// POST /call  { leadPhone, leadName }
// Twilio calls MY_CELL first. When I answer, it connects to leadPhone.
app.post('/call', async (req, res) => {
  const { leadPhone, leadName } = req.body;
  if (!leadPhone) return res.status(400).json({ error: 'leadPhone required' });

  try {
    const call = await client.calls.create({
      to:  MY_CELL,
      from: TWILIO_NUM,
      url: `${req.protocol}://${req.get('host')}/twiml/connect?leadPhone=${encodeURIComponent(leadPhone)}&leadName=${encodeURIComponent(leadName || 'the company')}`,
      statusCallback: `${req.protocol}://${req.get('host')}/call-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'no-answer', 'busy', 'failed']
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Call error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. TwiML: what happens when I pick up ──
// Twilio hits this URL after I answer — it then dials the lead
app.post('/twiml/connect', (req, res) => {
  const { leadPhone, leadName } = req.query;
  const twiml = new VoiceResponse();

  twiml.say({ voice: 'alice' }, `Connecting you to ${leadName}.`);

  const dial = twiml.dial({ callerId: TWILIO_NUM, timeout: 30 });
  dial.number(leadPhone);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 3. TwiML: voicemail drop ──
// POST /voicemail  { leadPhone, vmMessage }
app.post('/voicemail', async (req, res) => {
  const { leadPhone, vmMessage } = req.body;
  if (!leadPhone) return res.status(400).json({ error: 'leadPhone required' });

  const message = vmMessage || "Hi, this is a message regarding heavy equipment transport. Please give us a call back at your earliest convenience. Thank you.";

  try {
    const call = await client.calls.create({
      to: leadPhone,
      from: TWILIO_NUM,
      url: `${req.protocol}://${req.get('host')}/twiml/voicemail?msg=${encodeURIComponent(message)}`
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Voicemail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. TwiML: voicemail message ──
app.post('/twiml/voicemail', (req, res) => {
  const msg = req.query.msg || "Please call us back regarding heavy equipment transport.";
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', rate: '90%' }, msg);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 5. Call status webhook ──
app.post('/call-status', (req, res) => {
  console.log('Call status:', req.body.CallStatus, 'SID:', req.body.CallSid);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dialer server running on port ${PORT}`));
