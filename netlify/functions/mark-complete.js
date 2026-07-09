/**
 * mark-complete.js — Mark a booking as completed and fire the review request
 *
 * Called by the CRM "Mark Complete" button.
 * Sets completed:true on the booking in Firestore, then immediately sends
 * the Google review request email to the customer (same email as the daily
 * send-review-request.js job, but triggered on-demand instead of next morning).
 *
 * POST body: { bookingId: string, adminPassword: string }
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT
 *   RESEND_API_KEY
 *   CRM_PASSWORD
 *   SITE_URL
 *   GOOGLE_REVIEW_URL  (optional — falls back to SITE_URL)
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

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigin = (
    origin.includes('pullmanhomecleaning.com') ||
    origin.includes('netlify.app') ||
    origin.startsWith('http://localhost')
  ) ? origin : 'https://pullmanhomecleaning.com';

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { bookingId, adminPassword } = JSON.parse(event.body || '{}');

    if (!bookingId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing bookingId.' }) };
    }
    if (!process.env.CRM_PASSWORD || adminPassword !== process.env.CRM_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    const ref  = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found.' }) };
    }

    const b = snap.data();

    if (b.status === 'cancelled') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cannot mark a cancelled booking as complete.' }) };
    }

    /* ── Mark booking complete ── */
    await ref.update({
      completed:    true,
      completedAt:  admin.firestore.FieldValue.serverTimestamp(),
      status:       'completed'
    });

    /* ── Send review request email ── */
    let reviewSent = false;
    if (b.email && !b.reviewSent) {
      const firstName  = (b.name || 'there').split(' ')[0];
      const REVIEW_URL = process.env.GOOGLE_REVIEW_URL || SITE_URL;

      await sendEmail({
        to:      b.email,
        subject: `How'd we do, ${firstName}?`,
        html:    wrap(`
          <h1 style="margin:0 0 6px;color:#1A1A1A;font-size:22px;font-weight:700;letter-spacing:-0.4px;">Thanks, ${firstName}!</h1>
          <p style="margin:0 0 24px;color:#5A5A5A;font-size:15px;">We hope your ${b.service || 'clean'} left your place looking great.</p>

          <p style="margin:0 0 28px;color:#1A1A1A;font-size:15px;line-height:1.7;">
            If you have 60 seconds, leaving us a Google review makes a real difference —
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
        `)
      });

      await ref.update({
        reviewSent:   true,
        reviewSentAt: admin.firestore.FieldValue.serverTimestamp()
      });
      reviewSent = true;
    }

    console.log(`Booking ${bookingId} marked complete | review email sent: ${reviewSent}`);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, reviewSent }) };

  } catch (err) {
    console.error('mark-complete error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
