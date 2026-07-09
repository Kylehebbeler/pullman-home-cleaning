/**
 * send-rebooking-nudge.js - Re-booking follow-up
 *
 * Scheduled: 0 12 * * * (noon UTC = 5 AM PDT)
 * Runs daily. Finds one-time customers whose booking was 21 days ago
 * and who have not booked since -- sends a friendly "ready for another clean?" email.
 *
 * Skips:
 *   - Subscription customers (already recurring)
 *   - Customers who have booked again since
 *   - Customers who already received a nudge
 *   - Cancelled bookings
 *
 * Firestore fields written on the original booking doc:
 *   nudgeSent    {boolean}   - true once the email is sent
 *   nudgeSentAt  {timestamp} - when it was sent
 *
 * Required env var: GMAIL_APP_PASSWORD (see netlify/functions/_mailer.js)
 */

'use strict';
const admin             = require('firebase-admin');
const { sendEmail, wrap, SITE_URL } = require('./_mailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

exports.handler = async () => {
  try {
    const target = new Date();
    target.setDate(target.getDate() - 21);
    const targetDateStr = target.toISOString().split('T')[0];
    const targetDisplay = target.toLocaleDateString('en-US', {
      month: 'long', day: 'numeric'
    });

    const BOOKING_URL = `${SITE_URL}/booking.html`;

    const snap = await db.collection('bookings').where('date', '==', targetDateStr).get();
    if (snap.empty) {
      console.log(`No bookings on ${targetDateStr} -- no nudges needed.`);
      return { statusCode: 200, body: `No bookings on ${targetDateStr}.` };
    }

    const seenEmails = new Set();
    const candidates = [];

    for (const doc of snap.docs) {
      const b = doc.data();
      if (seenEmails.has(b.email))  continue;
      if (b.paidViaSubscription)    continue;
      if (b.nudgeSent)              continue;
      if (b.status === 'cancelled') continue;
      seenEmails.add(b.email);
      candidates.push({ doc, data: b });
    }

    if (candidates.length === 0) {
      console.log('No new nudge candidates.');
      return { statusCode: 200, body: 'No new nudge candidates.' };
    }

    const results = [];

    for (const { doc, data: b } of candidates) {
      const laterSnap = await db.collection('bookings')
        .where('email', '==', b.email)
        .where('date', '>', targetDateStr)
        .limit(1)
        .get();

      if (!laterSnap.empty) {
        console.log(`${b.email} already rebooked -- skipping.`);
        continue;
      }

      const firstName = (b.name || 'there').split(' ')[0];

      const html = wrap(`
        <h1 style="margin:0 0 6px;color:#1A1A1A;font-size:22px;font-weight:700;letter-spacing:-0.4px;">Ready for another clean, ${firstName}?</h1>
        <p style="margin:0 0 28px;color:#5A5A5A;font-size:15px;">It's been about three weeks since we cleaned your place.</p>

        <div style="background:#F9F7F4;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin:0 0 28px;">
          <span style="display:block;color:#9ca3af;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:4px;">Last clean</span>
          <span style="color:#1A1A1A;font-size:15px;font-weight:500;">${b.service} &mdash; ${targetDisplay}</span>
        </div>

        <p style="margin:0 0 28px;color:#1A1A1A;font-size:15px;line-height:1.7;">
          If you're ready to book again, it takes a couple of minutes -- pick your
          service, choose a time, and we'll take care of the rest.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
          <tr>
            <td style="border-radius:8px;background:#0B6E72;">
              <a href="${BOOKING_URL}"
                 style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;border-radius:8px;">
                Book a Clean &rarr;
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;text-align:center;">
          Questions? Just reply to this email.
        </p>
      `);

      try {
        await sendEmail({
          to:      b.email,
          subject: `Ready for another clean, ${firstName}?`,
          html
        });
        await doc.ref.update({
          nudgeSent:   true,
          nudgeSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        results.push({ booking: doc.id, email: b.email, sent: true });
      } catch (err) {
        console.error(`Failed to send nudge for booking ${doc.id}:`, err.message);
        results.push({ booking: doc.id, email: b.email, sent: false, error: err.message });
      }
    }

    console.log('Rebooking nudges sent:', results);
    return { statusCode: 200, body: JSON.stringify(results) };

  } catch (err) {
    console.error('Rebooking nudge function error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
