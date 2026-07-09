/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: stripe-webhook
   Fires on every Stripe event. Handles:
     - invoice.payment_succeeded  -> generate booking token + email customer
     - invoice.payment_failed     -> alert Kyle + email customer to update card

   ENVIRONMENT VARIABLES:
     STRIPE_SECRET_KEY       sk_live_... or sk_test_...
     STRIPE_WEBHOOK_SECRET   whsec_... (from Stripe dashboard -> Webhooks)
     FIREBASE_SERVICE_ACCOUNT full JSON of your Firebase service account key
     SITE_URL                https://pullmanhomecleaning.com (no trailing slash)

   STRIPE SETUP:
     Dashboard -> Developers -> Webhooks -> Add endpoint
     URL: https://[your-site].netlify.app/.netlify/functions/stripe-webhook
     Events to listen for: invoice.payment_succeeded, invoice.payment_failed
   ═══════════════════════════════════════════════════════════════════ */

const Stripe = require('stripe');
const admin  = require('firebase-admin');
const crypto = require('crypto');
const { sendEmail, wrap, SITE_URL } = require('./_mailer');

const KYLE_EMAIL = 'pullmanhomecleaning@gmail.com';

/* -- Firebase init --------------------------------------------------------- */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

/* -- Service name map ------------------------------------------------------ */
const SERVICE_NAMES = {
  qc2: 'Quick Clean -- 2 Bathrooms',
  wh1: 'Whole Home -- Studio / 1 Bath',
  wh2: 'Whole Home -- 2-Bath Home',
  wh3: 'Whole Home -- 3-Bath Home',
  dc1: 'Deep Clean -- Studio / 1 Bath',
  dc2: 'Deep Clean -- 2-Bath Home',
  dc3: 'Deep Clean -- 3-Bath Home',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  /* -- Verify Stripe signature --------------------------------------------- */
  const sig    = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = new Stripe(process.env.STRIPE_SECRET_KEY)
      .webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  /* -- Route by event type ------------------------------------------------- */
  const invoice = stripeEvent.data.object;

  if (stripeEvent.type === 'invoice.payment_failed') {
    return handlePaymentFailed(invoice);
  }

  if (stripeEvent.type !== 'invoice.payment_succeeded') {
    return { statusCode: 200, body: 'Ignored' };
  }

  /* -- Only process subscription invoices ---------------------------------- */
  if (!invoice.subscription) {
    return { statusCode: 200, body: 'Not a subscription invoice' };
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const sub  = await stripe.subscriptions.retrieve(invoice.subscription);
    const meta = sub.metadata;

    const email        = meta.customerEmail || invoice.customer_email || '';
    const name         = meta.customerName  || '';
    const serviceId    = meta.serviceId     || '';
    const freq         = meta.freq          || 'monthly';
    const address      = meta.address       || '';
    const unit         = meta.unit          || '';
    const complex      = meta.complex       || '';
    const amount       = Number(meta.amount) || (invoice.amount_paid / 100);
    const photoConsent = meta.photoConsent === 'true';
    const hasPets      = meta.hasPets      === 'true';

    if (!email) {
      console.error('No email for subscription', invoice.subscription);
      return { statusCode: 200, body: 'No email -- skipped' };
    }

    /* -- Generate one-time booking token ------------------------------------ */
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    /* -- Store token in Firebase -------------------------------------------- */
    await db.collection('subscriptionTokens').doc(token).set({
      token,
      subscriptionId: invoice.subscription,
      invoiceId:      invoice.id,
      billingReason:  invoice.billing_reason,
      email,
      name,
      serviceId,
      freq,
      address,
      unit,
      complex,
      amount,
      photoConsent,
      hasPets,
      used:        false,
      usedAt:      null,
      expired:     false,
      nudgeSentAt: null,
      bookedDate:  null,
      bookedTime:  null,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt)
    });

    /* -- Send booking link email via EmailJS --------------------------------- */
    const siteUrl     = (process.env.SITE_URL || 'https://pullmanhomecleaning.com').replace(/\/$/, '');
    const bookingLink = siteUrl + '/booking.html?token=' + token;
    const freqLabel   = freq === 'biweekly' ? 'bi-weekly' : 'monthly';
    const serviceName = SERVICE_NAMES[serviceId] || serviceId;
    const expiresStr  = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const emailResp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id:  'service_5llh4ic',
        template_id: 'template_booking_link',
        user_id:     process.env.EMAILJS_PUBLIC_KEY,
        template_params: {
          customer_name:  name,
          customer_email: email,
          service_name:   serviceName,
          booking_link:   bookingLink,
          amount:         amount.toFixed(2),
          freq_label:     freqLabel,
          expires_date:   expiresStr
        }
      })
    });

    if (!emailResp.ok) {
      console.warn('EmailJS send failed:', await emailResp.text());
    }

    console.log('Booking token created and emailed to ' + email + ' | sub ' + invoice.subscription + ' | reason: ' + invoice.billing_reason);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return { statusCode: 500, body: err.message };
  }
};

