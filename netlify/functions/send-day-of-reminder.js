/**
 * send-day-of-reminder.js — Morning-of reminder for same-day bookings
 *
 * Scheduled: daily at 7 AM PDT via GitHub Actions (send-day-of-reminder.yml)
 *
 * Logic:
 *   - Reads `bookings` where date == today
 *   - Skips bookings that already received a day-of reminder
 *   - Sends a friendly heads-up with address + time
 *   - Sets dayOfReminderSent: true
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT
 *   RESEND_API_KEY
 *   SITE_URL
 */

'use strict';
const admin = require('firebase-admin');
const { sendEmail, wrap, SITE_URL } = require('./_mailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

exports.handler = async () => {
  try {
    const now   = new Date();
    // Use PDT date (UTC-7)
    const pdt   = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pdt.toISOString().split('T')[0];

    const snap = await db.collection('bookings')
      .where('date', '==', today)
      .get();

    const results = [];

    for (const doc of snap.docs) {
      const b = doc.data();

      if (!b.email)              { results.push({ booking: doc.id, skipped: 'no email' });           continue; }
      if (b.dayOfReminderSent)   { results.push({ booking: doc.id, skipped: 'already sent' });        continue; }
      if (b.status === 'cancelled') { results.push({ booking: doc.id, skipped: 'cancelled' });        continue; }

      const firstName  = (b.name || 'there').split(' ')[0];
      const address    = b.address + (b.unit && b.unit !== 'N/A' ? ', Unit ' + b.unit : '');
      const cancelUrl  = SITE_URL + '/cancel.html?id=' + doc.id;

      try {
        await sendEmail({
          to:      b.email,
          subject: 'Your cleaning is today at ' + b.time + ' — Pullman Home Cleaning',
          html:    wrap(
            '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">See you today, ' + firstName + '!</h2>'
            + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Just a quick heads-up — your cleaner is on their way today.</p>'
            + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;">'
            + '<tr><td>'
            + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Time:</strong> ' + b.time + ' today</p>'
            + '<p style="margin:0;font-size:14px;color:#374151;"><strong>Address:</strong> ' + address + '</p>'
            + '</td></tr></table>'
            + '<p style="margin:0 0 16px;font-size:14px;color:#374151;line-height:1.7;">'
            + 'Please make sure you\'re home at the start of your appointment to let your cleaner in. '
            + 'If you need to reschedule, please do so as soon as possible.'
            + '</p>'
            + '<p style="margin:0 0 28px;font-size:13px;color:#6b7280;">'
            + '<strong>Reminder:</strong> Cancellations within 24 hours are subject to a 25% fee.'
            + '</p>'
            + '<p style="margin:0;text-align:center;">'
            + '<a href="' + cancelUrl + '" style="display:inline-block;padding:10px 22px;background:#f3f4f6;color:#374151;font-size:13px;font-weight:500;border-radius:6px;text-decoration:none;border:1px solid #d1d5db;">Manage Booking</a>'
            + '</p>'
          )
        });

        await doc.ref.update({
          dayOfReminderSent: true,
          dayOfReminderSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        results.push({ booking: doc.id, email: b.email, sent: true });
        console.log('Day-of reminder sent to', b.email, '| booking:', doc.id);

      } catch (emailErr) {
        results.push({ booking: doc.id, email: b.email, error: emailErr.message });
        console.error('Day-of reminder failed for', b.email, ':', emailErr.message);
      }
    }

    console.log('Day-of reminders:', JSON.stringify(results));
    return { statusCode: 200, body: JSON.stringify({ results }) };

  } catch (err) {
    console.error('send-day-of-reminder error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
