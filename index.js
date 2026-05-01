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
    model: 'claude-sonnet-4-20250514',
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

    // Get AI suggestion
    const ai = await getAISuggestion(fromPhone, body, businessLine, db);

    // Create pending reply
    const pendingId = `${fromPhone}-${Date.now()}`;
    const freshDB   = loadDB();
    freshDB.pendingReplies[pendingId] = {
      pendingId,
      customerPhone: fromPhone,
      fromNumber: fromNumberLabel,
      suggestedReply: ai.suggestedReply,
      intent: ai.intent,
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

// ── Web Dashboard ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const db = loadDB();
  const customers = Object.values(db.customers)
    .sort((a, b) => new Date(b.lastContact) - new Date(a.lastContact));

  const rows = customers.map(c => {
    const last = c.messages[c.messages.length - 1];
    const unread = c.messages.filter(m => m.direction === 'in' && !m.read).length;
    return `
      <tr onclick="window.location='/customer/${encodeURIComponent(c.phone)}'" style="cursor:pointer">
        <td>${c.name || '(unknown)'}</td>
        <td>${c.phone}</td>
        <td>${c.line}</td>
        <td>${last ? last.body.substring(0, 40) + (last.body.length > 40 ? '…' : '') : ''}</td>
        <td>${new Date(c.lastContact).toLocaleString()}</td>
        <td>${unread > 0 ? `<span class="badge">${unread}</span>` : ''}</td>
      </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Roof Revival SMS</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f5f5f5; color: #333; }
    header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 20px; }
    .stats { display: flex; gap: 16px; padding: 20px 24px; }
    .stat { background: white; border-radius: 8px; padding: 16px 24px; flex: 1; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat .num { font-size: 28px; font-weight: bold; color: #1a1a2e; }
    .stat .label { font-size: 13px; color: #666; margin-top: 4px; }
    .table-wrap { margin: 0 24px 24px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1a1a2e; color: white; padding: 12px 16px; text-align: left; font-size: 13px; }
    td { padding: 12px 16px; border-bottom: 1px solid #eee; font-size: 14px; }
    tr:hover td { background: #f0f4ff; }
    .badge { background: #e53e3e; color: white; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .pending-banner { margin: 0 24px 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 12px 16px; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <h1>🏠 Roof Revival / 💡 Lights — SMS Dashboard</h1>
    <span style="font-size:13px;opacity:0.8">Auto-refreshes every 30s</span>
  </header>
  ${Object.keys(db.pendingReplies).length > 0 ? `<div class="pending-banner">⏳ <strong>${Object.keys(db.pendingReplies).length} pending reply(ies)</strong> awaiting your response</div>` : ''}
  <div class="stats">
    <div class="stat"><div class="num">${customers.length}</div><div class="label">Total Customers</div></div>
    <div class="stat"><div class="num">${customers.filter(c => c.line.includes('ROOF')).length}</div><div class="label">Roof Customers</div></div>
    <div class="stat"><div class="num">${customers.filter(c => c.line.includes('LIGHTS')).length}</div><div class="label">Lights Customers</div></div>
    <div class="stat"><div class="num">${Object.keys(db.pendingReplies).length}</div><div class="label">Pending Replies</div></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Name</th><th>Phone</th><th>Line</th><th>Last Message</th><th>Last Contact</th><th>Unread</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;padding:40px;color:#999">No customers yet</td></tr>'}</tbody>
    </table>
  </div>
  <script>setTimeout(() => location.reload(), 30000)</script>
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
    <div>
      <div style="font-size:18px;font-weight:600">${customer.name || phone}</div>
      <div style="font-size:13px;opacity:0.8">${customer.line}</div>
    </div>
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
    async function sendReply() {
      const text = document.getElementById('replyText').value.trim();
      if (!text) return;
      await fetch('/customer/${encodeURIComponent(phone)}/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({body: text})
      });
      location.reload();
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
