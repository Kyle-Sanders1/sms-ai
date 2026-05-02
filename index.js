require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Uploads directory (created if missing) — served publicly so Twilio can fetch media
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      const safeExt = ext.replace(/[^a-z0-9.]/g, '');
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + safeExt);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB cap (Twilio MMS limit ~5MB but allow some headroom)
});

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve uploaded media publicly so Twilio can fetch
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));

// Upload endpoint — receives a file, returns a public URL
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  // Build absolute public URL — Twilio needs an https URL it can fetch
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const url = `${proto}://${host}/uploads/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.filename });
});

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


// ── Real-time updates via Server-Sent Events ─────────────────────────────────
const sseClients = new Set();
function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// ── AI: classify + suggest ───────────────────────────────────────────────────
async function getAISuggestion(customerPhone, messageBody, businessLine, db) {
  const customer = db.customers[customerPhone];
  // Pull last 10 exchanges (excluding the current incoming message which was just saved)
  const allMsgs = customer ? customer.messages : [];
  const history = allMsgs.slice(0, -1).slice(-10); // exclude current message
  const isNew = history.length === 0;
  const customerName = customer?.name || 'unknown';

  const historyText = history.map(m =>
    `${m.direction === 'in' ? 'Customer' : 'Kyle'}: ${m.body || '(media)'}`
  ).join('\n');

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  AI TRAINING — EDIT THE EXAMPLES BELOW TO TUNE HOW THE AI RESPONDS    ║
  // ║  Each line under a section shows Customer → Kyle's ideal reply        ║
  // ╚═══════════════════════════════════════════════════════════════════════╝

  const today = new Date();
  const isChristmasSeason = today.getMonth() >= 9; // October (9) through December

  const lightsContext = isChristmasSeason
    ? `Currently it IS Christmas season. Customers may be asking about temporary Christmas lights. The Lights line offers BOTH permanent roofline lighting (year-round) AND temporary Christmas lights (Oct-Jan only). When unclear, ask which they're interested in — but lead with permanent lighting as the primary product.`
    : `It is NOT Christmas season right now. The Lights line is focused on PERMANENT ROOFLINE LIGHTING (year-round LED tracks installed under the eaves). Do NOT offer temporary Christmas lights. If a customer asks about Christmas lights, mention that we book those starting in October and steer toward permanent lighting which works for holidays AND year-round.`;

  const trainingExamples = `
═══ ROOFING / REPLACEMENT / REPAIR (Kyle handles these directly) ═══

For roof replacement, repairs, leaks, inspections — Kyle prefers to handle these conversations himself. Keep replies SHORT and don't push hard for a meeting. Just acknowledge, gather basic info (address, issue), and let Kyle take it from there.

Customer: "Hey is this the roofing company?"
Kyle: "Hey! Yes, Roof Revival here. What's going on with the roof?"

Customer: "I have a leak in my ceiling"
Kyle: "Sorry to hear that — what's the address? I'll get back to you in a few to set up a look."

Customer: "How much for a full roof replacement?"
Kyle: "Depends on size and material. What's the address and roughly how old is the current roof?"

Customer: "Saw your sign in the neighborhood"
Kyle: "Thanks for reaching out! Any roof issues, or just thinking about an inspection?"

═══ ROOF CLEANING (Send instant estimator link, aim for 25% off) ═══

For roof cleaning, send customers to Kyle's Roofr instant estimator. They fill in their info and the system spits out a quote (intentionally inflated). When they share the price, you can offer 25% off (up to 35% MAX if they push back). NEVER reveal the 35% ceiling — always start at 25% off.

The estimator link: https://app.roofr.com/instant-estimator/4821d29c-d7fb-47bc-9e76-95fc0749bd4d/RoofRevival

Customer: "How much for a roof cleaning?"
Kyle: "Easiest way is to grab an instant quote here: https://app.roofr.com/instant-estimator/4821d29c-d7fb-47bc-9e76-95fc0749bd4d/RoofRevival — fill in your info and it'll pop the price right out. Send me what it says and I'll see what I can do on price."

Customer: "It says $800"
Kyle: "Cool — I can knock 25% off that, so $600 out the door. Want me to get you on the schedule?"

Customer: "That's still kind of high"
Kyle: "I hear you. Let me see what I can do — what were you hoping to spend?"
(if they push toward $500 or so, Kyle can go up to 35% off but always negotiate gradually)

Customer: "Can you do better than 25%?"
Kyle: "Let me see what I can do. What would make this a yes for you?"

Customer: "When can you come do it?"
Kyle: "Usually within the week. What's the address and any day work best?"

═══ ROOF REJUVENATION (25% off, can answer more questions) ═══

Roof rejuvenation = a treatment that extends the life of an aging asphalt shingle roof. Same Roofr instant estimator works for pricing. 25% off the estimator price.

Customer: "What's roof rejuvenation?"
Kyle: "It's a soy-based treatment we apply to aging shingles — restores the oils, helps them flex again, and adds about 5 years of life to the roof. Way cheaper than a replacement. Roughly how old is your roof?"

Customer: "Mine is 15 years old, would that work?"
Kyle: "Yep, that's right in the sweet spot — 10-20 years is ideal. Grab an instant quote here: https://app.roofr.com/instant-estimator/4821d29c-d7fb-47bc-9e76-95fc0749bd4d/RoofRevival and send me what it shows. I can take 25% off that price."

Customer: "How long does it last?"
Kyle: "Treatment lasts about 5 years, then you can do it again. Way more cost-effective than replacing the whole roof. Want me to send the instant estimator?"

Customer: "Will it void my warranty?"
Kyle: "Nope — it's manufacturer-approved on most shingle brands. Happy to confirm with your specific shingle if you know the brand."

═══ PERMANENT LIGHTING — CONVERSATION FLOW ═══

CRITICAL: Do NOT pitch the appointment in the first reply. Real sales is a conversation, not a script. Build rapport, gather info naturally, THEN suggest the next step. Slow down. Be human. Ask one thing at a time.

The natural flow goes roughly:
  1) Greeting + name (if new) → 2) What they're picturing (areas of home) → 3) Timeline → 4) Then transition to next step (Calendly link)

You don't have to follow this order rigidly — let the customer drive. If they jump ahead, follow them. If they share info, acknowledge it before asking the next question.

══ PRICING IS THE TRAP — HOW TO DODGE IT ══

When a customer asks "how much" — DO NOT throw out a number, range, or anchor. The price depends on tons of variables and giving a number lets them self-disqualify. Instead, list the variables casually so they understand WHY you can't quote yet, then pivot to discovery questions.

Variables to mention (vary which ones you list — don't recite all every time):
• Single story vs two story
• Linear feet of roofline
• Front only, sides, back, full perimeter, screen enclosure
• Accessibility (ladder vs lift)
• Time of year (peak season Nov-Dec books up + costs more)
• Roofline complexity (peaks, dormers, multi-pitch)
• Color/feature options on the lights themselves

══ HOW A REAL CONVERSATION FLOWS — FULL EXAMPLE WITH ALL 4 SALES MOVES ══

Pay attention to how Kyle: (1) asks about the AREA to drop social proof, (2) bundles light questions naturally when they pair, (3) ties urgency to what THEY said, and (4) soft-closes with "if everything looks good we can get you on the schedule quick"

Customer: "Hey this is Joe, I got a door hanger and was wondering what you charge for permanent lights."
Kyle: "Hey Joe, appreciate you grabbing the door hanger! Pricing depends on a bunch of stuff — single or two story, how much of the roofline, accessibility, time of year, all that. What part of town are you in, and what are you picturing — front, sides, full perimeter?"
[BUNDLED two natural questions: location for social proof + scope]

Customer: "I'm in Lake Wood Estates, just thinking front and maybe sides depending on price"
Kyle: "Oh nice, we've done a handful over in that area — the layout in those homes lines up really well with how the lights run, they always come out looking sharp. Single or two story, and any guess on the linear feet across the front?"
[SOCIAL PROOF + neighborhood validation, then bundled discovery questions]

Customer: "Two story, probably 70 feet across the front"
Kyle: "Got it, that's helpful. You looking to knock this out soon or more thinking holidays? Reason I ask, peak season starts filling up fast and pricing tightens up the closer we get."
[Setting up urgency hook]

Customer: "Preferably sooner than later"
Kyle: "Perfect — actually that's great timing. We've got some early-install spots open before things get tight, and that's where we can usually do the best on price. Best next step is a quick 15-min onsite — we'll measure exact, walk you through the actual lights and tracks, and put real pricing together right there. If everything looks good, we can usually get you on the schedule pretty quick. Grab whatever time works: https://calendly.com/ohanalights/consultation"
[URGENCY TIED TO HIS WORDS + soft close + clear next step]

══ MORE EXAMPLES ══

Customer: "Hey can I get a quote"
Kyle: "Hey, this is Kyle. Pricing depends on a lot — story height, linear feet, roofline complexity, time of year. What part of town are you in, and got a sense of what you'd want done?"

Customer: "How much do these run?"
Kyle: "Honestly all over the map depending on the home — single vs two story, how much of the roofline, accessibility, all that. What area are you in and what are you picturing?"

Customer: "Just looking for a ballpark"
Kyle: "Yeah I hear you — problem is anything I throw out without seeing it would be a guess. Two-story full perimeter with a lift is a totally different world than a small front-only single story. What part of town are you in?"

Customer: "I'm in Mount Dora"
Kyle: "Oh awesome, we've done a bunch out there — beautiful area, the homes always look great with our system. What part of the house are you thinking?"
[SOCIAL PROOF for the neighborhood]

Customer: "I'm in Clermont"
Kyle: "Nice, we've been all over Clermont this year. What part of the home are you picturing — front, sides, full perimeter?"

Customer: "Front and sides"
Kyle: "Got it. Single or two story, and any rough idea on the linear feet?"
[BUNDLED two related questions instead of asking one at a time]

Customer: "Two story, maybe 60 ft across"
Kyle: "Helpful, thanks. You looking to get this done now or closer to the holidays?"

Customer: "Probably before the holidays"
Kyle: "Smart move — peak season tightens up fast and pricing reflects that. We've still got early-install spots where we can do the best on price. Best next step is a quick 15-min onsite — we'll measure, walk you through the actual product, and lock in real pricing. If everything looks good we can usually get you on the schedule pretty quick. Grab whatever time works: https://calendly.com/ohanalights/consultation"

Customer: "Probably soon, just want to get a number first"
Kyle: "Totally fair. Anything I throw out without seeing it would be a guess and I don't want to lowball or scare you off. The 15-min visit's free and zero pressure. If everything checks out we can usually get you on the schedule quick. What part of town are you in?"
[Pricing dodge + soft close + pivot to neighborhood discovery]

══ HANDLING JELLYFISH/TRIMLIGHT COMPARISONS ══

Customer: "What's the difference between yours and Jellyfish?"
Kyle: "Same style of system, comparable quality — lights, tracks, app control, all that. Difference is usually price. They give you a quote yet?"

Customer: "Yeah they quoted me $4,200"
Kyle: "We can usually come in well under that. Single or two story?"

══ PRICING PUSH-BACK (when they REALLY want a number) ══

Customer: "Just give me a number, even rough"
Kyle: "Honestly anything I'd say without seeing it is a shot in the dark — I've quoted homes that were way more or way less than I expected once I saw them. The 15-min visit is free, no pressure. What's your address?"

Customer: "I won't book without a number"
Kyle: "Fair enough. Without seeing the home, what I can tell you is they range from a few hundred for a small front-only setup to several thousand for a full two-story perimeter — too many variables to narrow it more than that without a look. Worth a 15-min visit?"

(NOTE: Only give that range if they push back twice. Default behavior is no number at all.)

══ OBJECTIONS ══

Customer: "I'm just doing research right now"
Kyle: "Totally fair — what questions can I answer for you?"

Customer: "I need to talk to my wife/husband"
Kyle: "Of course. Visit's a great way to do it together so you both see the product and pricing same time. What day works?"

Customer: "Sounds expensive"
Kyle: "Compared to what? Jellyfish? A different quote?"

══ CHRISTMAS LIGHTS QUESTION ══

Customer: "Do you do Christmas lights?"
${isChristmasSeason
  ? `Kyle: "Yep, we do both — temporary Christmas installs Oct-Jan and permanent year-round roofline lights. Which were you thinking?"`
  : `Kyle: "We book Christmas installs starting in October. Honestly though, a lot of folks have moved to our permanent roofline lights — look great for the holidays AND stay up year-round so you never put lights up again. Want to hear about those?"`}

══ AREA / ZIP ══

Customer: "What areas do you cover?"
Kyle: "Most of central Florida. What's your zip?"

Customer: "34711"
Kyle: "We're all over that area. What part of the home are you thinking about?"

══ HANDLING OBJECTIONS ══

Customer: "I'm just doing research right now"
Kyle: "Totally fair. What questions can I answer for you?"

Customer: "Sounds expensive"
Kyle: "I get it — what were you hoping to spend? I might be able to scope something that fits."

Customer: "I need to talk to my wife/husband"
Kyle: "Of course. The visit's actually a great way to do it together — both of you can see the product and pricing at the same time. What's a good day for you guys?"

══ AFTER THEY BOOK ══

Customer: "I picked a time"
Kyle: "Awesome, got it. See you then!"

Customer: "Just booked Tuesday at 4"
Kyle: "Perfect, got you on the calendar. Anything specific you want us to focus on?"

══ TONE RULES ══
- Sound like a real person texting from his truck, NOT a salesman
- Build rapport: ask their name early if you don't know it
- Mirror their energy — short message gets a short reply
- Ask ONE question per message, then SHUT UP and let them respond
- Never stack multiple questions
- Use contractions (we're, I'll, that's, you're)
- Acknowledge what they said before asking the next thing ("Got it" "Cool" "Makes sense" "Nice")
- Skip the appointment pitch until they've shared at least 2 pieces of info (areas + timeline, or budget + areas, etc.)
- NEVER say "I'd be happy to", "Thank you for reaching out", "our team", "our representative"
- If they refuse the visit twice — let it breathe, ask what their hesitation is
- If hostile: drop the sales angle, offer a call
`;

  const systemPrompt = `You are Kyle drafting SMS replies (never identify as an assistant).
Kyle owns two businesses in Florida:
1. Roof Revival LLC — roofing (free inspections, replacements, repairs, estimates)
2. Permanent Roofline Lighting — year-round LED tracks (primary), seasonal Christmas lights (Oct-Jan secondary)

The customer texted the ${businessLine} line.
Customer name: ${customerName}
Today's date: ${today.toDateString()}

${businessLine.includes('LIGHTS') ? `IMPORTANT — LIGHTS LINE CONTEXT:\n${lightsContext}\n` : ''}

${isNew ? 'This is a brand NEW customer with no prior conversation.' : `Conversation so far (most recent at bottom):\n${historyText}`}

${trainingExamples}

YOUR PRIMARY GOAL: Be a master salesperson disguised as a regular human. The goal IS to book the appointment — but the way you get there is by having a real conversation, not by pitching on every reply.

THE GOLDEN RULE — NEVER GIVE A PRICE NUMBER UNTIL THEY'VE PUSHED TWICE:
- The customer asking "how much" is NOT permission to give a number
- ALWAYS pivot to "depends on a lot of variables" + list 2-3 of them + ask a discovery question
- Variables to use: single vs two story, linear feet, front/sides/back/full perimeter, accessibility (ladder vs lift), time of year, peak season demand, roofline complexity
- ONLY give a vague range ("few hundred to several thousand") if they REJECT discovery twice in a row
- NEVER lead with $1,000 or $1,500-$4,000 numbers in the first reply

BIG RULES:
1. NEVER pitch the appointment in the first reply (unless they explicitly ask "when can you come out")
2. NEVER drop a price number unprompted — see GOLDEN RULE above
3. Get their name first if you don't have it (and they didn't sign their message)
4. Acknowledge what they said before asking your next question
5. Suggest the appointment ONLY after you've gathered at least 2-3 pieces of discovery info (area + scope + story + linear feet + timeline — any combo)
6. Match their energy — short message → short reply. Long message → match the warmth.
7. The Calendly link goes in ONE message when it's time to book — don't keep dropping it
8. If they're cold or annoyed, drop the close and just answer their question

THE FOUR SALES MOVES (use these to upgrade replies from good → great):

MOVE 1 — BUILD EXCITEMENT WITH NEIGHBORHOOD VALIDATION:
Once you know their area or zip, drop social proof. Examples:
"Oh nice, we've done a handful over in that area — they always come out looking sharp"
"Awesome, been all over [area] this year"
"Nice, the homes in that neighborhood line up really well with how the lights run"
This builds trust + makes them feel like they're joining something, not buying something.

MOVE 2 — BUNDLE QUESTIONS WHEN THEY PAIR NATURALLY:
Single questions feel like an interrogation. Pair related ones:
GOOD: "Single or two story, and any rough idea on the linear feet?"
BAD: Two separate messages asking each one
GOOD: "What part of town are you in, and what are you picturing — front, sides, full perimeter?"
Still keep replies tight — bundle 2 questions max, never 3+.

MOVE 3 — TIE URGENCY TO THEIR EXACT SITUATION:
When they tell you their timeline, bounce it back as a reason to book NOW:
- They say "soon" → "Perfect, we've got early-install spots where we can do the best on price before things tighten up"
- They say "before holidays" → "Smart move, peak season fills fast and pricing reflects that"
- They say "no rush" → "Cool, that actually works in your favor — early in the year we have more flexibility on scheduling and pricing"
Make the urgency about THEM, not about you.

MOVE 4 — SOFT CLOSE WITH "IF EVERYTHING LOOKS GOOD":
When you drop the Calendly link, frame the appointment as low-stakes with a soft close:
"...we'll measure, walk you through the lights, lock in real pricing. If everything looks good, we can usually get you on the schedule pretty quick."
This subtly suggests booking the install will happen at the appointment without being pushy.

When suggesting an appointment, ALWAYS try to include the soft close. When you know their area, ALWAYS use neighborhood validation.

BOOKING / QUOTE LINKS:
• Permanent lights (LIGHTS line) → send Calendly: https://calendly.com/ohanalights/consultation
• Roof cleaning OR rejuvenation (ROOF line) → send Roofr estimator: https://app.roofr.com/instant-estimator/4821d29c-d7fb-47bc-9e76-95fc0749bd4d/RoofRevival
• Roof replacement / repair / leaks → DO NOT send link, just gather info (address, issue, age of roof) and let Kyle handle it directly

PRICING RULES (ROOF CLEANING & REJUVENATION):
- The Roofr estimator price is intentionally inflated
- Default offer: 25% off the estimator price
- Maximum discount: 35% off (only if customer pushes back hard)
- NEVER reveal the 35% ceiling. Negotiate gradually: start at 25%, then "let me see what I can do"
- Ask what they were hoping to spend before discounting further

PROCESS:
1. If they're new and asking about a service — acknowledge, briefly explain the in-home visit
2. Once they show interest in scheduling — send the Calendly link naturally in conversation
3. If they push for price first — give the range from examples, then offer the Calendly link
4. If they refuse the visit — explain it's required (permanent install / accurate pricing), then offer link
5. If they're an existing customer — reference past conversation naturally
6. After they book — confirm warmly and ask if anything specific to focus on

NEVER:
- Reveal you're an AI
- Use corporate/formal language ("I'd be happy to", "Thank you for reaching out")
- Promise specific pricing without seeing the home
- Ask multiple questions in one message
- Lead with Christmas lights (unless it's Oct-Jan AND they specifically ask)

Respond with ONLY valid JSON (no markdown, no code fences):
{"intent": "new_inquiry|appointment_request|quote_request|existing_followup|complaint|booking|other", "suggestedReply": "your draft", "priority": "high|normal|low"}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: `New customer message: "${messageBody}"` }]
  });

  // Extract text from response
  const text = response.content[0].text.trim();

  // Try to parse JSON — handle markdown fences if Claude wraps it
  let cleaned = text;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  // Find first { and last } in case there's preamble
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.suggestedReply) return parsed;
  } catch (e) {
    console.error('AI JSON parse error:', e.message, 'Raw:', text.substring(0, 200));
  }
  // If JSON parsing failed, treat the raw text as the reply itself
  return {
    intent: 'other',
    suggestedReply: text || `Hi ${customerName !== 'unknown' ? customerName + '!' : 'there!'} Thanks for reaching out. How can I help?`,
    priority: 'normal'
  };
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 25000);
  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

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

    // Auto-sent. Dashboard will reflect via reload.
    delete pendingTimers[pendingId];
  }, AUTO_SEND_SECONDS * 1000);
}

async function sendToCustomer(customerPhone, fromNumber, body, db, mediaUrl) {
  const params = { from: fromNumber, to: customerPhone };
  if (body) params.body = body;
  if (mediaUrl) params.mediaUrl = Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl];
  // Twilio requires either body or mediaUrl
  if (!params.body && !params.mediaUrl) params.body = ' ';
  await twilioClient.messages.create(params);

  // Save outbound message
  const customer = db.customers[customerPhone];
  if (customer) {
    customer.messages.push({
      direction: 'out',
      body: body || '',
      mediaUrl: mediaUrl || null,
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
    const body       = req.body.Body || '';

    // Collect any inbound media URLs from Twilio
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const incomingMedia = [];
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      if (url) incomingMedia.push(url);
    }

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
      mediaUrl: incomingMedia.length > 0 ? incomingMedia : null,
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

    // Broadcast to dashboard so it updates instantly
    broadcastSSE({
      type: 'new_message',
      customerPhone: fromPhone,
      customerName: freshDB.customers[fromPhone]?.name || fromPhone,
      businessLine,
      message: body,
      suggestedReply: ai.suggestedReply
    });

    // Schedule auto-send (notification handled in dashboard via SSE)
    schedulePendingSend(pendingId, freshDB);

  } catch (err) {
    console.error('Inbound error:', err);
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
    const { customerPhone, body, pendingId, mediaUrl } = req.body;
    const db = loadDB();
    const customer = db.customers[customerPhone];
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const fromNumber = customer.line.includes('ROOF') ? ROOF_NUMBER : LIGHTS_NUMBER;
    if (pendingId && pendingTimers[pendingId]) { clearTimeout(pendingTimers[pendingId]); delete pendingTimers[pendingId]; }
    await sendToCustomer(customerPhone, fromNumber, body, loadDB(), mediaUrl);
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

app.all('/webhook/call-bridge', (req, res) => {
  // Helper: pick first value if Express gave us an array (duplicate query+body)
  const pick = v => Array.isArray(v) ? v[0] : (v || '');

  // Get raw values, handling potential array from Express merging query+body
  let toRaw = pick(req.query.to) || pick(req.body?.to) || '';
  let fromRaw = pick(req.query.from) || pick(req.body?.from) || '';

  // Convert space back to + (URL form encoding decodes + as space)
  let to = String(toRaw).replace(/ /g, '+');
  let from = String(fromRaw).replace(/ /g, '+');

  // Sanitize: keep only digits, then prepend single +
  to = to.replace(/[^\d]/g, '');
  from = from.replace(/[^\d]/g, '');
  if (to) to = '+' + to;
  if (from) from = '+' + from;

  console.log('[call-bridge] FINAL', JSON.stringify({to, from, rawQuery: req.query, rawBody: req.body}));

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Connecting you now.');
  const dial = twiml.dial({
    callerId: from,
    timeout: 30,
    action: '/webhook/call-bridge-done',
    method: 'POST'
  });
  dial.number(to);
  const xml = twiml.toString();
  console.log('[call-bridge] TwiML output:', xml);
  res.type('text/xml').send(xml);
});

// When the bridged call ends — hang up cleanly, no fallback
app.all('/webhook/call-bridge-done', (req, res) => {
  console.log('[call-bridge-done]', JSON.stringify({
    DialCallStatus: req.body?.DialCallStatus,
    DialCallDuration: req.body?.DialCallDuration,
    CallStatus: req.body?.CallStatus
  }));
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── INBOUND VOICE: Ring Kyle 7s, if no answer go to VAPI ─────────────────────
const VAPI_NUMBER = '+13526489684';

app.all('/webhook/voice-inbound', (req, res) => {
  // Customer called Roof or Lights number → ring Kyle for 7s with action callback
  const toNumber = req.body?.To || req.query?.To || '';
  const callerNumber = req.body?.From || req.query?.From || '';

  console.log('[voice-inbound]', JSON.stringify({ toNumber, callerNumber }));

  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial({
    timeout: 7,
    callerId: toNumber, // show Twilio biz number on Kyle's screen
    action: '/webhook/voice-after-kyle?caller=' + encodeURIComponent(callerNumber),
    method: 'POST'
  });
  dial.number(KYLE_PHONE);
  res.type('text/xml').send(twiml.toString());
});

// After Kyle dial: if he answered, hang up everyone. If no answer, go to VAPI.
app.all('/webhook/voice-after-kyle', (req, res) => {
  const dialStatus = req.body?.DialCallStatus || '';
  const caller = req.query?.caller || req.body?.caller || '';

  console.log('[voice-after-kyle]', JSON.stringify({ dialStatus, caller }));

  const twiml = new twilio.twiml.VoiceResponse();

  // If Kyle answered the call, just hang up (the dial already ended naturally)
  if (dialStatus === 'completed' || dialStatus === 'answered') {
    twiml.hangup();
  } else {
    // Kyle didn't answer (no-answer, busy, failed) — forward to VAPI
    // Pass the original caller number through callerId so VAPI sees who's calling
    const dial = twiml.dial({ callerId: caller });
    dial.number(VAPI_NUMBER);
  }

  res.type('text/xml').send(twiml.toString());
});

// API: send new SMS to any number
app.post('/api/new-sms', async (req, res) => {
  try {
    const { toPhone, body, fromNumber, mediaUrl } = req.body;
    let phone = toPhone.replace(/\D/g,'');
    if (phone.length === 10) phone = '+1' + phone;
    else if (!phone.startsWith('+')) phone = '+' + phone;
    const isRoof = fromNumber === ROOF_NUMBER;
    const businessLine = isRoof ? '🏠 ROOF (352)' : '💡 LIGHTS (321)';
    const db = loadDB();
    if (!db.customers[phone]) {
      db.customers[phone] = { phone, name: null, line: businessLine, firstContact: new Date().toISOString(), lastContact: new Date().toISOString(), messages: [] };
    }
    await sendToCustomer(phone, fromNumber, body, db, mediaUrl);
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

// ── PWA: service worker (enables true PWA install on iOS + background notifs) ───
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
const CACHE_NAME = 'smshub-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Receive push messages and show notifications
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) { data = { title: 'New SMS', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'New SMS';
  const opts = {
    body: data.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.tag || 'sms',
    data: { url: data.url || '/' },
    requireInteraction: false
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// When user taps the notification, open/focus the dashboard
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Pass-through fetch handler so iOS recognizes this as a real PWA
self.addEventListener('fetch', (e) => {
  // Don't intercept API/webhook requests — let them go straight to network
  // We just need this listener to exist for iOS to treat us as a proper PWA
});
  `);
});

