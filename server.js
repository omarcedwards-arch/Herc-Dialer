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
// Calls MY_CELL first, when answered connects to lead
app.post('/call', async (req, res) => {
  const { leadPhone, leadName } = req.body;
  if (!leadPhone) return res.status(400).json({ error: 'leadPhone required' });
  try {
    const host = req.get('host');
    const baseUrl = `https://${host}`;
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
    const host2 = req.get('host');
    const call = await client.calls.create({
      to: leadPhone,
      from: TWILIO_NUM,
      url: `https://${host2}/twiml/voicemail?msg=${encodeURIComponent(message)}`
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
// Set this URL as your Twilio number webhook so callbacks forward to your cell
app.post('/incoming', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Please hold while we connect your call.');
  const dial = twiml.dial({ timeout: 20 });
  dial.number(MY_CELL);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── 6. Call status log ──
app.post('/call-status', (req, res) => {
  console.log('Call status:', req.body.CallStatus, '| SID:', req.body.CallSid, '| To:', req.body.To);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dialer server running on port ${PORT}`));
