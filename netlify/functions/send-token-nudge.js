/**
 * send-token-nudge.js — Nudge subscribers who haven't booked their slot yet
 *
 * Scheduled: daily at 9 AM PDT via GitHub Actions (send-token-nudge.yml)
 *
 * Logic:
 *   - Reads `subscriptionTokens` collection
 *   - Targets tokens that are: unused, not expired, created 3+ days ago,
 *     and haven't been nudged yet (or nudge was 7+ days ago)
 *   - Sends a reminder with their booking link
 *   - Sets nudgeSentAt to prevent immediate re-send
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
    const now    = new Date();
    const site   = (SITE_URL || 'https://pullmanhomecleaning.com').replace(/\/$/, '');

    // Only look at unused, unexpired tokens
    const snap = await db.collection('subscriptionTokens')
      .where('used',    '==', false)
      .where('expired', '==', false)
      .get();

    let sent = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      const t = doc.data();

      // Skip if no email
      if (!t.email) { skipped++; continue; }

      // Skip if token expires in the past
      const expiresAt = t.expiresAt && t.expiresAt.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt);
      if (expiresAt < now) { skipped++; continue; }

      // Skip if token was created less than 3 days ago (give them time to book)
      const createdAt = t.createdAt && t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);
      const daysSinceCreated = (now - createdAt) / 864e5;
      if (daysSinceCreated < 3) { skipped++; continue; }

      // Skip if nudge was sent less than 7 days ago
      if (t.nudgeSentAt) {
        const nudgeDate = t.nudgeSentAt.toDate ? t.nudgeSentAt.toDate() : new Date(t.nudgeSentAt);
        const daysSinceNudge = (now - nudgeDate) / 864e5;
        if (daysSinceNudge < 7) { skipped++; continue; }
      }

      const firstName  = (t.name || 'there').split(' ')[0];
      const bookingLink = site + '/booking.html?token=' + doc.id;
      const daysLeft   = Math.ceil((expiresAt - now) / 864e5);
      const expiresStr = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

      const urgencyNote = daysLeft <= 7
        ? '<p style="margin:0 0 20px;padding:10px 14px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e;font-weight:600;">Your booking link expires in ' + daysLeft + ' day' + (daysLeft===1?'':'s') + ' (' + expiresStr + '). Book now so you don\'t lose your slot.</p>'
        : '<p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.7;">Your booking link is ready — just pick a date and time that works for you. It expires on <strong>' + expiresStr + '</strong>, so don\'t wait too long.</p>';

      try {
        await sendEmail({
          to:      t.email,
          subject: 'Your cleaning slot is waiting, ' + firstName + ' — book anytime',
          html:    wrap(
            '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Ready to schedule your clean, ' + firstName + '?</h2>'
            + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Your subscription payment went through — you just need to pick a time.</p>'
            + urgencyNote
            + '<p style="margin:0 0 28px;text-align:center;">'
            + '<a href="' + bookingLink + '" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;border-radius:6px;text-decoration:none;">Book My Cleaning</a>'
            + '</p>'
            + '<p style="margin:0;font-size:13px;color:#6b7280;text-align:center;">'
            + 'Questions? Reply to this email or reach us at '
            + '<a href="mailto:pullmanhomecleaning@gmail.com" style="color:#2563eb;">pullmanhomecleaning@gmail.com</a>.'
            + '</p>'
          )
        });

        await doc.ref.update({
          nudgeSentAt: admin.firestore.FieldValue.serverTimestamp()
        });
        sent++;
        console.log('Token nudge sent to', t.email, '| token:', doc.id, '| expires:', expiresStr);

      } catch (emailErr) {
        console.error('Token nudge failed for', t.email, ':', emailErr.message);
      }
    }

    console.log('Token nudge run complete | sent:', sent, '| skipped:', skipped);
    return { statusCode: 200, body: JSON.stringify({ sent, skipped }) };

  } catch (err) {
    console.error('send-token-nudge error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
