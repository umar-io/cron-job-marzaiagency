import nodemailer from 'nodemailer';

// 🔧 CONFIG: Pick ONE free provider (uncomment)
export const transporter = nodemailer.createTransport({
    // ✅ SMTP2GO (1,000/mo FREE - RECOMMENDED)
    //   host: 'mail.smtp2go.com',
    //   port: 587,
    //   secure: false, // true for 465
    //   auth: {
    //     user: process.env.SMTP2GO_USER,     // yourusername@smtp2go.com
    //     pass: process.env.SMTP2GO_PASS     // your-password
    //   },

    // Brevo (300/day FREE)
    host: 'smtp-relay.brevo.com',
    port: 587,
    auth: {
        user: 'marzaiagency@outlook.com',
        pass: process.env.BREVO_SMTP_KEY
    },
    /*
    // Mailjet (200/day FREE)  
    host: 'in-v3.mailjet.com',
    port: 587,
    auth: {
      user: process.env.MAILJET_PUBLIC_KEY,
      pass: process.env.MAILJET_SECRET_KEY
    }
    */
});

// Test connection
export async function testConfig() {
    try {
        await transporter.verify();
        console.log('✅ SMTP Connected!');
        return true;
    } catch (err) {
        console.error('❌ SMTP Error:', err);
        return false;
    }
}