/**
 * send-review-request.js - Post-clean Google review request
 *
 * Scheduled: 0 16 * * * (9 AM PDT)
 * Runs every morning. Finds all bookings from yesterday that have not had a
 * review request sent yet, and emails each customer asking for a Google review.
 *
 * Firestore fields written on each booking:
 *   reviewSent    {boolean}   - true once the email is sent
 *   reviewSentAt  {timestamp} - when it was sent
 *
 * Required env var: GMAIL_APP_PASSWORD (see netlify/functions/_mailer.js)
 *
 * Optional env var: GOOGLE_REVIEW_URL
 *   Your Google Business Profile direct review link.
 *   Get it from: GBP dashboard -> "Ask for reviews" -> copy link.
 *   Add it to Netlify env vars once your GBP is live.
 *   Until then, the email links to your website homepage.
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
    // Runs at 9 AM PDT. Query yesterday's bookings so customers receive
    // the review request the morning after their clean.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const snap = await db.collection('bookings').where('date', '==', yesterdayStr).get();
    if (snap.empty) {
      console.log('No bookings yesterday -- no review requests sent.');
      return { statusCode: 200, body: 'No bookings yesterday.' };
    }

    const REVIEW_URL = process.env.GOOGLE_REVIEW_URL || SITE_URL;

    const results = [];

    for (const doc of snap.docs) {
      const b = doc.data();

      if (b.reviewSent)             continue;
      if (b.status === 'cancelled') continue;

      const firstName = (b.name || 'there').split(' ')[0];

      const html = wrap(`
        <h1 style="margin:0 0 6px;color:#1A1A1A;font-size:22px;font-weight:700;letter-spacing:-0.4px;">Thanks, ${firstName}!</h1>
        <p style="margin:0 0 24px;color:#5A5A5A;font-size:15px;">We hope your ${b.service} left your place looking great.</p>

        <p style="margin:0 0 28px;color:#1A1A1A;font-size:15px;line-height:1.7;">
          If you have 60 seconds, leaving us a Google review makes a real difference --
          it helps other people in Pullman find a cleaner they can trust, and it helps
          our small business grow.
        </p>

        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
          <tr>
            <td style="border-radius:8px;background:#0B6E72;">
              <a href="${REVIEW_URL}"
                 style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;border-radius:8px;">
                Leave a Google Review &rarr;
              </a>
            </td>
          </tr>
        </table>

        <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;text-align:center;">
          Takes less than a minute. If anything wasn't right with your clean,
          just reply to this email and we'll make it right.
        </p>
      `);

      try {
        await sendEmail({
          to:      b.email,
          subject: `How'd we do, ${firstName}?`,
          html
        });
        await doc.ref.update({
          reviewSent:   true,
          reviewSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        results.push({ booking: doc.id, email: b.email, sent: true });
      } catch (err) {
        console.error(`Failed to send review request for booking ${doc.id}:`, err.message);
        results.push({ booking: doc.id, email: b.email, sent: false, error: err.message });
      }
    }

    console.log('Review requests sent:', results);
    return { statusCode: 200, body: JSON.stringify(results) };

  } catch (err) {
    console.error('Review request function error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
