import fs from 'fs/promises';
import https from 'https';
import { parse } from 'csv-parse/sync';
import Groq from 'groq-sdk';
import { transporter, testConfig } from '../node-mailer-config.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LANDING_PAGE_URL = 'https://umard3v.vercel.app';
const FROM_EMAIL = 'aa9dac001@smtp-brevo.com'; // Must be Brevo-verified

const groq = new Groq({ apiKey: GROQ_API_KEY });

async function loadData() {
    try {
        return parse(await fs.readFile('Agency-Owners-All-US-Markets.csv', 'utf8'), { columns: true, skip_empty_lines: true });
    } catch {
        return new Promise(res => {
            https.get('https://cron-job-marzaiagency.vercel.app/Agency-Owners-All-US-Markets.csv', r => {
                let data = ''; r.on('data', d => data += d);
                r.on('end', () => res(parse(data, { columns: true, skip_empty_lines: true })));
            });
        });
    }
}

// In-memory (Vercel stateless)
let sentTodayCache = [];
const getSentToday = () => sentTodayCache;
const markSent = email => sentTodayCache.push({ email, date: new Date().toISOString().split('T')[0] });

async function generateSmartPitch(agency) {
    const prompt = `Umar, CTO of MARZAI Agency. Pitch: We build high-conversion landing pages for real estate that turn visitors into leads/clients the moment they land. NO mention of "AI", "automation", or tech stacks. Focus on conversion results and lead generation. JSON: {"subject":"...", "body":"..."}. Max 5 sentences. Link: ${LANDING_PAGE_URL}`;
    const completion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify(agency) }],
        model: 'llama-3.1-70b-versatile', max_tokens: 250, temperature: 0.7
    });

    const content = completion.choices[0].message.content.match(/\{[\s\S]*\}/)?.[0] || '{}';
    const { subject = 'Question regarding your visitor conversion', body = 'Hi! I was looking at your site and wanted to show you how we turn more visitors into clients.' } = JSON.parse(content);
    return { subject, body };
}

async function sendEmail(agency, pitch) {
    try {
        const info = await transporter.sendMail({
            from: `"Umar | MARZAI" <${FROM_EMAIL}>`,
            to: agency.email,
            subject: pitch.subject,
            html: pitch.body.replace(/\n/g, '<br>') + `<br><br>${LANDING_PAGE_URL}`,
            headers: { 'List-Unsubscribe': '<mailto:unsubscribe@marzaiagency.com>' }
        });
        console.log(`✅ BREVO: ${agency.name}`);
        markSent(agency.email);
        return { sent: true, messageId: info.messageId };
    } catch (e) {
        console.error(`❌ BREVO ${agency.email}:`, e.message);
        return { sent: false, error: e.message };
    }
}

async function sendTelegram(summary, isTest) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const msg = `${isTest ? '🧪' : '🚀'} BREVO CRON\n${new Date().toDateString()}\n\n` +
        `City: ${summary.city}\nSent: ${summary.sent}/${summary.count}\n` +
        `${summary.samples.map(s => `• ${s.name.slice(0, 20)}`).join('\n')}`;

    https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`,
        method: 'POST'
    }).end();
}

async function runCron(isTest) {
    sentTodayCache = [];
    const data = await loadData();
    const keywords = ['real estate', 'property', 'realtor', 'agent'];
    const cities = ['Chicago', 'Houston', 'Austin', 'San Francisco', 'Denver'];
    const city = cities[new Date().getDay() % cities.length];
    const limit = isTest ? 1 : 10;

    console.log(`Targeting City: ${city}`);

    const agencies = data
        .filter(row => {
            const rowCity = (row.city || row.City || "").trim().toLowerCase();
            const rowCategory = (row.category || row.Category || "").toLowerCase();
            return rowCity === city.toLowerCase() && keywords.some(kw => rowCategory.includes(kw));
        })
        .map(row => ({ ...row, googlestars: parseFloat(row.googlestars) || 0 }))
        .sort((a, b) => b.googlestars - a.googlestars)
        .filter(a => !sentTodayCache.some(s => s.email === a.email))
        .slice(0, limit);

    const outreach = [];
    for (const agency of agencies) {
        const pitch = await generateSmartPitch(agency);
        const result = await sendEmail(agency, pitch);
        outreach.push({ ...agency, ...pitch, send_result: result });
    }

    const summary = {
        count: outreach.length,
        sent: outreach.filter(o => o.send_result.sent).length,
        city,
        top: outreach[0],
        samples: outreach.slice(0, 3)
    };
    await sendTelegram(summary, isTest);
    return { outreach, city };
}

export default async function handler(req, res) {
    const isTest = req.query.test === '1';
    const smtpOk = await testConfig();

    if (!smtpOk && !isTest)
        return res.status(500).json({ error: 'Brevo SMTP_KEY missing' });

    const { outreach, city } = await runCron(isTest);
    res.json({
        success: true,
        brevo: smtpOk ? '300/day OK' : 'Config error',
        sent: outreach.filter(r => r.send_result.sent).length,
        total: outreach.length,
        city: city
    });
}