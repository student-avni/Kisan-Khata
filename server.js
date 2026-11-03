require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DB = path.join(__dirname, 'data.json');

// ---------- tiny storage ----------
const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const save = rows => fs.writeFileSync(DB, JSON.stringify(rows, null, 2));

function balances(rows) {
  const b = {};
  for (const r of rows) {
    b[r.customer] = (b[r.customer] || 0) + (r.type === 'udhaar' ? r.amount : -r.amount);
  }
  return b;
}
const totalDue = rows => Object.values(balances(rows)).reduce((a, x) => a + Math.max(x, 0), 0);

// ---------- AI: speech text -> JSON ----------
async function understand(text) {
  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const system = `You are the brain of a Hindi voice ledger for an agriculture shop owner in India.
The user speaks Hindi/English mix (may be written in Devanagari or Roman). Today is ${now.toISOString().slice(0,10)} (${days[now.getDay()]}).
Return ONLY JSON with these keys:
- intent: "udhaar" (gave goods on credit / customer owes money), "payment" (customer paid money), "query" (asking how much a customer owes), "briefing" (asking who to collect money from today / overall summary), or "unknown"
- customer: name in the same script as spoken, or null
- item: what was sold (e.g. "20 bag khad"), or null
- amount: number in rupees (for udhaar = amount pending; for payment = amount paid), or null
- remind_on: YYYY-MM-DD if user asks to remind/collect on some day, else null
Convert Hindi number words to digits (e.g. "आठ हज़ार" = 8000). Never invent values.`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'AI error');
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

// ---------- action + Hindi reply ----------
const rs = n => '₹' + Number(n).toLocaleString('en-IN');

function act(u, rows) {
  const today = new Date().toISOString().slice(0, 10);

  if (u.intent === 'udhaar' && u.customer && u.amount) {
    rows.push({ id: Date.now(), type: 'udhaar', customer: u.customer, item: u.item, amount: u.amount, date: today, remind_on: u.remind_on });
    const bal = balances(rows)[u.customer];
    let reply = `${u.customer} के नाम ${rs(u.amount)} लिख लिया। कुल बाकी ${rs(bal)}।`;
    if (u.remind_on) reply += ` ${u.remind_on} को याद दिलाऊँगा।`;
    return { rows, reply, changed: true };
  }
  if (u.intent === 'payment' && u.customer && u.amount) {
    rows.push({ id: Date.now(), type: 'payment', customer: u.customer, item: null, amount: u.amount, date: today, remind_on: null });
    const bal = balances(rows)[u.customer];
    return { rows, reply: `${u.customer} से ${rs(u.amount)} मिल गए। अब ${rs(bal)} बाकी है।`, changed: true };
  }
  if (u.intent === 'query' && u.customer) {
    const b = balances(rows);
    const key = Object.keys(b).find(k => k.toLowerCase() === u.customer.toLowerCase());
    return { rows, reply: key ? `${key} का ${rs(Math.max(b[key], 0))} बाकी है।` : `${u.customer} का कोई हिसाब नहीं मिला।`, changed: false };
  }
  if (u.intent === 'briefing') {
    const b = balances(rows);
    const owing = Object.entries(b).filter(([, v]) => v > 0);
    const due = rows.filter(r => r.remind_on && r.remind_on <= today && b[r.customer] > 0).map(r => r.customer);
    if (!owing.length) return { rows, reply: 'आज किसी से पैसा लेना बाकी नहीं है।', changed: false };
    let reply = `कुल ${owing.length} लोगों से ${rs(totalDue(rows))} लेना है।`;
    const dueUnique = [...new Set(due)];
    if (dueUnique.length) reply += ` आज ${dueUnique.join(', ')} से माँगना है।`;
    return { rows, reply, changed: false };
  }
  return { rows, reply: 'माफ़ कीजिए, समझ नहीं आया। दोबारा बोलिए।', changed: false };
}

// ---------- routes ----------
app.post('/api/talk', async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty text' });
    const u = await understand(text);
    const out = act(u, load());
    if (out.changed) save(out.rows);
    res.json({ understood: u, reply: out.reply, ledger: balances(out.rows), total: totalDue(out.rows) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ledger', (req, res) => {
  const rows = load();
  res.json({ ledger: balances(rows), total: totalDue(rows) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kisan Khata running on http://localhost:' + PORT));