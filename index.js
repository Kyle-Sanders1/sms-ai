require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const KYLE_PHONE         = process.env.KYLE_PHONE;
const ROOF_NUMBER        = process.env.ROOF_NUMBER;
const LIGHTS_NUMBER      = process.env.LIGHTS_NUMBER;
const AUTO_SEND_SECONDS  = parseInt(process.env.AUTO_SEND_SECONDS || '60');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// DB
const DB_PATH = path.join(__dirname, 'db.json');
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { customers: {}, pendingReplies: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// AI
async function getAISuggestion(customerPhone, messageBody, businessLine, db) {
  const customer = db.customers[customerPhone];
  const history  = customer ? customer.messages.slice(-6) : [];
  const isNew    = !customer || customer.messages.length <= 1;
  const historyText = history.map(m => `${m.direction === 'in' ? 'Customer' : 'Kyle'}: ${m.body}`).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: `You are an AI assistant for Kyle who owns:
1. Roof Revival LLC - roofing (free inspections, replacements, repairs, estimates in FL)
2. Christmas Lights Installers - holiday lighting install/removal

Business line texted: ${businessLine}
${isNew ? 'NEW customer - no prior history.' : `Existing customer. Recent history:\n${historyText}`}

Customer just said: "${messageBody || '[sent media]'}"

Draft a warm professional 1-2 sentence reply as Kyle. For roofing: offer free inspection, ask for address. For lights: ask install date needed and home size. End with a question. Never mention AI.

Respond ONLY with JSON (no markdown): {"intent":"new_inquiry|appointment_request|quote_request|existing_followup|complaint|other","suggestedReply":"text here","priority":"high|normal|low"}` }]
    });
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { intent: 'other', suggestedReply: 'Hi! Thanks for reaching out. How can I help you today?', priority: 'normal' };
  }
}

// SSE
const sseClients = new Set();
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// Pending timers
const pendingTimers = {};
function schedulePendingSend(pendingId) {
  if (pendingTimers[pendingId]) clearTimeout(pendingTimers[pendingId]);
  pendingTimers[pendingId] = setTimeout(async () => {
    const db = loadDB();
    const pending = db.pendingReplies[pendingId];
    if (!pending) return;
    await sendToCustomer(pending.customerPhone, pending.fromNumber, pending.suggestedReply, db);
    delete db.pendingReplies[pendingId];
    saveDB(db);
    broadcastSSE({ type: 'auto_sent', pendingId });
    delete pendingTimers[pendingId];
  }, AUTO_SEND_SECONDS * 1000);
}

async function sendToCustomer(customerPhone, fromNumber, body, db, mediaUrl) {
  const params = { body: body || ' ', from: fromNumber, to: customerPhone };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  await twilioClient.messages.create(params);
  if (db.customers[customerPhone]) {
    db.customers[customerPhone].messages.push({
      direction: 'out', body: body || '', mediaUrl: mediaUrl || null,
      timestamp: new Date().toISOString(), read: true
    });
    db.customers[customerPhone].lastContact = new Date().toISOString();
    saveDB(db);
  }
}

