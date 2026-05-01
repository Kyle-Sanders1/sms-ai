require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const KYLE_PHONE         = process.env.KYLE_PHONE; // +13527381825
const ROOF_NUMBER        = process.env.ROOF_NUMBER;   // +13527178774
const LIGHTS_NUMBER      = process.env.LIGHTS_NUMBER; // +13214789627
const AUTO_SEND_SECONDS  = parseInt(process.env.AUTO_SEND_SECONDS || '60');

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic    = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── DB (JSON file) ───────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'db.json');
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const empty = { customers: {}, pendingReplies: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── AI: classify + suggest ───────────────────────────────────────────────────
async function getAISuggestion(customerPhone, messageBody, businessLine, db) {
  const customer = db.customers[customerPhone];
  const history  = customer ? customer.messages.slice(-6) : [];
  const isNew    = !customer;

  const historyText = history.map(m =>
    `${m.direction === 'in' ? 'Customer' : 'Kyle'}: ${m.body}`
  ).join('\n');

  const systemPrompt = `You are an AI assistant helping Kyle, who owns two businesses:
1. Roof Revival LLC - roofing company (inspections, replacements, repairs, free estimates)
2. Christmas Lights Installers - holiday lighting installation/removal service

The customer texted the ${businessLine} line.
${isNew ? 'This is a NEW customer - no prior history.' : `This customer has messaged before. Recent history:\n${historyText}`}

Your job:
1. Identify intent: new inquiry, appointment request, quote request, existing customer follow-up, complaint, etc.
2. Draft a warm, professional, concise reply (2-3 sentences max) as Kyle
3. Keep it conversational, not corporate

Rules:
- For roofing: offer free inspection/estimate, mention Roof Revival LLC
- For lights: ask about install date needed, size of home, mention Christmas Lights Installers
- For appointments: try to get their address and preferred time
- For existing customers: reference context if available
- Always end with a question or clear next step
- Never mention you're an AI

Respond with ONLY a JSON object like:
{"intent": "new_inquiry|appointment_request|quote_request|existing_followup|complaint|other", "suggestedReply": "the reply text", "priority": "high|normal|low"}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Customer message: "${messageBody}"` }]
  });

  try {
    const text = response.content[0].text.trim();
    return JSON.parse(text);
  } catch {
    return {
      intent: 'other',
      suggestedReply: `Hi! Thanks for reaching out to ${businessLine}. How can I help you today?`,
      priority: 'normal'
    };
  }
}

// ── Pending reply timers ─────────────────────────────────────────────────────
const pendingTimers = {};

function schedulePendingSend(pendingId, db) {
  if (pendingTimers[pendingId]) clearTimeout(pendingTimers[pendingId]);

  pendingTimers[pendingId] = setTimeout(async () => {
    const freshDB = loadDB();
    const pending = freshDB.pendingReplies[pendingId];
    if (!pending) return;

    // Auto-send the suggested reply
    await sendToCustomer(pending.customerPhone, pending.fromNumber, pending.suggestedReply, freshDB);
    delete freshDB.pendingReplies[pendingId];
    saveDB(freshDB);

    // Notify Kyle it was auto-sent
    await twilioClient.messages.create({
      body: `⏱ Auto-sent to ${pending.customerPhone}:\n"${pending.suggestedReply}"`,
      from: pending.fromNumber,
      to: KYLE_PHONE
    });
    delete pendingTimers[pendingId];
  }, AUTO_SEND_SECONDS * 1000);
}

async function sendToCustomer(customerPhone, fromNumber, body, db) {
  await twilioClient.messages.create({ body, from: fromNumber, to: customerPhone });

  // Save outbound message
  const customer = db.customers[customerPhone];
  if (customer) {
    customer.messages.push({
      direction: 'out',
      body,
      timestamp: new Date().toISOString()
    });
    customer.lastContact = new Date().toISOString();
    saveDB(db);
  }
}

