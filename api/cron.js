
const FROM_EMAIL = 'marzaiagency@outlook.com';

// Your existing imports + config
import { transporter, testConfig } from '../config/nodemailer-config.js';

// Replace sendEmail:



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
    from: '"Umar | MARZAI Agency" <marzaiagency@outlook.com>',
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