// Inbound webhook
app.post('/webhook/inbound', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());
  try {
    const fromPhone = req.body.From;
    const toNumber  = req.body.To;
    const body      = req.body.Body || '';
    const numMedia  = parseInt(req.body.NumMedia || '0');
    const mediaUrl  = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 : null;

    const isRoof = toNumber === ROOF_NUMBER;
    const businessLine = isRoof ? '🏠 ROOF (352)' : '💡 LIGHTS (321)';
    const fromNumberLabel = isRoof ? ROOF_NUMBER : LIGHTS_NUMBER;

    const db = loadDB();
    if (!db.customers[fromPhone]) {
      db.customers[fromPhone] = { phone: fromPhone, name: null, line: businessLine,
        firstContact: new Date().toISOString(), lastContact: new Date().toISOString(), messages: [] };
    }
    db.customers[fromPhone].messages.push({
      direction: 'in', body, mediaUrl: mediaUrl || null, mediaType: mediaType || null,
      timestamp: new Date().toISOString(), read: false
    });
    db.customers[fromPhone].lastContact = new Date().toISOString();
    saveDB(db);

    // Get AI suggestion — never crash the webhook if AI fails
    let ai = { intent: 'other', suggestedReply: 'Hi! Thanks for reaching out. How can I help you today?', priority: 'normal' };
    try { ai = await getAISuggestion(fromPhone, body, businessLine, db); } catch(e) { console.error('AI error:', e.message); }

    const pendingId = `${fromPhone.replace(/\D/g,'')}-${Date.now()}`;
    const freshDB = loadDB();
    freshDB.pendingReplies[pendingId] = {
      pendingId, customerPhone: fromPhone, fromNumber: fromNumberLabel,
      suggestedReply: ai.suggestedReply, intent: ai.intent, priority: ai.priority,
      customerName: freshDB.customers[fromPhone]?.name || null,
      incomingMessage: body, incomingMedia: mediaUrl || null,
      createdAt: new Date().toISOString(),
      autoSendAt: new Date(Date.now() + AUTO_SEND_SECONDS * 1000).toISOString()
    };
    saveDB(freshDB);

    broadcastSSE({
      type: 'new_message', pendingId,
      customerPhone: fromPhone, customerName: freshDB.customers[fromPhone]?.name,
      businessLine, message: body, mediaUrl, suggestedReply: ai.suggestedReply,
      intent: ai.intent, priority: ai.priority,
      autoSendAt: freshDB.pendingReplies[pendingId].autoSendAt
    });
    schedulePendingSend(pendingId);
  } catch (err) { console.error('Inbound error:', err); }
});

// ── Voice call forwarding ────────────────────────────────────────────────────
app.post('/webhook/voice', (req, res) => {
  const toNumber = req.body.To;
  const isRoof = toNumber === ROOF_NUMBER;
  const businessName = isRoof ? 'Roof Revival LLC' : 'Christmas Lights Installers';
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({
    timeout: 20,
    action: '/webhook/voice-fallback?business=' + encodeURIComponent(businessName),
    method: 'POST',
    callerId: toNumber
  });
  dial.number(KYLE_PHONE);
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/voice-fallback', (req, res) => {
  const business = req.query.business || 'our company';
  const dialStatus = req.body.DialCallStatus;
  const twiml = new twilio.twiml.VoiceResponse();
  if (dialStatus === 'completed') { res.type('text/xml').send(twiml.toString()); return; }
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    'Thank you for calling ' + business + '. We are sorry we missed your call. Please leave your name and number and we will get back to you shortly. You can also text this number for a faster response.');
  twiml.record({ maxLength: 60, transcribe: true, transcribeCallback: '/webhook/voicemail-transcription', playBeep: true, action: '/webhook/voicemail-done' });
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/voicemail-done', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for your message. We look forward to speaking with you soon. Goodbye!');
  res.type('text/xml').send(twiml.toString());
});

app.post('/webhook/voicemail-transcription', async (req, res) => {
  try {
    const transcription = req.body.TranscriptionText;
    const from = req.body.From;
    const recordingUrl = req.body.RecordingUrl;
    const db = loadDB();
    if (!db.customers[from]) {
      db.customers[from] = { phone: from, name: null, line: 'Unknown', firstContact: new Date().toISOString(), lastContact: new Date().toISOString(), messages: [] };
    }
    const vmText = '📞 VOICEMAIL: "' + (transcription || '(no transcription)') + '"';
    db.customers[from].messages.push({ direction: 'in', body: vmText, mediaUrl: recordingUrl || null, timestamp: new Date().toISOString(), read: false, isVoicemail: true });
    db.customers[from].lastContact = new Date().toISOString();
    saveDB(db);
    broadcastSSE({ type: 'new_message', customerPhone: from, message: vmText, isVoicemail: true });
  } catch(e) { console.error('Voicemail error:', e); }
  res.sendStatus(200);
});

// API routes
app.get('/api/data', (req, res) => {
  const db = loadDB();
  res.json({ customers: Object.values(db.customers).sort((a,b) => new Date(b.lastContact)-new Date(a.lastContact)), pendingReplies: db.pendingReplies });
});