// ── Inbound SMS from customers ───────────────────────────────────────────────
app.post('/webhook/inbound', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString()); // Respond immediately (no auto-reply)

  try {
    const fromPhone  = req.body.From;  // customer's number
    const toNumber   = req.body.To;    // which Twilio number they texted
    const body       = req.body.Body;

    const businessLine = toNumber === ROOF_NUMBER
      ? '🏠 ROOF (352)'
      : toNumber === LIGHTS_NUMBER
        ? '💡 LIGHTS (321)'
        : '📱 UNKNOWN';

    const fromNumberLabel = toNumber === ROOF_NUMBER ? ROOF_NUMBER : LIGHTS_NUMBER;

    const db = loadDB();

    // Save or update customer
    if (!db.customers[fromPhone]) {
      db.customers[fromPhone] = {
        phone: fromPhone,
        name: null,
        line: businessLine,
        firstContact: new Date().toISOString(),
        lastContact: new Date().toISOString(),
        messages: []
      };
    }
    db.customers[fromPhone].messages.push({
      direction: 'in',
      body,
      timestamp: new Date().toISOString()
    });
    db.customers[fromPhone].lastContact = new Date().toISOString();
    saveDB(db);

    // Get AI suggestion — wrapped so a failure never crashes the webhook
    let ai = { intent: 'other', suggestedReply: `Hi! Thanks for reaching out. How can I help you today?`, priority: 'normal' };
    try { ai = await getAISuggestion(fromPhone, body, businessLine, db); } catch(e) { console.error('AI error:', e.message); }

    // Create pending reply
    const pendingId = `${fromPhone}-${Date.now()}`;
    const freshDB   = loadDB();
    freshDB.pendingReplies[pendingId] = {
      pendingId,
      customerPhone: fromPhone,
      fromNumber: fromNumberLabel,
      suggestedReply: ai.suggestedReply,
      intent: ai.intent,
      incomingMessage: body,
      autoSendAt: new Date(Date.now() + AUTO_SEND_SECONDS * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };
    saveDB(freshDB);

    // Text Kyle
    const customerName = freshDB.customers[fromPhone]?.name || fromPhone;
    const notifyMsg =
      `${businessLine} - New message\n` +
      `From: ${customerName}\n` +
      `Intent: ${ai.intent}\n\n` +
      `"${body}"\n\n` +
      `💬 Suggested reply:\n"${ai.suggestedReply}"\n\n` +
      `Reply YES to send • NO to write your own • ignore = auto-sends in ${AUTO_SEND_SECONDS}s\n` +
      `[ID:${pendingId}]`;

    await twilioClient.messages.create({
      body: notifyMsg,
      from: fromNumberLabel,
      to: KYLE_PHONE
    });

    // Schedule auto-send
    schedulePendingSend(pendingId, freshDB);

  } catch (err) {
    console.error('Inbound error:', err);
  }
});

// ── Inbound SMS from Kyle (his replies) ─────────────────────────────────────
app.post('/webhook/kyle', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());

  try {
    const body   = req.body.Body?.trim();
    const toNum  = req.body.To; // which number Kyle texted from

    const db      = loadDB();
    const pendings = Object.values(db.pendingReplies);

    // Find most recent pending for this line
    const pending = pendings
      .filter(p => p.fromNumber === toNum)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (!pending) {
      await twilioClient.messages.create({
        body: '✅ No pending messages to reply to.',
        from: toNum,
        to: KYLE_PHONE
      });
      return;
    }

    const upperBody = body.toUpperCase();

    if (upperBody === 'YES') {
      // Send suggested reply
      if (pendingTimers[pending.pendingId]) clearTimeout(pendingTimers[pending.pendingId]);
      await sendToCustomer(pending.customerPhone, pending.fromNumber, pending.suggestedReply, loadDB());
      delete db.pendingReplies[pending.pendingId];
      saveDB(db);
      await twilioClient.messages.create({
        body: `✅ Sent to ${pending.customerPhone}`,
        from: toNum,
        to: KYLE_PHONE
      });

    } else if (upperBody === 'NO') {
      // Ask Kyle what to send instead
      if (pendingTimers[pending.pendingId]) clearTimeout(pendingTimers[pending.pendingId]);
      // Mark as waiting for custom reply
      db.pendingReplies[pending.pendingId].waitingCustom = true;
      saveDB(db);
      await twilioClient.messages.create({
        body: `✏️ What would you like to say to ${pending.customerPhone}? (Reply with your message)`,
        from: toNum,
        to: KYLE_PHONE
      });

    } else if (pending.waitingCustom) {
      // This is Kyle's custom reply
      if (pendingTimers[pending.pendingId]) clearTimeout(pendingTimers[pending.pendingId]);
      await sendToCustomer(pending.customerPhone, pending.fromNumber, body, loadDB());
      delete db.pendingReplies[pending.pendingId];
      saveDB(db);
      await twilioClient.messages.create({
        body: `✅ Sent to ${pending.customerPhone}`,
        from: toNum,
        to: KYLE_PHONE
      });

    } else {
      // Could be a direct custom reply (not YES/NO flow) - send it directly
      if (pendingTimers[pending.pendingId]) clearTimeout(pendingTimers[pending.pendingId]);
      await sendToCustomer(pending.customerPhone, pending.fromNumber, body, loadDB());
      delete db.pendingReplies[pending.pendingId];
      saveDB(db);
      await twilioClient.messages.create({
        body: `✅ Sent to ${pending.customerPhone}`,
        from: toNum,
        to: KYLE_PHONE
      });
    }

  } catch (err) {
    console.error('Kyle reply error:', err);
  }
});