/* -- invoice.payment_failed handler ---------------------------------------- */
async function handlePaymentFailed(invoice) {
  try {
    const stripe    = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sub       = invoice.subscription
      ? await stripe.subscriptions.retrieve(invoice.subscription).catch(() => null)
      : null;
    const meta      = sub ? sub.metadata : {};
    const email     = meta.customerEmail || invoice.customer_email || '';
    const name      = meta.customerName  || 'Subscriber';
    const firstName = name.split(' ')[0];
    const amount    = ((invoice.amount_due || 0) / 100).toFixed(2);
    const freqLabel = meta.freq === 'biweekly' ? 'bi-weekly' : 'monthly';

    /* -- Alert Kyle --------------------------------------------------------- */
    await sendEmail({
      to:      KYLE_EMAIL,
      subject: 'Payment failed -- ' + name + ' ($' + amount + ')',
      html:    wrap(
        '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Subscription payment failed</h2>'
        + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">A customer\'s recurring payment did not go through.</p>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:20px;margin-bottom:24px;">'
        + '<tr><td>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Customer:</strong> ' + name + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Email:</strong> ' + (email || '--') + '</p>'
        + '<p style="margin:0 0 10px;font-size:14px;color:#374151;"><strong>Amount due:</strong> $' + amount + '</p>'
        + '<p style="margin:0;font-size:14px;color:#374151;"><strong>Subscription:</strong> ' + freqLabel + (meta.serviceId ? ' (' + meta.serviceId + ')' : '') + '</p>'
        + '</td></tr></table>'
        + '<p style="margin:0;font-size:13px;color:#6b7280;">Stripe will retry automatically. If it fails again, the subscription will be cancelled. '
        + 'The customer has also received an email asking them to update their card.</p>'
      )
    });

    /* -- Email customer ----------------------------------------------------- */
    if (email) {
      await sendEmail({
        to:      email,
        subject: 'Action needed -- payment for your cleaning subscription',
        html:    wrap(
          '<h2 style="margin:0 0 4px;font-size:20px;color:#111827;">We couldn\'t process your payment, ' + firstName + '</h2>'
          + '<p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Your ' + freqLabel + ' cleaning subscription payment of <strong>$' + amount + '</strong> was declined.</p>'
          + '<p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.7;">'
          + 'This is usually due to an expired card or insufficient funds. To keep your subscription active, '
          + 'please update your payment method as soon as possible.</p>'
          + '<p style="margin:0 0 28px;text-align:center;">'
          + '<a href="' + (SITE_URL || 'https://pullmanhomecleaning.com') + '" style="display:inline-block;padding:12px 28px;background:#2563eb;color:#ffffff;font-size:14px;font-weight:600;border-radius:6px;text-decoration:none;">Update Payment Method</a>'
          + '</p>'
          + '<p style="margin:0;font-size:13px;color:#6b7280;text-align:center;">'
          + 'Stripe will retry your payment automatically. Questions? Reply to this email or contact us at '
          + '<a href="mailto:pullmanhomecleaning@gmail.com" style="color:#2563eb;">pullmanhomecleaning@gmail.com</a>.</p>'
        )
      });
    }

    console.log('Payment failed handled for ' + email + ' | amount: ' + amount);
    return { statusCode: 200, body: 'payment_failed handled' };

  } catch (err) {
    console.error('handlePaymentFailed error:', err.message);
    return { statusCode: 500, body: err.message };
  }
}
