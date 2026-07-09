/**
 * send-booking-confirmation.js — Booking confirmation + owner alert + cleaner notification
 *
 * Called by the frontend immediately after a booking is written to Firebase.
 * Sends three emails:
 *   1. Confirmation to the customer with full booking details
 *   2. New-booking alert to Kyle at pullmanhomecleaning@gmail.com
 *   3. Job notification to cleaner (if CLEANER_EMAIL env var is set)
 *
 * POST body: { bookingId: string }
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT
 *   RESEND_API_KEY
 *   SITE_URL
 * Optional env vars:
 *   CLEANER_EMAIL  -- cleaner's email address
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

const KYLE_EMAIL = 'pullmanhomecleaning@gmail.com';

const SERVICE_NAMES = {
  qc2: 'Quick Clean — 2 Bathrooms',
  wh1: 'Whole Home — Studio / 1 Bath',
  wh2: 'Whole Home — 2-Bath Home',
  wh3: 'Whole Home — 3-Bath Home',
  dc1: 'Deep Clean — Studio / 1 Bath',
  dc2: 'Deep Clean — 2-Bath Home',
  dc3: 'Deep Clean — 3-Bath Home',
};

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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { bookingId } = JSON.parse(event.body || '{}');
    if (!bookingId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing bookingId' }) };

    const snap = await db.collection('bookings').doc(bookingId).get();
    if (!snap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };

    const b = snap.data();
    const firstName   = (b.name || 'there').split(' ')[0];
    const address     = b.address + (b.unit && b.unit !== 'N/A' ? ', Unit ' + b.unit : '');
    const serviceName = SERVICE_NAMES[b.serviceId] || b.service || 'Home Cleaning';
    const price       = Number(b.price || 0).toFixed(2);
    const cancelUrl   = SITE_URL + '/cancel.html?id=' + bookingId;
    const typeLabel   = b.paidViaSubscription ? 'Subscription Clean' : 'One-Time Clean';

    /* -- 1. Customer confirmation ----------------------------------------------- */
    await sendEmail({
      to: b.email,
      subject: "You're booked! " + b.date + ' at ' + b.time + ' -- Pullman Home Cleaning',
      html: wrap(
        '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">You\'re all set, ' + firstName + '! </h2>'
        + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Here\'s everything you need to know about your upcoming clean.</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;">'
        + '<tr><td>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Date &amp; time:</strong> ' + b.date + ' at ' + b.time + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Address:</strong> ' + address + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Service:</strong> ' + serviceName + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Type:</strong> ' + typeLabel + '</p>'
        + (b.paidViaSubscription ? '' : '<p style="margin:0;font-size:14px;color:#374151;"><strong>Amount paid:</strong> $' + price + '</p>')
        + '</td></tr></table>'
        + '<p style="margin:0 0 8px;font-size:14px;color:#374151;font-weight:600;">What to expect:</p>'
        + '<ul style="margin:0 0 24px;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">'
        + '<li>Please be home at the start of your appointment to let your cleaner in.</li>'
        + '<li>We\'ll send a reminder the day before so you don\'t forget.</li>'
        + '<li>Have a question? Reply to this email and we\'ll get right back to you.</li>'
        + '</ul>'
        + '<p style="margin:0 0 8px;font-size:13px;color:#6b7280;"><strong>Cancellation policy:</strong> '
        + 'Cancellations made 24+ hours before your appointment receive a full refund. '
        + 'Cancellations within 24 hours are subject to a 25% fee.</p>'
        + '<p style="margin:24px 0 0;text-align:center;">'
        + '<a href="' + cancelUrl + '" style="display:inline-block;padding:10px 22px;background:#f3f4f6;color:#374151;font-size:13px;font-weight:500;border-radius:6px;text-decoration:none;border:1px solid #d1d5db;">Manage / Cancel Booking</a>'
        + '</p>'
      )
    });

    /* -- 2. Kyle alert ---------------------------------------------------------- */
    const petNote   = b.hasPets      ? 'Has pets'       : '';
    const photoNote = b.photoConsent ? 'Photo consent'  : '';
    const notes     = [petNote, photoNote].filter(Boolean).join(' &nbsp;|&nbsp; ');

    await sendEmail({
      to: KYLE_EMAIL,
      subject: 'New booking -- ' + b.name + ' on ' + b.date + ' at ' + b.time,
      html: wrap(
        '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">New booking received</h2>'
        + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Someone just booked online. Here are the details.</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;">'
        + '<tr><td>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Name:</strong> ' + (b.name || '--') + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Email:</strong> ' + (b.email || '--') + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Phone:</strong> ' + (b.phone || '--') + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Date &amp; time:</strong> ' + b.date + ' at ' + b.time + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Address:</strong> ' + address + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Service:</strong> ' + serviceName + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Type:</strong> ' + typeLabel + '</p>'
        + '<p style="margin:0 0 ' + (notes ? '10px' : '0') + ';font-size:14px;color:#374151;"><strong>Revenue:</strong> $' + price + '</p>'
        + (notes ? '<p style="margin:0;font-size:13px;color:#6b7280;">' + notes + '</p>' : '')
        + '</td></tr></table>'
        + '<p style="margin:0;font-size:13px;color:#6b7280;">Booking ID: <code style="font-family:monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px;">' + bookingId + '</code></p>'
      )
    });

    /* -- 3. Cleaner notification (if CLEANER_EMAIL is set) --------------------- */
    const cleanerEmail = process.env.CLEANER_EMAIL;
    if (cleanerEmail) {
      const petWarning = b.hasPets
        ? '<p style="margin:0 0 16px;padding:10px 14px;background:#fef9c3;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e;font-weight:600;">This customer has pets -- plan accordingly.</p>'
        : '';

      await sendEmail({
        to: cleanerEmail,
        subject: 'New job -- ' + b.date + ' at ' + b.time,
        html: wrap(
          '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">You have a new job</h2>'
          + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Here are your details for this booking.</p>'
          + petWarning
          + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;">'
          + '<tr><td>'
          + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Date &amp; time:</strong> ' + b.date + ' at ' + b.time + '</p>'
          + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Address:</strong> ' + address + '</p>'
          + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Service:</strong> ' + serviceName + '</p>'
          + '<p style="margin:0 0 ' + (b.notes ? '10px' : '0') + ';font-size:14px;color:#374151;"><strong>Customer:</strong> ' + (b.name || '--') + '</p>'
          + (b.notes ? '<p style="margin:0;font-size:14px;color:#374151;"><strong>Notes:</strong> ' + b.notes + '</p>' : '')
          + '</td></tr></table>'
          + '<p style="margin:0;font-size:13px;color:#6b7280;">Questions? Contact Kyle at <a href="mailto:pullmanhomecleaning@gmail.com" style="color:#2563eb;">pullmanhomecleaning@gmail.com</a></p>'
        )
      });
    }

    console.log('Confirmation sent to ' + b.email + ' | Kyle alerted | booking ' + bookingId);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error('send-booking-confirmation error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