// ── PWA: manifest + icon ─────────────────────────────────────────────────────
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Roof Revival SMS',
    short_name: 'SMS Hub',
    description: 'SMS dashboard for Roof Revival & Christmas Lights',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f0f23',
    theme_color: '#6c63ff',
    orientation: 'portrait',
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/icon.png', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }
    ]
  });
});

app.get('/icon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="100" fill="#6c63ff"/><text x="50%" y="55%" font-size="280" text-anchor="middle" dominant-baseline="middle" font-family="system-ui">📱</text></svg>`);
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
    // Build a search blob with name + phone + line + preview for fast client-side filter
    const searchBlob = ((c.name||'') + ' ' + (c.phone||'') + ' ' + (c.line||'') + ' ' + preview).toLowerCase();
    return `
    <div class="crow" data-search="${searchBlob.replace(/"/g,'')}" onclick="location='/customer/${encodeURIComponent(c.phone)}'">
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
  }).join('') || '<div class="empty" id="emptyState">No messages yet</div>';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="SMS Hub">
<title>SMS Hub</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SMS Hub">
<meta name="theme-color" content="#0f0f23">
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
<div style="margin:0 16px 10px;display:flex;gap:8px;align-items:center">
  <input id="searchBox" type="search" placeholder="Search by name, phone, or message…" style="flex:1;padding:10px 14px;border:1px solid #2e2e55;background:#1a1a35;color:#e8e8ff;border-radius:10px;font-size:14px;outline:none" oninput="filterCustomers(this.value)">
  <button id="notifBtn" onclick="enableNotifs()" style="background:#6c63ff;color:#fff;border:none;border-radius:10px;padding:10px 14px;font-size:13px;cursor:pointer;white-space:nowrap;display:none">🔔 Enable Alerts</button>
</div>
<div id="noResults" style="display:none;text-align:center;padding:20px;color:#8888aa">No matches found</div>
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
// Register service worker (needed for iOS to recognize us as a real PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW registration failed:', err));
  });
}

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

// ─── Search ────────────────────────────────────────────────────────────────
function filterCustomers(query) {
  const q = (query || '').toLowerCase().trim();
  const rows = document.querySelectorAll('.crow');
  let visible = 0;
  rows.forEach(r => {
    const blob = r.getAttribute('data-search') || '';
    if (!q || blob.includes(q)) { r.style.display = ''; visible++; }
    else { r.style.display = 'none'; }
  });
  const noRes = document.getElementById('noResults');
  if (noRes) noRes.style.display = (q && visible === 0) ? 'block' : 'none';
}

// ─── Notifications ─────────────────────────────────────────────────────────
function updateNotifButton() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (!('Notification' in window)) { btn.style.display = 'none'; return; }
  if (Notification.permission === 'granted') {
    btn.style.display = 'none';
  } else if (Notification.permission === 'denied') {
    btn.textContent = '🔕 Alerts Blocked';
    btn.style.background = '#666';
    btn.style.display = 'inline-block';
    btn.disabled = true;
    btn.title = 'You blocked notifications. Reset in Settings → Notifications.';
  } else {
    btn.textContent = '🔔 Enable Alerts';
    btn.style.background = '#6c63ff';
    btn.style.display = 'inline-block';
    btn.disabled = false;
  }
}

async function enableNotifs() {
  if (!('Notification' in window)) { showToast('Your browser does not support notifications'); return; }
  if (Notification.permission === 'denied') {
    showToast('Notifications were blocked. Reset in browser/iOS Settings.');
    return;
  }
  const result = await Notification.requestPermission();
  if (result === 'granted') {
    showToast('🔔 Notifications enabled!');
    // Fire a test notification so user sees it works
    try {
      const n = new Notification('SMS Hub', { body: 'Notifications are working!', icon: '/icon.png' });
      setTimeout(()=>n.close(), 4000);
    } catch(e) {}
  } else if (result === 'denied') {
    showToast('Notifications blocked');
  }
  updateNotifButton();
}

// Run on load
updateNotifButton();
// Also offer the prompt on first interaction (some browsers require gesture)
['click','touchstart','keydown'].forEach(ev => {
  document.addEventListener(ev, () => {
    if ('Notification' in window && Notification.permission === 'default') {
      // Don't auto-prompt anymore; just keep the button visible. Re-check.
      updateNotifButton();
    }
  }, {once: true});
});

// ─── Real-time updates via SSE ─────────────────────────────────────────────
let evtSource = null;
let connectAttempts = 0;

function connectSSE() {
  if (evtSource) try { evtSource.close(); } catch(e) {}
  evtSource = new EventSource('/api/events');

  evtSource.onopen = () => { connectAttempts = 0; };

  evtSource.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'new_message') {
        // Browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            const n = new Notification(d.businessLine || 'New SMS', {
              body: (d.customerName || 'Unknown') + ': ' + (d.message || '(media)'),
              icon: '/icon.png',
              badge: '/icon.png',
              tag: d.customerPhone,
              requireInteraction: false
            });
            n.onclick = () => { window.focus(); n.close(); };
          } catch(err) { console.error('notif error', err); }
        }
        // Soft beep
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = 880; g.gain.value = 0.1;
          o.start(); o.stop(ctx.currentTime + 0.15);
        } catch(e) {}
        // Reload after a longer delay so the notification has time to show on iOS
        setTimeout(() => location.reload(), 1500);
      }
    } catch(e) { console.error(e); }
  };

  evtSource.onerror = () => {
    connectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, connectAttempts), 30000);
    setTimeout(connectSSE, delay);
  };
}
connectSSE();

// Fallback reload every 90s (in case SSE disconnects silently — increased to give SSE more time)
setInterval(() => {
  // Only reload if the search box is empty — don't disrupt search-in-progress
  const sb = document.getElementById('searchBox');
  if (!sb || !sb.value) location.reload();
}, 90000);

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

  const messages = customer.messages.map(m => {
    let mediaHtml = '';
    if (m.mediaUrl) {
      const urls = Array.isArray(m.mediaUrl) ? m.mediaUrl : [m.mediaUrl];
      mediaHtml = urls.map(url => {
        const lower = (url || '').toLowerCase();
        // Try image first (covers most uploads + Twilio's default for images even without extension)
        const looksImage = lower.match(/\.(jpg|jpeg|png|gif|webp)($|\?)/) || lower.includes('mediacontenttype=image') || lower.includes('twilio.com/');
        const looksVideo = lower.match(/\.(mp4|mov|webm)($|\?)/);
        if (looksVideo) {
          return `<video src="${url}" controls style="max-width:100%;border-radius:8px;display:block;margin-bottom:6px"></video>`;
        } else if (looksImage) {
          return `<a href="${url}" target="_blank"><img src="${url}" style="max-width:100%;border-radius:8px;display:block;margin-bottom:6px" onerror="this.replaceWith(Object.assign(document.createElement('a'),{href:'${url}',target:'_blank',textContent:'📎 Attachment'}))"></a>`;
        } else {
          return `<a href="${url}" target="_blank" style="display:block;margin-bottom:6px">📎 Attachment</a>`;
        }
      }).join('');
    }
    const bodyHtml = m.body ? `<div>${m.body}</div>` : '';
    return `
    <div class="msg ${m.direction}">
      <div class="bubble">${mediaHtml}${bodyHtml}</div>
      <div class="time">${new Date(m.timestamp).toLocaleString()}</div>
    </div>`;
  }).join('');

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
  <div id="mediaPreview" style="padding:8px 24px;background:#f0f4ff;border-top:1px solid #eee;display:none;align-items:center;gap:12px">
    <img id="mediaPreviewImg" style="max-width:80px;max-height:80px;border-radius:6px;display:none">
    <video id="mediaPreviewVid" style="max-width:120px;max-height:80px;border-radius:6px;display:none" controls></video>
    <span id="mediaPreviewName" style="font-size:13px;color:#666"></span>
    <button onclick="removeMedia()" style="margin-left:auto;background:#e53e3e;color:white;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer">✕ Remove</button>
  </div>
  <div class="reply-box">
    <input type="file" id="mediaInput" accept="image/*,video/mp4,video/quicktime,image/gif" style="display:none" onchange="handleMediaSelect(this)">
    <button onclick="document.getElementById('mediaInput').click()" style="background:#f0f4ff;color:#1a1a2e;border:1px solid #ddd;border-radius:8px;padding:10px 14px;cursor:pointer;font-size:18px" title="Attach photo/video/GIF">📎</button>
    <textarea id="replyText" placeholder="Type a reply…"></textarea>
    <button id="sendBtn" onclick="sendReply()">Send</button>
  </div>
  <script>
    document.querySelector('.messages').scrollTop = 999999;
    let pendingMediaUrl = null;

    async function handleMediaSelect(input) {
      const file = input.files[0];
      if (!file) return;
      // Show preview
      const preview = document.getElementById('mediaPreview');
      const img = document.getElementById('mediaPreviewImg');
      const vid = document.getElementById('mediaPreviewVid');
      const name = document.getElementById('mediaPreviewName');
      preview.style.display = 'flex';
      name.textContent = 'Uploading ' + file.name + '…';
      img.style.display = 'none';
      vid.style.display = 'none';

      const reader = new FileReader();
      reader.onload = (e) => {
        if (file.type.startsWith('image/')) { img.src = e.target.result; img.style.display = 'block'; }
        else if (file.type.startsWith('video/')) { vid.src = e.target.result; vid.style.display = 'block'; }
      };
      reader.readAsDataURL(file);

      // Upload to server
      const fd = new FormData();
      fd.append('file', file);
      try {
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        const d = await r.json();
        if (d.ok) {
          pendingMediaUrl = d.url;
          name.textContent = '✓ Ready to send: ' + file.name;
        } else {
          name.textContent = '❌ Upload failed';
          pendingMediaUrl = null;
        }
      } catch(e) {
        name.textContent = '❌ Upload error';
        pendingMediaUrl = null;
      }
    }

    function removeMedia() {
      pendingMediaUrl = null;
      document.getElementById('mediaPreview').style.display = 'none';
      document.getElementById('mediaInput').value = '';
    }

    async function sendReply() {
      const text = document.getElementById('replyText').value.trim();
      if (!text && !pendingMediaUrl) return;
      const btn = document.getElementById('sendBtn'); btn.textContent='Sending…'; btn.disabled=true;
      await fetch('/customer/${encodeURIComponent(phone)}/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({body: text, mediaUrl: pendingMediaUrl})
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
  await sendToCustomer(phone, fromNumber, req.body.body, db, req.body.mediaUrl);
  res.json({ ok: true });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SMS AI running on port ${PORT}`));
