/**
 * send-monthly-report.js — Monthly revenue report to Kyle
 *
 * Scheduled: 1st of each month at 9 AM PDT via GitHub Actions (send-monthly-report.yml)
 *
 * Report includes:
 *   - Last 30 days: total revenue, # of cleans, avg booking value, breakdown by service
 *   - Next 30 days: upcoming cleans count + projected revenue
 *   - All-time: total customers, total cleans
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

const SERVICE_NAMES = {
  qc2: 'Quick Clean (2 Bath)',
  wh1: 'Whole Home (Studio)',
  wh2: 'Whole Home (2 Bath)',
  wh3: 'Whole Home (3 Bath)',
  dc1: 'Deep Clean (Studio)',
  dc2: 'Deep Clean (2 Bath)',
  dc3: 'Deep Clean (3 Bath)',
};

exports.handler = async () => {
  try {
    const now  = new Date();
    const pdt  = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    const today = pdt.toISOString().split('T')[0];

    const d30back  = new Date(pdt); d30back.setDate(d30back.getDate() - 30);
    const d30fwd   = new Date(pdt); d30fwd.setDate(d30fwd.getDate() + 30);
    const past30   = d30back.toISOString().split('T')[0];
    const fwd30    = d30fwd.toISOString().split('T')[0];

    const snap = await db.collection('bookings').get();
    const bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Last 30 days (completed or non-cancelled with past date)
    const last30 = bookings.filter(b =>
      b.date >= past30 && b.date < today && b.status !== 'cancelled'
    );

    // Next 30 days upcoming
    const next30 = bookings.filter(b =>
      b.date >= today && b.date <= fwd30 && b.status !== 'cancelled'
    );

    // Revenue calculations
    const revenue30    = last30.reduce((s, b) => s + Number(b.price || 0), 0);
    const revUpcoming  = next30.reduce((s, b) => s + Number(b.price || 0), 0);
    const avgValue     = last30.length > 0 ? (revenue30 / last30.length) : 0;

    // Service breakdown for last 30
    const byService = {};
    for (const b of last30) {
      const svc = SERVICE_NAMES[b.serviceId] || b.serviceId || 'Unknown';
      byService[svc] = (byService[svc] || 0) + 1;
    }

    // Customer count
    const custSnap = await db.collection('customers').get();
    const totalCustomers = custSnap.size;

    // All-time completed cleans
    const allCompleted = bookings.filter(b => b.completed || b.status === 'completed').length;

    // Month name
    const monthName = pdt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Build service breakdown rows
    const svcRows = Object.entries(byService).map(([name, count]) =>
      '<tr><td style="padding:6px 0;font-size:13px;color:#374151;">' + name + '</td>'
      + '<td style="padding:6px 0;font-size:13px;color:#374151;text-align:right;">' + count + '</td></tr>'
    ).join('') || '<tr><td colspan="2" style="padding:6px 0;font-size:13px;color:#9ca3af;">No cleans this period</td></tr>';

    await sendEmail({
      to:      'pullmanhomecleaning@gmail.com',
      subject: 'Monthly report — ' + monthName + ' | Pullman Home Cleaning',
      html:    wrap(
        '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Monthly Business Report</h2>'
        + '<p style="margin:0 0 28px;color:#6b7280;font-size:14px;">' + monthName + ' summary for Pullman Home Cleaning.</p>'

        // Last 30 days stats
        + '<p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">Last 30 Days</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">'
        + '<tr>'
        + '<td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;width:30%;">'
        + '<p style="margin:0 0 2px;font-size:24px;font-weight:700;color:#15803d;">$' + revenue30.toFixed(0) + '</p>'
        + '<p style="margin:0;font-size:11px;color:#166534;text-transform:uppercase;">Revenue</p>'
        + '</td>'
        + '<td style="width:4%;"></td>'
        + '<td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;text-align:center;width:30%;">'
        + '<p style="margin:0 0 2px;font-size:24px;font-weight:700;color:#1d4ed8;">' + last30.length + '</p>'
        + '<p style="margin:0;font-size:11px;color:#1e40af;text-transform:uppercase;">Cleans</p>'
        + '</td>'
        + '<td style="width:4%;"></td>'
        + '<td style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:16px;text-align:center;width:30%;">'
        + '<p style="margin:0 0 2px;font-size:24px;font-weight:700;color:#7c3aed;">$' + avgValue.toFixed(0) + '</p>'
        + '<p style="margin:0;font-size:11px;color:#6d28d9;text-transform:uppercase;">Avg Value</p>'
        + '</td>'
        + '</tr>'
        + '</table>'

        // Service breakdown
        + '<p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">Cleans by Service</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px;">'
        + svcRows
        + '</table>'

        // Upcoming
        + '<p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">Next 30 Days</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:24px;">'
        + '<tr><td style="font-size:14px;color:#374151;">Upcoming bookings</td><td style="text-align:right;font-size:14px;font-weight:600;color:#374151;">' + next30.length + '</td></tr>'
        + '<tr><td style="font-size:14px;color:#374151;">Projected revenue</td><td style="text-align:right;font-size:14px;font-weight:600;color:#15803d;">$' + revUpcoming.toFixed(0) + '</td></tr>'
        + '</table>'

        // All-time
        + '<p style="margin:0 0 10px;font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;">All Time</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:0;">'
        + '<tr><td style="font-size:14px;color:#374151;">Total customers</td><td style="text-align:right;font-size:14px;font-weight:600;color:#374151;">' + totalCustomers + '</td></tr>'
        + '<tr><td style="font-size:14px;color:#374151;">Completed cleans</td><td style="text-align:right;font-size:14px;font-weight:600;color:#374151;">' + allCompleted + '</td></tr>'
        + '</table>'
      )
    });

    console.log('Monthly report sent | last30 revenue: $' + revenue30.toFixed(2) + ' | cleans: ' + last30.length + ' | upcoming: ' + next30.length);
    return {
      statusCode: 200,
      body: JSON.stringify({ revenue30, cleans30: last30.length, upcoming: next30.length, totalCustomers })
    };

  } catch (err) {
    console.error('send-monthly-report error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};
