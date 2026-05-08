import fs from 'fs/promises';
import https from 'https';
import { parse } from 'csv-parse/sync'; // npm i csv-parse csv-stringify @groq-sdk/groq-sdk
import { stringify } from 'csv-stringify/sync';
import Groq from '@groq-sdk/groq-sdk'; // npm i @groq-sdk/groq-sdk

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LANDING_PAGE_URL = 'https://umard3v.vercel.app'; // Replace!
const SENDER_EMAIL = 'marzaiagency@outlook.com'; // Your from email

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Load CSV (Vercel public or local)
async function loadData(csvPath = 'Agency-Owners-All-US-Markets.csv') {
    let csv;
    try {
        csv = await fs.readFile(csvPath, 'utf8');
    } catch {
        csv = await new Promise((res) => {
            https.get('https://cron-job-marzaiagency.vercel.app/Agency-Owners-All-US-Markets.csv', (r) => {
                let data = ''; r.on('data', d => data += d); r.on('end', () => res(data));
            });
        });
    }
    return parse(csv, { columns: true, skip_empty_lines: true });
}

// Track sent (persistent state via Vercel KV or file)
async function getSentToday() {
    try {
        const log = await fs.readFile('sent_log.json', 'utf8');
        const today = new Date().toISOString().split('T')[0];
        return JSON.parse(log).filter(s => s.date === today);
    } catch {
        return [];
    }
}

async function markSent(email) {
    const log = { email, date: new Date().toISOString().split('T')[0], timestamp: Date.now() };
    let logs = [];
    try {
        logs = JSON.parse(await fs.readFile('sent_log.json', 'utf8'));
    } catch { }
    logs.push(log);
    await fs.writeFile('sent_log.json', JSON.stringify(logs));
}

// AI Pitch Generator (Groq Llama3.1-70B—fast/cheap)
async function generateSmartPitch(agency) {
    const systemPrompt = `You are Umar, CTO of MARZAI Agency, a solo AI sales machine targeting US real estate agencies.

CRITICAL RULES:
- SHORT: Subject <60 chars, Body <150 words (5 sentences max)
- PERSONAL: Use agency name, city, stars, category. Sound excited/human.
- VALUE: Pitch AI landing page + n8n workflow = "2x leads, automated follow-ups"
- URGENT: "Quick 5-min demo today?"
- SIGN: "Umar (CTO) | MARZAI Agency | ${LANDING_PAGE_URL}"
- NO FLUFF: Delete generic phrases. End with clear CTA.
- TONE: Confident, helpful, not salesy.

INPUT: ${JSON.stringify(agency)}`;

    const completion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Generate email subject + body only in JSON: {subject: "...", body: "..."}' }],
        model: 'llama-3.1-70b-versatile',
        max_tokens: 300,
        temperature: 0.7
    });

    // Robust parsing: extract JSON from potential markdown blocks
    const content = completion.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    const subject = parsed.subject || 'Quick question regarding your agency';
    const body = parsed.body || 'Hi, I saw your great reviews in Houston and wanted to reach out.';

    return { subject, body, status: 'AI-Generated', sent_date: new Date().toISOString().split('T')[0] };
}

// Filter + select 10 new daily
function selectDailyAgencies(data, sentToday, limit = 10) {
    const keywords = ['real estate', 'property', 'realtor', 'agent'];
    const candidates = data
        .filter(row => row.city === 'Houston' && keywords.some(kw => row.category?.toLowerCase().includes(kw)))
        .map(row => ({ ...row, googlestars: parseFloat(row.googlestars) || 0 }))
        .sort((a, b) => b.googlestars - a.googlestars)
        .filter(a => !sentToday.some(s => s.email === a.email)); // Skip sent today

    return candidates.slice(0, limit);
}

// Telegram notifier
async function sendTelegram(summary, isTest = false) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const prefix = isTest ? "🧪 *TEST MODE*\n" : "🚀 *Daily Outreach*\n";
    const message = `${prefix}#${new Date().toDateString()}\n\n✅ *${summary.count}* AI pitches generated\n💰 Top: ${summary.top?.name} (${summary.top?.googlestars}⭐)\n📊 n8n ready: houston_outreach.csv\n\n${summary.samples.slice(0, 3).map(s => `• ${s.name}`).join('\n')}`;
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });
    return new Promise(res => {
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, res);
        req.write(data); req.end();
    });
}

// Autonomous Cron (10/day scaling)
async function runCron(isTest = false) {
    const data = await loadData();
    const sentToday = await getSentToday();
    const agencies = selectDailyAgencies(data, sentToday, isTest ? 1 : 10);

    const outreach = [];
    for (const agency of agencies) {
        const pitch = await generateSmartPitch(agency);
        const full = { ...agency, ...pitch };
        outreach.push(full);
        if (!isTest) {
            await markSent(agency.email); // Log immediately
        }
    }

    await fs.writeFile('houston_outreach.csv', stringify(outreach, { header: true }));
    await fs.writeFile('houston_outreach.json', JSON.stringify(outreach, null, 2));

    const summary = {
        count: outreach.length,
        top: outreach[0],
        samples: outreach.slice(0, 3)
    };
    await sendTelegram(summary, isTest);

    console.log(`✅ Cron: ${outreach.length}/10 Houston agencies processed`);
    return outreach;
}

// Vercel API: vercel.json crons: [{"path":"/api/cron","schedule":"0 9 * * 1-5"}]
export default async function handler(req, res) {
    const isTest = req.query.test === '1';
    if (req.method === 'POST' || req.query.manual || isTest) {
        const out = await runCron(isTest);
        res.json({ success: true, count: out.length });
    } else {
        res.status(405).json({ error: 'POST /?manual=1' });
    }
}

if (process.env.NODE_ENV !== 'production') {
    runCron().catch(console.error);
}