app.post('/api/send', async (req, res) => {
  try {
    const { customerPhone, body, pendingId, mediaUrl } = req.body;
    const db = loadDB();
    const customer = db.customers[customerPhone];
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const fromNumber = customer.line.includes('ROOF') ? ROOF_NUMBER : LIGHTS_NUMBER;
    if (pendingId && pendingTimers[pendingId]) { clearTimeout(pendingTimers[pendingId]); delete pendingTimers[pendingId]; }
    await sendToCustomer(customerPhone, fromNumber, body, db, mediaUrl || null);
    const db2 = loadDB();
    if (pendingId && db2.pendingReplies[pendingId]) { delete db2.pendingReplies[pendingId]; saveDB(db2); }
    const db3 = loadDB();
    if (db3.customers[customerPhone]) { db3.customers[customerPhone].messages.forEach(m => { if(m.direction==='in') m.read=true; }); saveDB(db3); }
    broadcastSSE({ type: 'reply_sent', customerPhone, pendingId });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post('/api/dismiss', (req, res) => {
  const { pendingId } = req.body;
  if (pendingTimers[pendingId]) { clearTimeout(pendingTimers[pendingId]); delete pendingTimers[pendingId]; }
  const db = loadDB();
  delete db.pendingReplies[pendingId];
  saveDB(db);
  broadcastSSE({ type: 'dismissed', pendingId });
  res.json({ ok: true });
});

app.post('/api/customer/:phone/name', (req, res) => {
  const db = loadDB();
  const phone = decodeURIComponent(req.params.phone);
  if (db.customers[phone]) { db.customers[phone].name = req.body.name; saveDB(db); }
  res.json({ ok: true });
});

app.post('/api/customer/:phone/read', (req, res) => {
  const db = loadDB();
  const phone = decodeURIComponent(req.params.phone);
  if (db.customers[phone]) { db.customers[phone].messages.forEach(m => { m.read = true; }); saveDB(db); }
  res.json({ ok: true });
});

// PWA files
app.get('/manifest.json', (req, res) => res.json({
  name: 'Roof Revival SMS', short_name: 'SMS Hub',
  start_url: '/', display: 'standalone',
  background_color: '#0f0f23', theme_color: '#6c63ff',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
}));

app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0f0f23"/><text y=".9em" font-size="80" x="10">🏠</text></svg>');
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`const CACHE='sms-v2';
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/']))));
self.addEventListener('fetch',e=>{if(e.request.url.includes('/api/')||e.request.url.includes('/webhook/'))return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));});
self.addEventListener('push',e=>{const d=e.data?e.data.json():{};e.waitUntil(self.registration.showNotification(d.title||'New SMS',{body:d.body||'New message',icon:'/icon.svg',tag:d.tag||'sms',data:{url:d.url||'/'},actions:[{action:'view',title:'View'}]}));});
self.addEventListener('notificationclick',e=>{e.notification.close();const url=e.notification.data?.url||'/';e.waitUntil(clients.matchAll({type:'window'}).then(cs=>{for(const c of cs){if('focus'in c)return c.focus();}if(clients.openWindow)return clients.openWindow(url);}));});`);
});

