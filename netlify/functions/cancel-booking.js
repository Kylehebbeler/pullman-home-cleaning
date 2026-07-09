const Stripe = require('stripe');
const admin  = require('firebase-admin');
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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { bookingId, email, lookupOnly, adminPassword } = JSON.parse(event.body);

    const isAdmin = process.env.CRM_PASSWORD && adminPassword === process.env.CRM_PASSWORD;

    if (!bookingId || (!email && !isAdmin)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing booking ID or email.' }) };
    }

    const ref  = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found. It may have already been cancelled.' }) };
    }

    const booking = snap.data();

    if (!isAdmin && booking.email.toLowerCase() !== (email || '').toLowerCase()) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Email does not match this booking.' }) };
    }

    if (lookupOnly) {
      return { statusCode: 200, headers, body: JSON.stringify({ booking }) };
    }

    function parseApptDate(dateStr, timeStr) {
      const [time, ampm] = timeStr.split(' ');
      const [h, m] = time.split(':').map(Number);
      let hour = h;
      if (ampm === 'PM' && h !== 12) hour += 12;
      if (ampm === 'AM' && h === 12) hour = 0;
      const d = new Date(dateStr + 'T00:00:00');
      d.setHours(hour, m || 0, 0, 0);
      return d;
    }
    const apptDate   = parseApptDate(booking.date, booking.time || '12:00 PM');
    const hoursUntil = (apptDate - new Date()) / 36e5;
    const within24   = hoursUntil < 24;

    const stripe       = new Stripe(process.env.STRIPE_SECRET_KEY);
    const bookingPrice = Number(booking.price) || 0;

    let refunded              = false;
    let refundType            = null;
    let lateFeeCharged        = false;
    let subscriptionCancelled = false;

    if (booking.paidViaSubscription && booking.subscriptionId) {
      if (within24 && bookingPrice > 0) {
        try {
          const lateFeeAmount = Math.round(bookingPrice * 0.25 * 100);
          const sub  = await stripe.subscriptions.retrieve(booking.subscriptionId);
          const pmId = sub.default_payment_method
                    || (await stripe.customers.retrieve(sub.customer)).invoice_settings?.default_payment_method;
          if (pmId) {
            await stripe.paymentIntents.create({
              amount:         lateFeeAmount,
              currency:       'usd',
              customer:       sub.customer,
              payment_method: pmId,
              confirm:        true,
              off_session:    true,
              description:    'Late cancellation fee -- ' + (booking.service || 'cleaning') + ' on ' + booking.date,
              receipt_email:  booking.email || undefined,
              metadata: { type: 'late_cancellation_fee', bookingId, originalAmount: String(bookingPrice) }
            });
            lateFeeCharged = true;
          } else {
            console.warn('Late cancel: no stored payment method for sub ' + booking.subscriptionId);
          }
        } catch (feeErr) {
          console.error('Late cancel fee failed for ' + bookingId + ':', feeErr.message);
        }
      }
    } else if (booking.paid && booking.paymentIntentId) {
      if (within24) {
        const refundAmount = Math.round(bookingPrice * 0.75 * 100);
        await stripe.refunds.create({
          payment_intent: booking.paymentIntentId,
          amount:         refundAmount,
          reason:         'requested_by_customer',
          metadata: { type: 'late_cancellation_partial_refund', bookingId, pctRefunded: '75' }
        });
        refunded       = true;
        refundType     = 'partial';
        lateFeeCharged = true;
      } else {
        await stripe.refunds.create({ payment_intent: booking.paymentIntentId });
        refunded   = true;
        refundType = 'full';
      }
    }

    await Promise.all([
      ref.delete(),
      db.collection('slots').doc(bookingId).delete()
    ]);

    /* -- Cancellation follow-up email ---------------------------------------- */
    try {
      const firstName = (booking.name || 'there').split(' ')[0];
      const price     = Number(booking.price || 0).toFixed(2);

      let refundLine = '';
      if (refunded && refundType === 'full') {
        refundLine = '<p style="margin:0 0 10px;font-size:14px;color:#374151;">'
          + '<strong>Refund:</strong> A full refund of <strong>$' + price + '</strong> has been issued '
          + 'and should appear on your card within 5-10 business days.</p>';
      } else if (refunded && refundType === 'partial') {
        const refundAmt = (Number(booking.price || 0) * 0.75).toFixed(2);
        refundLine = '<p style="margin:0 0 10px;font-size:14px;color:#374151;">'
          + '<strong>Refund:</strong> Because this cancellation was within 24 hours of your appointment, '
          + 'a <strong>75% refund ($' + refundAmt + ')</strong> has been issued per our cancellation policy. '
          + 'It should appear within 5-10 business days.</p>';
      } else if (lateFeeCharged) {
        const feeAmt = (Number(booking.price || 0) * 0.25).toFixed(2);
        refundLine = '<p style="margin:0 0 10px;font-size:14px;color:#374151;">'
          + '<strong>Late cancellation fee:</strong> Because this was cancelled within 24 hours of your appointment, '
          + 'a fee of <strong>$' + feeAmt + '</strong> (25%) has been charged per our cancellation policy.</p>';
      } else {
        refundLine = '<p style="margin:0 0 10px;font-size:14px;color:#374151;">No charges were made for this cancellation.</p>';
      }

      const bodyHtml = ''
        + '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Booking cancelled, ' + firstName + '</h2>'
        + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">We\'ve cancelled your appointment. Here\'s a summary.</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:24px;">'
        + '<tr><td>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Date:</strong> ' + booking.date + ' at ' + booking.time + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Service:</strong> ' + (booking.service || 'Home Cleaning') + '</p>'
        + refundLine
        + '</td></tr></table>'
        + '<p style="margin:0 0 20px;font-size:14px;color:#374151;">We\'re sorry it didn\'t work out this time. Whenever you\'re ready to book again, it only takes a couple of minutes online.</p>'
        + '<p style="margin:0 0 4px;text-align:center;"><a href="' + SITE_URL + '/#booking" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;border-radius:6px;text-decoration:none;">Book Again</a></p>'
        + '<p style="margin:24px 0 0;font-size:13px;color:#6b7280;text-align:center;">Questions? Email us at <a href="mailto:pullmanhomecleaning@gmail.com" style="color:#2563eb;">pullmanhomecleaning@gmail.com</a></p>';

      await sendEmail({
        to:      booking.email,
        subject: 'Your booking has been cancelled -- Pullman Home Cleaning',
        html:    wrap(bodyHtml)
      });
      console.log('Cancellation follow-up sent to ' + booking.email + ' for booking ' + bookingId);
    } catch (mailErr) {
      console.error('Cancellation email failed:', mailErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, refunded, refundType, lateFeeCharged, subscriptionCancelled, within24 })
    };

  } catch (err) {
    console.error('Cancel error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong. Please email pullmanhomecleaning@gmail.com to cancel.' }) };
  }
};
