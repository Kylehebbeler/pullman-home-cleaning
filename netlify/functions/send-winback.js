/**
 * send-winback.js — 60-day win-back email for lapsed customers
 *
 * Scheduled: Mondays at 10 AM PDT via GitHub Actions (send-winback.yml)
 *
 * Logic:
 *   - Reads the `customers` collection
 *   - If a customer's lastBookingDate was 60-90 days ago AND they haven't
 *     received a winback email in the last 90 days, send them one.
 *   - Writes winbackSentAt to prevent re-sending.
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
    const now     = new Date();
    const today   = now.toISOString().split('T')[0];

    // 60 days ago = start of winback window
    const d60 = new Date(now);
    d60.setDate(d60.getDate() - 60);
    const d60str = d60.toISOString().split('T')[0];

    // 90 days ago = end of winback window (beyond this we let them go)
    const d90 = new Date(now);
    d90.setDate(d90.getDate() - 90);
    const d90str = d90.toISOString().split('T')[0];

    const snap = await db.collection('customers').get();

    let sent = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      const c = doc.data();

      if (!c.email || !c.lastBookingDate) { skipped++; continue; }

      // Only target the 60-90 day lapsed window
      if (c.lastBookingDate >= d60str) { skipped++; continue; }  // too recent
      if (c.lastBookingDate < d90str)  { skipped++; continue; }  // too long ago

      // Skip if winback was already sent in the last 90 days
      if (c.winbackSentAt) {
        const sentDate = c.winbackSentAt.toDate ? c.winbackSentAt.toDate() : new Date(c.winbackSentAt);
        const daysSinceSent = (now - sentDate) / 864e5;
        if (daysSinceSent < 90) { skipped++; continue; }
      }

      // Skip active subscribers — they don't need a winback
      if (c.subscriptionActive) { skipped++; continue; }

      const firstName = (c.name || 'there').split(' ')[0];

      try {
        await sendEmail({
          to:      c.email,
          subject: `We miss you, ${firstName} — $15 off your next clean`,
          html:    wrap(
            '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">It\'s been a while, ' + firstName + '</h2>'
            + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">We haven\'t seen you in a bit — hope everything\'s going great in Pullman.</p>'
            + '<p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.7;">'
            + 'To welcome you back, we\'d love to offer you <strong>$15 off</strong> your next clean. '
            + 'Just mention this email when you book and we\'ll take it right off.'
            + '</p>'
            + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">'
            + '<tr><td>'
            + '<p style="margin:0 0 4px;font-size:28px;font-weight:700;color:#15803d;">$15 OFF</p>'
            + '<p style="margin:0;font-size:13px;color:#166534;">Mention this email at booking — no code needed</p>'
            + '</td></tr></table>'
            + '<p style="margin:0 0 28px;text-align:center;">'
            + '<a href="' + SITE_URL + '/#booking" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;border-radius:6px;text-decoration:none;">Book Now</a>'
            + '</p>'
            + '<p style="margin:0;font-size:13px;color:#9ca3af;text-align:center;">'
            + 'Questions? Just reply to this email — we\'re always happy to help.'
            + '</p>'
          )
        });

        await doc.ref.update({
          winbackSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        sent++;
        console.log('Win-back sent to', c.email, '| last booking:', c.lastBookingDate);

      } catch (emailErr) {
        console.error('Win-back email failed for', c.email, ':', emailErr.message);
      }
    }

    console.log('Win-back run complete | sent:', sent, '| skipped:', skipped);
    return { statusCode: 200, body: JSON.stringify({ sent, skipped }) };

  } catch (err) {
    console.error('send-winback error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