// Main app HTML - served from a separate file for cleanliness
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(getHTML());
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SMS Hub">
<meta name="theme-color" content="#0f0f23">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<title>SMS Hub</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#0f0f23;--surf:#1a1a35;--surf2:#252545;--bdr:#2e2e55;--acc:#6c63ff;--acc2:#ff6584;--grn:#00d4aa;--yel:#ffd166;--red:#ef476f;--txt:#e8e8ff;--mut:#8888aa;--wht:#ffffff}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;height:100dvh;display:flex;flex-direction:column;overflow:hidden}
.hdr{background:var(--surf);border-bottom:1px solid var(--bdr);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;padding-top:max(12px,env(safe-area-inset-top))}
.hdr-title{font-size:17px;font-weight:700;color:var(--wht)}
.hdr-sub{font-size:11px;color:var(--mut);margin-top:1px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--red);transition:background .3s}
.dot.live{background:var(--grn)}
.view{display:none;flex:1;flex-direction:column;overflow:hidden}
.view.on{display:flex}
.stats{display:flex;gap:8px;padding:12px 16px 8px;flex-shrink:0}
.stat{flex:1;background:var(--surf);border-radius:12px;padding:10px;text-align:center;border:1px solid var(--bdr)}
.snum{font-size:22px;font-weight:800;color:var(--acc)}
.slbl{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.nbanner{margin:0 16px 8px;background:var(--surf2);border:1px solid var(--acc);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-size:13px}
.nbanner.gone{display:none}
.nenable{background:var(--acc);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer}
.psec{flex-shrink:0;max-height:45vh;overflow-y:auto;padding:0 16px}
.pcard{background:var(--surf);border:1px solid var(--acc2);border-radius:14px;padding:14px;margin-bottom:8px;animation:sli .3s ease}
@keyframes sli{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.pname{font-size:15px;font-weight:700;color:var(--wht)}
.pline{font-size:11px;color:var(--mut);margin-top:1px}
.ptimer{font-size:13px;color:var(--mut);font-variant-numeric:tabular-nums}
.pmsg{font-size:13px;color:var(--txt);background:var(--surf2);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.pimg{max-width:100%;border-radius:8px;margin-bottom:8px;display:block}
.slbl2{font-size:11px;color:var(--acc);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.stxt{font-size:13px;color:var(--txt);background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.5}
.tbar{height:3px;background:var(--bdr);border-radius:2px;margin-bottom:10px;overflow:hidden}
.tfill{height:100%;background:var(--acc2);border-radius:2px;transition:width 1s linear}
.pbtns{display:flex;gap:8px;margin-bottom:8px}
.bsend{flex:1;background:var(--grn);color:#000;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.bedit{flex:1;background:var(--acc);color:#fff;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.bdismiss{flex:0;background:var(--surf2);color:var(--mut);border:1px solid var(--bdr);border-radius:10px;padding:10px 14px;font-size:14px;cursor:pointer}
.cr{display:none;flex-direction:column;gap:8px}
.cr.on{display:flex}
.ci{background:var(--surf2);border:1px solid var(--bdr);border-radius:10px;padding:10px;color:var(--txt);font-size:14px;resize:none;min-height:70px;font-family:inherit}
.ci:focus{outline:none;border-color:var(--acc)}
.bcsend{background:var(--acc);color:#fff;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.clist{flex:1;overflow-y:auto;padding:0 16px 16px}
.crow{display:flex;align-items:center;gap:12px;padding:12px;background:var(--surf);border-radius:12px;margin-bottom:8px;cursor:pointer;border:1px solid var(--bdr);transition:background .15s}
.crow:active{background:var(--surf2)}
.cav{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.avr{background:rgba(108,99,255,.2)}
.avl{background:rgba(255,209,102,.2)}
.ci2{flex:1;min-width:0}
.cname{font-size:15px;font-weight:600;color:var(--wht);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cprev{font-size:13px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.cmeta{text-align:right;flex-shrink:0}
.ctime{font-size:11px;color:var(--mut)}
.ubadge{display:inline-block;background:var(--red);color:#fff;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700;margin-top:4px}
.chdr{background:var(--surf);border-bottom:1px solid var(--bdr);padding:12px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.bback{background:none;border:none;color:var(--acc);font-size:22px;cursor:pointer;padding:4px;line-height:1}
.chdr-info{flex:1;min-width:0}
.chn{font-size:16px;font-weight:700;color:var(--wht);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chl{font-size:12px;color:var(--mut)}
.ename{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;padding:5px 8px;color:var(--txt);font-size:13px;width:100px;flex-shrink:0}
.ename:focus{outline:none;border-color:var(--acc)}
.bsname{background:var(--acc);color:#fff;border:none;border-radius:8px;padding:5px 10px;font-size:13px;cursor:pointer;flex-shrink:0;white-space:nowrap}
.msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.bw{display:flex;flex-direction:column}
.bw.out{align-items:flex-end}
.bbl{max-width:80%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.5;word-break:break-word}
.bw.in .bbl{background:var(--surf);border-bottom-left-radius:4px}
.bw.out .bbl{background:var(--acc);color:#fff;border-bottom-right-radius:4px}
.bbl img{max-width:200px;border-radius:10px;display:block;cursor:pointer}
.bbl video{max-width:200px;border-radius:10px;display:block}
.bt{font-size:10px;color:var(--mut);margin-top:3px;padding:0 4px}
.rbox{background:var(--surf);border-top:1px solid var(--bdr);padding:10px 16px;flex-shrink:0;padding-bottom:max(10px,env(safe-area-inset-bottom))}
.rrow{display:flex;gap:8px;align-items:flex-end}
.rta{flex:1;background:var(--surf2);border:1px solid var(--bdr);border-radius:20px;padding:10px 14px;color:var(--txt);font-size:14px;resize:none;min-height:42px;max-height:120px;font-family:inherit}
.rta:focus{outline:none;border-color:var(--acc)}
.mbtn{background:var(--surf2);border:1px solid var(--bdr);border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;flex-shrink:0}
.sbtn{background:var(--acc);border:none;border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;color:#fff;font-size:18px}
.mprev{margin-bottom:8px;position:relative;display:none}
.mprev.on{display:block}
.mprev img,.mprev video{max-height:100px;border-radius:10px}
.rmedia{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center}
.hfile{display:none}
.bnav{background:var(--surf);border-top:1px solid var(--bdr);display:flex;flex-shrink:0;padding-bottom:max(0px,env(safe-area-inset-bottom))}
.navb{flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 0;cursor:pointer;border:none;background:none;color:var(--mut);font-size:20px;position:relative}
.navb.on{color:var(--acc)}
.nlbl{font-size:10px;margin-top:2px}
.nbdg{position:absolute;top:6px;right:calc(50% - 16px);background:var(--red);color:#fff;border-radius:999px;padding:1px 5px;font-size:10px;font-weight:700}
.empty{text-align:center;padding:60px 20px;color:var(--mut)}
.empty-ic{font-size:48px;margin-bottom:12px}
.toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surf2);border:1px solid var(--bdr);border-radius:10px;padding:10px 20px;font-size:14px;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none;white-space:nowrap}
.toast.on{opacity:1}
.install-banner{margin:0 16px 8px;background:var(--surf2);border:1px solid var(--grn);border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-size:13px}
.install-banner.gone{display:none}
.ibtn{background:var(--grn);color:#000;border:none;border-radius:8px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<div class="hdr">
  <div>
    <div class="hdr-title">📱 SMS Hub</div>
    <div class="hdr-sub" id="hsub">Roof Revival &amp; Lights</div>
  </div>
  <div class="dot" id="dot"></div>
</div>

<!-- INBOX -->
<div class="view on" id="vInbox">
  <div class="stats" id="stats"></div>
  <div class="install-banner gone" id="installBanner">
    <span>📲 Add to home screen</span>
    <button class="ibtn" id="installBtn" onclick="doInstall()">Install App</button>
  </div>
  <div class="nbanner gone" id="nBanner">
    <span>🔔 Enable push notifications</span>
    <button class="nenable" onclick="askNotif()">Enable</button>
  </div>
  <div class="psec" id="psec"></div>
  <div class="clist" id="clist">
    <div class="empty"><div class="empty-ic">💬</div><div>No messages yet</div></div>
  </div>
</div>

<!-- CONVERSATION -->
<div class="view" id="vConv">
  <div class="chdr">
    <button class="bback" onclick="goBack()">‹</button>
    <div class="chdr-info">
      <div class="chn" id="chn">Customer</div>
      <div class="chl" id="chl"></div>
    </div>
    <input class="ename" id="ename" placeholder="Name…" onkeydown="if(event.key==='Enter')saveName()">
    <button class="bsname" onclick="saveName()">Save</button>
  </div>
  <div class="msgs" id="msgs"></div>
  <div class="rbox">
    <div class="mprev" id="mprev">
      <img id="mpimg" src="" style="display:none">
      <video id="mpvid" src="" style="display:none" controls></video>
      <button class="rmedia" onclick="clearMedia()">✕</button>
    </div>
    <div class="rrow">
      <label class="mbtn">📎<input type="file" class="hfile" id="fInput" accept="image/*,video/*,image/gif" onchange="onFile(this)"></label>
      <textarea class="rta" id="rta" placeholder="Message…" rows="1" oninput="ar(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();doSend()}"></textarea>
      <button class="sbtn" onclick="doSend()">➤</button>
    </div>
  </div>
</div>

<div class="bnav">
  <button class="navb on" id="nb1" onclick="goBack()">💬<span class="nlbl">Inbox</span><span class="nbdg" id="pbdg" style="display:none"></span></button>
  <button class="navb" id="nb2">👥<span class="nlbl">Customers</span></button>
</div>
<div class="toast" id="toast"></div>

<script>
const AUTO_SEC=${AUTO_SEND_SECONDS};
let curPhone=null,data={customers:[],pendingReplies:{}},mediaB64=null,mediaType=null,es=null;
let deferredPrompt=null;

window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;document.getElementById('installBanner').classList.remove('gone');});
window.addEventListener('appinstalled',()=>document.getElementById('installBanner').classList.add('gone'));
function doInstall(){if(deferredPrompt){deferredPrompt.prompt();deferredPrompt.userChoice.then(()=>{deferredPrompt=null;document.getElementById('installBanner').classList.add('gone');});}}

if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(console.error);

async function boot(){await pull();render();sse();checkNotif();}

async function pull(){
  try{const r=await fetch('/api/data');const d=await r.json();data.customers=d.customers;data.pendingReplies=d.pendingReplies;}catch(e){console.error(e);}
}

function sse(){
  if(es)es.close();
  es=new EventSource('/api/events');
  es.onopen=()=>document.getElementById('dot').classList.add('live');
  es.onerror=()=>{document.getElementById('dot').classList.remove('live');setTimeout(sse,5000);};
  es.onmessage=async(e)=>{
    const d=JSON.parse(e.data);
    await pull();render();
    if(curPhone)renderConv(curPhone);
    if(d.type==='new_message'){toast('New: '+(d.customerName||d.customerPhone));notif(d);}
    if(d.type==='auto_sent')toast('Auto-sent reply');
  };
}

function render(){renderStats();renderPending();renderList();}

function renderStats(){
  const r=data.customers.filter(c=>c.line?.includes('ROOF')).length;
  const l=data.customers.filter(c=>c.line?.includes('LIGHTS')).length;
  const p=Object.keys(data.pendingReplies).length;
  document.getElementById('stats').innerHTML=
    '<div class="stat"><div class="snum">'+data.customers.length+'</div><div class="slbl">Total</div></div>'+
    '<div class="stat"><div class="snum">'+r+'</div><div class="slbl">🏠 Roof</div></div>'+
    '<div class="stat"><div class="snum">'+l+'</div><div class="slbl">💡 Lights</div></div>'+
    '<div class="stat"><div class="snum" style="color:var(--acc2)">'+p+'</div><div class="slbl">Pending</div></div>';
  const b=document.getElementById('pbdg');
  if(p>0){b.textContent=p;b.style.display='block';}else b.style.display='none';
}

const timers={};
function renderPending(){
  const sec=document.getElementById('psec');
  const ps=Object.values(data.pendingReplies).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  if(!ps.length){sec.innerHTML='';return;}
  sec.innerHTML=ps.map(p=>{
    const nm=esc(p.customerName||p.customerPhone);
    const ln=p.fromNumber===ROOF_NUMBER?'🏠 Roof':'💡 Lights';
    const at=new Date(p.autoSendAt).getTime();
    const sl=Math.max(0,Math.round((at-Date.now())/1000));
    const pct=Math.min(100,((AUTO_SEC-sl)/AUTO_SEC)*100);
    const mi=p.incomingMedia?'<img class="pimg" src="'+p.incomingMedia+'">':'';
    return '<div class="pcard" id="pc-'+p.pendingId+'">'+
      '<div class="ph"><div><div class="pname">'+nm+'</div><div class="pline">'+ln+'</div></div>'+
      '<div class="ptimer" id="pt-'+p.pendingId+'">'+sl+'s</div></div>'+
      mi+
      '<div class="pmsg">'+esc(p.incomingMessage||'(media)')+'</div>'+
      '<div class="slbl2">✨ AI Suggested Reply</div>'+
      '<div class="stxt" id="st-'+p.pendingId+'">'+esc(p.suggestedReply)+'</div>'+
      '<div class="tbar"><div class="tfill" id="tf-'+p.pendingId+'" style="width:'+pct+'%"></div></div>'+
      '<div class="pbtns">'+
        '<button class="bsend" onclick="sendSugg(\''+p.pendingId+'\',\''+p.customerPhone+'\')">✓ Send</button>'+
        '<button class="bedit" onclick="toggleEdit(\''+p.pendingId+'\')">✏️ Edit</button>'+
        '<button class="bdismiss" onclick="dismiss(\''+p.pendingId+'\')">✕</button>'+
      '</div>'+
      '<div class="cr" id="cr-'+p.pendingId+'">'+
        '<textarea class="ci" id="ci-'+p.pendingId+'">'+esc(p.suggestedReply)+'</textarea>'+
        '<button class="bcsend" onclick="sendCustom(\''+p.pendingId+'\',\''+p.customerPhone+'\')">Send My Reply</button>'+
      '</div></div>';
  }).join('');
  ps.forEach(p=>startTimer(p));
}

function startTimer(p){
  if(timers[p.pendingId])clearInterval(timers[p.pendingId]);
  const at=new Date(p.autoSendAt).getTime();
  timers[p.pendingId]=setInterval(()=>{
    const sl=Math.max(0,Math.round((at-Date.now())/1000));
    const pct=Math.min(100,((AUTO_SEC-sl)/AUTO_SEC)*100);
    const te=document.getElementById('pt-'+p.pendingId);
    const fe=document.getElementById('tf-'+p.pendingId);
    if(te)te.textContent=sl+'s';
    if(fe)fe.style.width=pct+'%';
    if(sl<=0)clearInterval(timers[p.pendingId]);
  },1000);
}

function renderList(){
  const el=document.getElementById('clist');
  if(!data.customers.length){el.innerHTML='<div class="empty"><div class="empty-ic">💬</div><div>No messages yet</div></div>';return;}
  el.innerHTML=data.customers.map(c=>{
    const last=c.messages?.[c.messages.length-1];
    const unread=c.messages?.filter(m=>m.direction==='in'&&!m.read).length||0;
    const isR=c.line?.includes('ROOF');
    const prev=last?(last.body||(last.mediaUrl?'📎 Media':'')):'';
    const nm=esc(c.name||c.phone);
    return '<div class="crow" onclick="openConv(\''+c.phone+'\')">'+
      '<div class="cav '+(isR?'avr':'avl')+'">'+(isR?'🏠':'💡')+'</div>'+
      '<div class="ci2"><div class="cname">'+nm+'</div><div class="cprev">'+esc(prev)+'</div></div>'+
      '<div class="cmeta"><div class="ctime">'+ft(last?.timestamp)+'</div>'+(unread>0?'<div class="ubadge">'+unread+'</div>':'')+'</div>'+
    '</div>';
  }).join('');
}

async function openConv(phone){
  curPhone=phone;
  const c=data.customers.find(x=>x.phone===phone);
  if(!c)return;
  document.getElementById('chn').textContent=c.name||c.phone;
  document.getElementById('chl').textContent=c.line;
  document.getElementById('ename').value=c.name||'';
  document.getElementById('vInbox').classList.remove('on');
  document.getElementById('vConv').classList.add('on');
  renderConv(phone);
  await fetch('/api/customer/'+encodeURIComponent(phone)+'/read',{method:'POST'});
  await pull();render();
}

function renderConv(phone){
  const c=data.customers.find(x=>x.phone===phone);
  if(!c)return;
  const el=document.getElementById('msgs');
  el.innerHTML=(c.messages||[]).map(m=>{
    let cont='';
    if(m.mediaUrl&&m.mediaType?.startsWith('image'))cont='<img src="'+m.mediaUrl+'" onclick="window.open(this.src)">';
    else if(m.mediaUrl&&m.mediaType?.startsWith('video'))cont='<video src="'+m.mediaUrl+'" controls></video>';
    else if(m.body)cont=esc(m.body);
    return '<div class="bw '+m.direction+'"><div class="bbl">'+cont+'</div><div class="bt">'+ft(m.timestamp)+'</div></div>';
  }).join('');
  setTimeout(()=>{el.scrollTop=el.scrollHeight;},50);
}

function goBack(){
  curPhone=null;
  document.getElementById('vConv').classList.remove('on');
  document.getElementById('vInbox').classList.add('on');
  clearMedia();
}

async function saveName(){
  if(!curPhone)return;
  const nm=document.getElementById('ename').value.trim();
  await fetch('/api/customer/'+encodeURIComponent(curPhone)+'/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm})});
  document.getElementById('chn').textContent=nm||curPhone;
  await pull();render();toast('Saved');
}

async function doSend(){
  const txt=document.getElementById('rta').value.trim();
  if(!txt&&!mediaB64)return;
  if(!curPhone)return;
  const body={customerPhone:curPhone,body:txt};
  document.getElementById('rta').value='';
  document.getElementById('rta').style.height='auto';
  clearMedia();
  await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await pull();renderConv(curPhone);
}

async function sendSugg(pid,phone){
  const txt=document.getElementById('st-'+pid)?.textContent||'';
  if(timers[pid])clearInterval(timers[pid]);
  await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerPhone:phone,body:txt,pendingId:pid})});
  document.getElementById('pc-'+pid)?.remove();
  await pull();render();toast('Sent ✓');
}

function toggleEdit(pid){
  const cr=document.getElementById('cr-'+pid);
  cr.classList.toggle('on');
  if(cr.classList.contains('on')){if(timers[pid])clearInterval(timers[pid]);document.getElementById('ci-'+pid)?.focus();}
}

async function sendCustom(pid,phone){
  const txt=document.getElementById('ci-'+pid)?.value?.trim();
  if(!txt)return;
  await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerPhone:phone,body:txt,pendingId:pid})});
  document.getElementById('pc-'+pid)?.remove();
  await pull();render();toast('Sent ✓');
}

async function dismiss(pid){
  if(timers[pid])clearInterval(timers[pid]);
  await fetch('/api/dismiss',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pendingId:pid})});
  document.getElementById('pc-'+pid)?.remove();
  await pull();render();
}

function onFile(inp){
  const f=inp.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{
    mediaB64=e.target.result;mediaType=f.type;
    const pr=document.getElementById('mprev');pr.classList.add('on');
    const img=document.getElementById('mpimg');const vid=document.getElementById('mpvid');
    if(f.type.startsWith('image')){img.src=e.target.result;img.style.display='block';vid.style.display='none';}
    else{vid.src=e.target.result;vid.style.display='block';img.style.display='none';}
  };
  r.readAsDataURL(f);
}
function clearMedia(){mediaB64=null;mediaType=null;document.getElementById('mprev').classList.remove('on');document.getElementById('mpimg').src='';document.getElementById('mpvid').src='';document.getElementById('fInput').value='';}

function checkNotif(){const b=document.getElementById('nBanner');if(!('Notification'in window)||Notification.permission==='granted')b.classList.add('gone');}
async function askNotif(){const r=await Notification.requestPermission();if(r==='granted'){document.getElementById('nBanner').classList.add('gone');toast('Notifications on!');}}
function notif(d){if(Notification.permission!=='granted')return;const n=new Notification(d.businessLine||'New SMS',{body:(d.customerName||d.customerPhone)+': '+(d.message||'(media)'),icon:'/icon.svg',tag:d.customerPhone});n.onclick=()=>{window.focus();openConv(d.customerPhone);n.close();};}

function ft(ts){if(!ts)return'';const d=new Date(ts);const n=new Date();const t=d.toDateString()===n.toDateString();return t?d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString([],{month:'short',day:'numeric'});}
function esc(t){return(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function ar(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),2500);}
const ROOF_NUMBER='${ROOF_NUMBER}';

boot();
</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('SMS Hub on port ' + PORT));
