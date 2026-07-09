/**
 * send-weekly-summary.js — Weekly business digest to Kyle
 *
 * Scheduled: Mondays at 9 AM PDT via GitHub Actions (send-weekly-summary.yml)
 * Summarises the past 7 days: bookings completed, revenue collected,
 * and the full schedule for the coming week.
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT
 *   RESEND_API_KEY
 *   SITE_URL
 */

'use strict';
const admin = require('firebase-admin');
const { sendEmail, wrap } = require('./_mailer');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const KYLE_EMAIL = 'pullmanhomecleaning@gmail.com';

const SERVICE_NAMES = {
  qc2: 'Quick Clean',
  wh1: 'Whole Home (1 Bath)',
  wh2: 'Whole Home (2 Bath)',
  wh3: 'Whole Home (3 Bath)',
  dc1: 'Deep Clean (1 Bath)',
  dc2: 'Deep Clean (2 Bath)',
  dc3: 'Deep Clean (3 Bath)',
};

function dateStr(d) {
  return d.toISOString().split('T')[0];
}

function fmt(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

exports.handler = async () => {
  try {
    const now   = new Date();
    const today = dateStr(now);

    /* ── Last 7 days (completed) ── */
    const past7Start = new Date(now);
    past7Start.setDate(past7Start.getDate() - 7);
    const past7StartStr = dateStr(past7Start);

    /* ── Next 7 days (upcoming) ── */
    const next7End = new Date(now);
    next7End.setDate(next7End.getDate() + 7);
    const next7EndStr = dateStr(next7End);

    const allSnap = await db.collection('bookings').get();
    const all = allSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const lastWeek = all.filter(b => b.date >= past7StartStr && b.date < today);
    const upcoming = all.filter(b => b.date >= today && b.date <= next7EndStr)
                        .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

    const revenue    = lastWeek.reduce((sum, b) => sum + (Number(b.price) || 0), 0);
    const subCount   = lastWeek.filter(b => b.paidViaSubscription).length;
    const oneOffCount = lastWeek.filter(b => !b.paidViaSubscription).length;

    /* ── Build last-week rows ── */
    const lastWeekRows = lastWeek.length
      ? lastWeek
          .sort((a, b) => a.date.localeCompare(b.date))
          .map(b => `
            <tr>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.date}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.name || '—'}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${SERVICE_NAMES[b.serviceId] || b.service || '—'}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;text-align:right;">$${Number(b.price||0).toFixed(2)}</td>
            </tr>`)
          .join('')
      : `<tr><td colspan="4" style="padding:12px 10px;font-size:13px;color:#9ca3af;text-align:center;">No bookings last week</td></tr>`;

    /* ── Build upcoming rows ── */
    const upcomingRows = upcoming.length
      ? upcoming.map(b => `
            <tr>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.date}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.time || '—'}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.name || '—'}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${b.address || '—'}</td>
              <td style="padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${SERVICE_NAMES[b.serviceId] || b.service || '—'}</td>
            </tr>`)
          .join('')
      : `<tr><td colspan="5" style="padding:12px 10px;font-size:13px;color:#9ca3af;text-align:center;">No upcoming bookings this week</td></tr>`;

    await sendEmail({
      to: KYLE_EMAIL,
      subject: `📊 Weekly summary — ${fmt(past7Start)} to ${fmt(now)}`,
      html: wrap(`
        <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Weekly Business Summary</h2>
        <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">${fmt(past7Start)} → ${fmt(now)}</p>

        <!-- Stats row -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
          <tr>
            <td width="32%" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;">
              <p style="margin:0;font-size:24px;font-weight:700;color:#15803d;">$${revenue.toFixed(2)}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#166534;">Revenue</p>
            </td>
            <td width="4%"></td>
            <td width="28%" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;text-align:center;">
              <p style="margin:0;font-size:24px;font-weight:700;color:#1d4ed8;">${lastWeek.length}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#1e40af;">Cleans Done</p>
            </td>
            <td width="4%"></td>
            <td width="32%" style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:16px;text-align:center;">
              <p style="margin:0;font-size:24px;font-weight:700;color:#7c3aed;">${upcoming.length}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#6d28d9;">Coming Up</p>
            </td>
          </tr>
        </table>

        ${subCount || oneOffCount ? `
        <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">
          ${subCount} subscription &nbsp;·&nbsp; ${oneOffCount} one-time
        </p>` : ''}

        <!-- Last week table -->
        <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#111827;">Last 7 days</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:28px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Date</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Customer</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Service</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:right;font-weight:600;">Amount</th>
            </tr>
          </thead>
          <tbody>${lastWeekRows}</tbody>
        </table>

        <!-- Upcoming table -->
        <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#111827;">Next 7 days</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Date</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Time</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Customer</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Address</th>
              <th style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:left;font-weight:600;">Service</th>
            </tr>
          </thead>
          <tbody>${upcomingRows}</tbody>
        </table>
      `)
    });

    console.log(`Weekly summary sent to ${KYLE_EMAIL} | ${lastWeek.length} last week | ${upcoming.length} upcoming`);
    return { statusCode: 200, body: 'Weekly summary sent.' };

  } catch (err) {
    console.error('send-weekly-summary error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
