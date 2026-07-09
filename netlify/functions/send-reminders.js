/**
 * send-reminders.js - Pre-clean appointment reminder
 *
 * Scheduled: 0 16 * * * (9 AM PDT)
 * Sends a reminder email for every booking scheduled for tomorrow.
 * Includes appointment details, access instructions, and cancellation policy.
 *
 * Required env var: GMAIL_APP_PASSWORD (see netlify/functions/_mailer.js)
 */

'use strict';
const admin        = require('firebase-admin');
const { sendEmail, wrap } = require('./_mailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

exports.handler = async () => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr     = tomorrow.toISOString().split('T')[0];
    const displayDate = tomorrow.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });

    const snap = await db.collection('bookings').where('date', '==', dateStr).get();
    if (snap.empty) {
      console.log('No bookings tomorrow -- no reminders sent.');
      return { statusCode: 200, body: 'No bookings tomorrow.' };
    }

    const results = await Promise.all(snap.docs.map(async doc => {
      const b         = doc.data();
      const firstName = (b.name || 'there').split(' ')[0];
      const address   = b.address + (b.unit && b.unit !== 'N/A' ? `, Unit ${b.unit}` : '');

      const html = wrap(`
        <h1 style="margin:0 0 6px;color:#1A1A1A;font-size:22px;font-weight:700;letter-spacing:-0.4px;">See you tomorrow, ${firstName}!</h1>
        <p style="margin:0 0 28px;color:#5A5A5A;font-size:15px;">Here are the details for your upcoming clean.</p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#F9F7F4;border:1px solid #e5e7eb;border-radius:10px;margin:0 0 24px;">
          <tr>
            <td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;">
              <span style="display:block;color:#9ca3af;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px;">Service</span>
              <span style="color:#1A1A1A;font-size:15px;font-weight:500;">${b.service}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;">
              <span style="display:block;color:#9ca3af;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px;">Date &amp; Time</span>
              <span style="color:#1A1A1A;font-size:15px;font-weight:500;">${displayDate} at ${b.time}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 20px;">
              <span style="display:block;color:#9ca3af;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px;">Address</span>
              <span style="color:#1A1A1A;font-size:15px;font-weight:500;">${address}</span>
            </td>
          </tr>
        </table>

        <div style="background:#E0F4F5;border-left:3px solid #0B6E72;border-radius:0 8px 8px 0;padding:14px 18px;margin:0 0 24px;">
          <p style="margin:0 0 4px;color:#0B6E72;font-size:14px;font-weight:700;">Please be home at your appointment time.</p>
          <p style="margin:0;color:#1A1A1A;font-size:14px;line-height:1.6;">Our cleaner needs you there to provide access at the door. You're welcome to leave after letting them in. We'll wait up to <strong>15 minutes</strong> -- after that a no-access fee (50% of service price) applies.</p>
        </div>

        <div style="border-top:1px solid #e5e7eb;padding-top:20px;">
          <p style="margin:0 0 6px;color:#1A1A1A;font-size:14px;font-weight:600;">Need to cancel or reschedule?</p>
          <p style="margin:0;color:#5A5A5A;font-size:14px;line-height:1.6;">No problem -- just reply to this email at least <strong>24 hours before</strong> your appointment at no charge. Cancellations under 24 hours are subject to a 25% fee.</p>
        </div>
      `);

      try {
        await sendEmail({
          to:      b.email,
          subject: `Reminder: Your clean is tomorrow at ${b.time}`,
          html
        });
        return { booking: doc.id, email: b.email, sent: true };
      } catch (err) {
        console.error(`Failed to send reminder for booking ${doc.id}:`, err.message);
        return { booking: doc.id, email: b.email, sent: false, error: err.message };
      }
    }));

    console.log('Reminders sent:', results);
    return { statusCode: 200, body: JSON.stringify(results) };

  } catch (err) {
    console.error('Reminder function error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
