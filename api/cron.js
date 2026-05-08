import fs from 'fs/promises';
import https from 'https';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import Groq from 'groq-sdk';
import { transporter, testConfig } from '../node-mailer-config.js';

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LANDING_PAGE_URL = 'https://umard3v.vercel.app';
const FROM_EMAIL = 'marzaiagency@outlook.com';

const groq = new Groq({ apiKey: GROQ_API_KEY });

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

async function getSentToday() {
    try {
        const log = await fs.readFile('sent_log.json', 'utf8');
        const today = new Date().toISOString().split('T')[0];
        return JSON.parse(log).filter(s => s.date === today);
    } catch { return []; }
}

async function markSent(email) {
    const log = { email, date: new Date().toISOString().split('T')[0], timestamp: Date.now() };
    let logs = [];
    try { logs = JSON.parse(await fs.readFile('sent_log.json', 'utf8')); } catch { }
    logs.push(log);
    await fs.writeFile('sent_log.json', JSON.stringify(logs));
}

async function generateSmartPitch(agency) {
    const systemPrompt = `You are Umar, CTO of MARZAI Agency. Pitch AI landing pages. 5 sentences max. JSON output only.`;
    const completion = await groq.chat.completions.create({
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Agency: ${agency.name}` }],
        model: 'llama-3.1-70b-versatile',
    });
    const content = completion.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    return { subject: parsed.subject, body: parsed.body };
}

async function sendTelegram(summary, isTest = false) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const message = `🚀 *Daily Outreach*\n📍 City: ${summary.city}\n✅ Sent: ${summary.sent}`;
    const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });
    return new Promise(res => {
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        }, res);
        req.write(data); req.end();
    });
}

// Test endpoint
export default async function handler(req, res) {
    const isTest = req.query.test === '1';

    // Test SMTP first
    const smtpOk = await testConfig();
    if (!smtpOk && !isTest) {
        return res.status(500).json({ error: 'SMTP not configured' });
    }

    const out = await runCron(isTest);
    res.json({
        success: true,
        smtp: smtpOk,
        count: out.length,
        sent: out.filter(o => o.send_result?.sent).length
    });
}

// Replace generateSmartPitch + add sendEmail
// Replace SendGrid section with:
async function sendEmail(agency, pitch) {
    const mailOptions = {
        from: `"Umar | MARZAI Agency" <${FROM_EMAIL}>`,
        to: agency.email,
        subject: pitch.subject,
        html: pitch.body.replace(/\n/g, '<br>') + `<br><br>${LANDING_PAGE_URL}`,
        text: pitch.body,
        headers: {
            'List-Unsubscribe': '<mailto:unsubscribe@marzaiagency.com>',
            'X-Mailer': 'MARZAI Cron v1.0'
        }
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ ${agency.name} → ${agency.email} [${info.messageId}]`);
    return { sent: true, messageId: info.messageId };
}
// Enhanced runCron - FULL AUTONOMY
async function runCron(isTest = false) {
    const data = await loadData();
    const sentToday = await getSentToday();
    const keywords = ['real estate', 'property', 'realtor', 'agent'];
    const limit = isTest ? 1 : 10;

    // Rotate cities weekly (scale beyond Houston)
    const cities = ['Houston', 'Dallas', 'Austin', 'San Antonio'];
    const city = cities[new Date().getDay() % cities.length];

    const agencies = data
        .filter(row => row.city === city && keywords.some(kw => row.category?.toLowerCase().includes(kw)))
        .map(row => ({ ...row, googlestars: parseFloat(row.googlestars) || 0 }))
        .sort((a, b) => b.googlestars - a.googlestars)
        .filter(a => !sentToday.some(s => s.email === a.email))
        .slice(0, limit);

    const outreach = [];
    let sentCount = 0;

    for (const agency of agencies) {
        const pitch = await generateSmartPitch(agency);
        const full = { ...agency, ...pitch };

        const result = isTest ? { sent: true } : await sendEmail(agency, pitch);
        full.send_result = result;

        if (result.sent) {
            sentCount++;
            if (!isTest) await markSent(agency.email);
        }

        outreach.push(full);
    }

    // Files for backup/n8n
    await fs.writeFile(`outreach_${city.toLowerCase()}.csv`, stringify(outreach, { header: true }));
    await fs.writeFile('sent_log.json', JSON.stringify(await getSentToday()));

    const summary = {
        count: outreach.length,
        sent: sentCount,
        city,
        top: outreach[0],
        samples: outreach.slice(0, 2)
    };
    await sendTelegram(summary, isTest);

    console.log(`✅ ${city}: ${sentCount}/${limit} sent, ${outreach.length} generated`);
    return outreach;
}