// ── Extra API routes ─────────────────────────────────────────────────────────

// API: get all data (for dashboard polling)
app.get('/api/data', (req, res) => {
  const db = loadDB();
  const customers = Object.values(db.customers).sort((a,b)=>new Date(b.lastContact)-new Date(a.lastContact));
  res.json({ customers, pendingReplies: db.pendingReplies });
});

// API: send reply from dashboard
app.post('/api/send', async (req, res) => {
  try {
    const { customerPhone, body, pendingId } = req.body;
    const db = loadDB();
    const customer = db.customers[customerPhone];
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const fromNumber = customer.line.includes('ROOF') ? ROOF_NUMBER : LIGHTS_NUMBER;
    if (pendingId && pendingTimers[pendingId]) { clearTimeout(pendingTimers[pendingId]); delete pendingTimers[pendingId]; }
    await sendToCustomer(customerPhone, fromNumber, body, loadDB());
    const db2 = loadDB();
    if (pendingId && db2.pendingReplies[pendingId]) { delete db2.pendingReplies[pendingId]; saveDB(db2); }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API: dismiss pending
app.post('/api/dismiss', (req, res) => {
  const { pendingId } = req.body;
  if (pendingTimers[pendingId]) { clearTimeout(pendingTimers[pendingId]); delete pendingTimers[pendingId]; }
  const db = loadDB();
  delete db.pendingReplies[pendingId];
  saveDB(db);
  res.json({ ok: true });
});

// API: call customer (bridge call through Twilio)
app.post('/api/call', async (req, res) => {
  try {
    const { customerPhone, fromNumber } = req.body;
    await twilioClient.calls.create({
      to: KYLE_PHONE, from: fromNumber,
      url: req.protocol + '://' + req.get('host') + '/webhook/call-bridge?to=' + encodeURIComponent(customerPhone) + '&from=' + encodeURIComponent(fromNumber)
    });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/webhook/call-bridge', (req, res) => {
  const to = req.query.to;
  const from = req.query.from;
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Connecting you to your customer now.');
  const dial = twiml.dial({ callerId: from, timeout: 30 });
  dial.number(to);
  res.type('text/xml').send(twiml.toString());
});

// API: send new SMS to any number
app.post('/api/new-sms', async (req, res) => {
  try {
    const { toPhone, body, fromNumber } = req.body;
    let phone = toPhone.replace(/\D/g,'');
    if (phone.length === 10) phone = '+1' + phone;
    else if (!phone.startsWith('+')) phone = '+' + phone;
    const isRoof = fromNumber === ROOF_NUMBER;
    const businessLine = isRoof ? '🏠 ROOF (352)' : '💡 LIGHTS (321)';
    const db = loadDB();
    if (!db.customers[phone]) {
      db.customers[phone] = { phone, name: null, line: businessLine, firstContact: new Date().toISOString(), lastContact: new Date().toISOString(), messages: [] };
    }
    await sendToCustomer(phone, fromNumber, body, db);
    res.json({ ok: true, phone });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// API: new outbound call to any number
app.post('/api/new-call', async (req, res) => {
  try {
    const { toPhone, fromNumber } = req.body;
    let phone = toPhone.replace(/\D/g,'');
    if (phone.length === 10) phone = '+1' + phone;
    else if (!phone.startsWith('+')) phone = '+' + phone;
    await twilioClient.calls.create({
      to: KYLE_PHONE, from: fromNumber,
      url: req.protocol + '://' + req.get('host') + '/webhook/call-bridge?to=' + encodeURIComponent(phone) + '&from=' + encodeURIComponent(fromNumber)
    });
    res.json({ ok: true, phone });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Web Dashboard ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const db = loadDB();
  const customers = Object.values(db.customers).sort((a,b)=>new Date(b.lastContact)-new Date(a.lastContact));
  const pendings = Object.values(db.pendingReplies).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));

  const pendingCards = pendings.map(p => {
    const name = db.customers[p.customerPhone]?.name || p.customerPhone;
    const line = p.fromNumber === process.env.ROOF_NUMBER ? '🏠 Roof (352)' : '💡 Lights (321)';
    return `
    <div class="pcard" id="pc-${p.pendingId}">
      <div class="pcard-top">
        <div>
          <div class="pname">${name}</div>
          <div class="pline">${line} · ${p.intent || ''}</div>
        </div>
        <div class="ptimer" id="timer-${p.pendingId}">⏱</div>
      </div>
      <div class="pmsg">"${(p.incomingMessage||'').replace(/"/g,'&quot;')}"</div>
      <div class="plabel">✨ AI Suggested Reply</div>
      <div class="psugg" id="sugg-${p.pendingId}">${p.suggestedReply}</div>
      <div class="pactions">
        <button class="btn-send" onclick="sendSugg('${p.pendingId}','${p.customerPhone}')">✓ Send</button>
        <button class="btn-edit" onclick="toggleEdit('${p.pendingId}')">✏️ Edit</button>
        <button class="btn-dismiss" onclick="dismissPending('${p.pendingId}')">✕</button>
      </div>
      <div class="pedit" id="edit-${p.pendingId}" style="display:none">
        <textarea class="pedit-ta" id="eta-${p.pendingId}">${p.suggestedReply}</textarea>
        <button class="btn-send" onclick="sendCustom('${p.pendingId}','${p.customerPhone}')">Send My Reply</button>
      </div>
    </div>`;
  }).join('');

  const customerRows = customers.map(c => {
    const last = c.messages[c.messages.length-1];
    const unread = c.messages.filter(m=>m.direction==='in'&&!m.read).length;
    const isRoof = c.line && c.line.includes('ROOF');
    const preview = last ? (last.body||'').substring(0,50) : '';
    return `
    <div class="crow" onclick="location='/customer/${encodeURIComponent(c.phone)}'">
      <div class="cav ${isRoof?'avr':'avl'}">${isRoof?'🏠':'💡'}</div>
      <div class="cinfo">
        <div class="cname">${c.name || c.phone}</div>
        <div class="cprev">${preview}</div>
      </div>
      <div class="cmeta">
        <div class="ctime">${last ? new Date(last.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</div>
        ${unread>0?`<div class="ubadge">${unread}</div>`:''}
      </div>
    </div>`;
  }).join('') || '<div class="empty">No messages yet</div>';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="SMS Hub">
<title>SMS Hub</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:-apple-system,sans-serif;background:#0f0f23;color:#e8e8ff;min-height:100vh}
.hdr{background:#1a1a35;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;border-bottom:1px solid #2e2e55}
.hdr-title{font-size:18px;font-weight:700;color:#fff}
.hdr-sub{font-size:11px;color:#8888aa}
.compose-btn{background:#6c63ff;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:14px;font-weight:600;cursor:pointer}
.stats{display:flex;gap:8px;padding:12px 16px}
.stat{flex:1;background:#1a1a35;border-radius:10px;padding:10px;text-align:center;border:1px solid #2e2e55}
.snum{font-size:20px;font-weight:800;color:#6c63ff}
.slbl{font-size:10px;color:#8888aa;text-transform:uppercase;margin-top:2px}
.section-title{font-size:13px;font-weight:600;color:#8888aa;text-transform:uppercase;letter-spacing:.5px;padding:8px 16px 6px}
.pcard{background:#1a1a35;border:1px solid #ff6584;border-radius:14px;margin:0 16px 10px;padding:14px}
.pcard-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.pname{font-size:15px;font-weight:700;color:#fff}
.pline{font-size:12px;color:#8888aa;margin-top:2px}
.ptimer{font-size:13px;color:#8888aa}
.pmsg{background:#252545;border-radius:8px;padding:8px 10px;font-size:13px;color:#e8e8ff;margin-bottom:10px;font-style:italic}
.plabel{font-size:11px;color:#6c63ff;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.psugg{background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);border-radius:8px;padding:8px 10px;font-size:13px;color:#e8e8ff;margin-bottom:10px;line-height:1.5}
.pactions{display:flex;gap:8px;margin-bottom:0}
.btn-send{flex:1;background:#00d4aa;color:#000;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.btn-edit{flex:1;background:#6c63ff;color:#fff;border:none;border-radius:10px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.btn-dismiss{background:#252545;color:#8888aa;border:1px solid #2e2e55;border-radius:10px;padding:10px 14px;font-size:14px;cursor:pointer}
.pedit{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.pedit-ta{background:#252545;border:1px solid #2e2e55;border-radius:10px;padding:10px;color:#e8e8ff;font-size:14px;resize:none;min-height:70px;font-family:inherit;width:100%}
.crow{display:flex;align-items:center;gap:12px;padding:12px;background:#1a1a35;border-radius:12px;margin:0 16px 8px;cursor:pointer;border:1px solid #2e2e55}
.cav{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.avr{background:rgba(108,99,255,.2)}.avl{background:rgba(255,209,102,.2)}
.cinfo{flex:1;min-width:0}
.cname{font-size:15px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cprev{font-size:13px;color:#8888aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.cmeta{text-align:right;flex-shrink:0}
.ctime{font-size:11px;color:#8888aa}
.ubadge{display:inline-block;background:#ef476f;color:#fff;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700;margin-top:4px}
.empty{text-align:center;padding:40px;color:#8888aa}
/* Compose Modal */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:none}
.overlay.on{display:block}
.modal{position:fixed;bottom:0;left:0;right:0;background:#1a1a35;border-radius:20px 20px 0 0;z-index:101;padding:20px 20px 40px;display:none;max-height:85vh;overflow-y:auto}
.modal.on{display:block}
.modal-title{font-size:18px;font-weight:700;color:#fff;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center}
.modal-close{background:#252545;border:none;border-radius:50%;width:30px;height:30px;color:#e8e8ff;cursor:pointer;font-size:16px}
.mlbl{display:block;font-size:12px;color:#8888aa;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;margin-top:12px}
.line-btns{display:flex;gap:8px}
.lbtn{flex:1;padding:10px;background:#252545;border:1px solid #2e2e55;border-radius:10px;color:#e8e8ff;cursor:pointer;font-size:14px}
.lbtn.on{background:#6c63ff;border-color:#6c63ff;color:#fff;font-weight:700}
.mode-btns{display:flex;gap:8px;margin-top:12px}
.mbtn{flex:1;padding:10px;background:#252545;border:1px solid #2e2e55;border-radius:10px;color:#e8e8ff;cursor:pointer;font-size:14px}
.mbtn.on{border-color:#6c63ff;background:rgba(108,99,255,.2)}
.minput,.mta{display:block;width:100%;background:#252545;border:1px solid #2e2e55;border-radius:10px;padding:12px;color:#e8e8ff;font-size:15px;font-family:inherit;margin-top:6px}
.mta{resize:none;min-height:80px}
.minput:focus,.mta:focus{outline:none;border-color:#6c63ff}
.msubmit{width:100%;margin-top:16px;padding:14px;background:#6c63ff;border:none;border-radius:12px;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="hdr-title">📱 SMS Hub</div>
    <div class="hdr-sub">Roof Revival &amp; Lights</div>
  </div>
  <button class="compose-btn" onclick="openCompose()">+ Compose</button>
</div>

<div class="stats">
  <div class="stat"><div class="snum">${customers.length}</div><div class="slbl">Total</div></div>
  <div class="stat"><div class="snum">${customers.filter(c=>c.line&&c.line.includes('ROOF')).length}</div><div class="slbl">🏠 Roof</div></div>
  <div class="stat"><div class="snum">${customers.filter(c=>c.line&&c.line.includes('LIGHTS')).length}</div><div class="slbl">💡 Lights</div></div>
  <div class="stat"><div class="snum" style="color:#ff6584">${pendings.length}</div><div class="slbl">Pending</div></div>
</div>

${pendings.length > 0 ? `<div class="section-title">⏳ Needs Reply</div>${pendingCards}` : ''}

<div class="section-title">💬 Conversations</div>
${customerRows}

<!-- Compose Modal -->
<div class="overlay" id="overlay" onclick="closeCompose()"></div>
<div class="modal" id="modal">
  <div class="modal-title">
    New Message / Call
    <button class="modal-close" onclick="closeCompose()">✕</button>
  </div>
  <label class="mlbl">From number</label>
  <div class="line-btns">
    <button class="lbtn on" id="lb-roof" onclick="pickLine('roof')">🏠 Roof (352)</button>
    <button class="lbtn" id="lb-lights" onclick="pickLine('lights')">💡 Lights (321)</button>
  </div>
  <label class="mlbl">To (phone number)</label>
  <input class="minput" id="mto" type="tel" placeholder="(352) 555-1234">
  <div class="mode-btns">
    <button class="mbtn on" id="mb-sms" onclick="pickMode('sms')">💬 Text Message</button>
    <button class="mbtn" id="mb-call" onclick="pickMode('call')">📞 Phone Call</button>
  </div>
  <div id="msg-section">
    <label class="mlbl">Message</label>
    <textarea class="mta" id="mmsg" placeholder="Type your message…"></textarea>
  </div>
  <button class="msubmit" id="msubmit" onclick="submitCompose()">Send Message</button>
</div>

<script>
const ROOF_NUMBER = '${process.env.ROOF_NUMBER}';
const LIGHTS_NUMBER = '${process.env.LIGHTS_NUMBER}';
const AUTO_SEC = ${AUTO_SEND_SECONDS};
let composeLine = ROOF_NUMBER;
let composeMode = 'sms';

// Auto-timers for pending cards
document.querySelectorAll('[id^="timer-"]').forEach(el => {
  const pendingId = el.id.replace('timer-','');
  const card = document.getElementById('pc-'+pendingId);
  if (!card) return;
  // Find autoSendAt from data attribute - we'll use a simple countdown based on card age
  // Since we don't have autoSendAt in HTML, just show a live clock
  setInterval(() => {
    // Just refresh every 30s so the page stays current
  }, 1000);
});

// Reload every 30s to pick up new messages
setInterval(() => location.reload(), 30000);

// Pending card actions
async function sendSugg(pendingId, phone) {
  const text = document.getElementById('sugg-'+pendingId)?.textContent;
  if (!text) return;
  const btn = event.target; btn.textContent = 'Sending…'; btn.disabled = true;
  try {
    const r = await fetch('/api/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerPhone:phone,body:text,pendingId})});
    const d = await r.json();
    if (d.ok) { document.getElementById('pc-'+pendingId)?.remove(); showToast('Sent ✓'); }
    else showToast('Error: '+d.error);
  } catch(e) { showToast('Error'); }
}

function toggleEdit(pendingId) {
  const el = document.getElementById('edit-'+pendingId);
  el.style.display = el.style.display === 'none' ? 'flex' : 'none';
  if (el.style.display === 'flex') el.querySelector('textarea').focus();
}

async function sendCustom(pendingId, phone) {
  const text = document.getElementById('eta-'+pendingId)?.value?.trim();
  if (!text) return;
  const btn = event.target; btn.textContent = 'Sending…'; btn.disabled = true;
  try {
    const r = await fetch('/api/send', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerPhone:phone,body:text,pendingId})});
    const d = await r.json();
    if (d.ok) { document.getElementById('pc-'+pendingId)?.remove(); showToast('Sent ✓'); }
    else showToast('Error: '+d.error);
  } catch(e) { showToast('Error'); }
}

async function dismissPending(pendingId) {
  await fetch('/api/dismiss', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pendingId})});
  document.getElementById('pc-'+pendingId)?.remove();
}

// Compose modal
function openCompose() {
  document.getElementById('overlay').classList.add('on');
  document.getElementById('modal').classList.add('on');
  document.getElementById('mto').value = '';
  document.getElementById('mmsg').value = '';
  document.getElementById('mto').focus();
}
function closeCompose() {
  document.getElementById('overlay').classList.remove('on');
  document.getElementById('modal').classList.remove('on');
}
function pickLine(line) {
  composeLine = line === 'roof' ? ROOF_NUMBER : LIGHTS_NUMBER;
  document.getElementById('lb-roof').classList.toggle('on', line==='roof');
  document.getElementById('lb-lights').classList.toggle('on', line==='lights');
}
function pickMode(mode) {
  composeMode = mode;
  document.getElementById('mb-sms').classList.toggle('on', mode==='sms');
  document.getElementById('mb-call').classList.toggle('on', mode==='call');
  document.getElementById('msg-section').style.display = mode==='sms' ? 'block' : 'none';
  document.getElementById('msubmit').textContent = mode==='sms' ? 'Send Message' : 'Start Call';
}
async function submitCompose() {
  const to = document.getElementById('mto').value.trim();
  if (!to) { showToast('Enter a phone number'); return; }
  const btn = document.getElementById('msubmit');
  btn.textContent = 'Working…'; btn.disabled = true;
  try {
    if (composeMode === 'sms') {
      const msg = document.getElementById('mmsg').value.trim();
      if (!msg) { showToast('Enter a message'); btn.textContent='Send Message'; btn.disabled=false; return; }
      const r = await fetch('/api/new-sms', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toPhone:to,body:msg,fromNumber:composeLine})});
      const d = await r.json();
      if (d.ok) { closeCompose(); showToast('Sent ✓'); setTimeout(()=>location.href='/customer/'+encodeURIComponent(d.phone), 500); }
      else showToast('Error: '+d.error);
    } else {
      const r = await fetch('/api/new-call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toPhone:to,fromNumber:composeLine})});
      const d = await r.json();
      if (d.ok) { closeCompose(); showToast('📞 Answer your phone!'); }
      else showToast('Error: '+d.error);
    }
  } catch(e) { showToast('Error: '+e.message); }
  btn.disabled = false;
  btn.textContent = composeMode==='sms' ? 'Send Message' : 'Start Call';
}

function showToast(msg) {
  let t = document.getElementById('_toast');
  if (!t) { t=document.createElement('div'); t.id='_toast'; t.style.cssText='position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#252545;border:1px solid #2e2e55;border-radius:10px;padding:10px 20px;font-size:14px;color:#e8e8ff;z-index:999;transition:opacity .3s'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity='1';
  setTimeout(()=>t.style.opacity='0', 2500);
}
</script>
</body>
</html>`);
});
app.get('/customer/:phone', (req, res) => {
  const db = loadDB();
  const phone = decodeURIComponent(req.params.phone);
  const customer = db.customers[phone];
  if (!customer) return res.status(404).send('Not found');

  const messages = customer.messages.map(m => `
    <div class="msg ${m.direction}">
      <div class="bubble">${m.body}</div>
      <div class="time">${new Date(m.timestamp).toLocaleString()}</div>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>${customer.name || phone}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; }
    header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
    header a { color: white; text-decoration: none; font-size: 20px; }
    .info { background: white; padding: 16px 24px; border-bottom: 1px solid #eee; display: flex; gap: 24px; font-size: 14px; }
    .info span { color: #666; } .info strong { color: #333; }
    .name-form { padding: 16px 24px 0; }
    .name-form input { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; font-size: 14px; }
    .name-form button { background: #1a1a2e; color: white; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 14px; margin-left: 8px; }
    .messages { padding: 24px; display: flex; flex-direction: column; gap: 12px; max-height: 60vh; overflow-y: auto; }
    .msg { display: flex; flex-direction: column; max-width: 70%; }
    .msg.in { align-self: flex-start; }
    .msg.out { align-self: flex-end; align-items: flex-end; }
    .bubble { padding: 10px 14px; border-radius: 16px; font-size: 14px; line-height: 1.4; }
    .msg.in .bubble { background: white; border: 1px solid #eee; }
    .msg.out .bubble { background: #1a1a2e; color: white; }
    .time { font-size: 11px; color: #999; margin-top: 4px; padding: 0 4px; }
    .reply-box { padding: 16px 24px; background: white; border-top: 1px solid #eee; display: flex; gap: 12px; }
    .reply-box textarea { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 10px; font-size: 14px; resize: none; height: 60px; }
    .reply-box button { background: #1a1a2e; color: white; border: none; border-radius: 8px; padding: 10px 20px; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <a href="/">←</a>
    <div style="flex:1">
      <div style="font-size:18px;font-weight:600">${customer.name || phone}</div>
      <div style="font-size:13px;opacity:0.8">${customer.line}</div>
    </div>
    <button onclick="callCustomer()" style="background:#00d4aa;color:#000;border:none;border-radius:8px;padding:8px 12px;font-size:16px;cursor:pointer;margin-left:8px" title="Call customer">📞</button>
  </header>
  <div class="info">
    <div><span>Phone: </span><strong>${phone}</strong></div>
    <div><span>First contact: </span><strong>${new Date(customer.firstContact).toLocaleDateString()}</strong></div>
    <div><span>Messages: </span><strong>${customer.messages.length}</strong></div>
  </div>
  <div class="name-form">
    <form method="POST" action="/customer/${encodeURIComponent(phone)}/name" style="display:flex;align-items:center;gap:8px">
      <input name="name" value="${customer.name || ''}" placeholder="Set customer name…">
      <button type="submit">Save Name</button>
    </form>
  </div>
  <div class="messages">${messages}</div>
  <div class="reply-box">
    <textarea id="replyText" placeholder="Type a reply…"></textarea>
    <button onclick="sendReply()">Send</button>
  </div>
  <script>
    document.querySelector('.messages').scrollTop = 999999;
    document.querySelector('.messages').scrollTop = 999999;
    async function sendReply() {
      const text = document.getElementById('replyText').value.trim();
      if (!text) return;
      const btn = event.target; btn.textContent='Sending…'; btn.disabled=true;
      await fetch('/customer/${encodeURIComponent(phone)}/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({body: text})
      });
      location.reload();
    }
    async function callCustomer() {
      const fromNumber = '${customer.line.includes("ROOF") ? process.env.ROOF_NUMBER : process.env.LIGHTS_NUMBER}';
      const r = await fetch('/api/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({customerPhone:'${phone}',fromNumber})});
      const d = await r.json();
      if (d.ok) alert('📞 Answer your phone — connecting you to ${phone}');
      else alert('Call failed: ' + d.error);
    }
  </script>
</body>
</html>`);
});

app.post('/customer/:phone/name', express.urlencoded({ extended: false }), (req, res) => {
  const db = loadDB();
  const phone = decodeURIComponent(req.params.phone);
  if (db.customers[phone]) {
    db.customers[phone].name = req.body.name;
    saveDB(db);
  }
  res.redirect(`/customer/${encodeURIComponent(phone)}`);
});

app.post('/customer/:phone/send', async (req, res) => {
  const db = loadDB();
  const phone = decodeURIComponent(req.params.phone);
  const customer = db.customers[phone];
  if (!customer) return res.status(404).json({ error: 'Not found' });

  const fromNumber = customer.line.includes('ROOF') ? ROOF_NUMBER : LIGHTS_NUMBER;
  await sendToCustomer(phone, fromNumber, req.body.body, db);
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SMS AI running on port ${PORT}`));
