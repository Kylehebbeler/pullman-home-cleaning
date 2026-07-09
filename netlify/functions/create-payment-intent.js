/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: create-payment-intent
   Runs server-side so Stripe and Firebase secrets are never exposed.

   ENVIRONMENT VARIABLES (Netlify dashboard → Site settings → Env vars):
     STRIPE_SECRET_KEY         sk_live_... or sk_test_...
     FIREBASE_SERVICE_ACCOUNT  full JSON of your Firebase service account key
   ═══════════════════════════════════════════════════════════════════ */

const Stripe = require('stripe');
const admin  = require('firebase-admin');

/* ─── Firebase init (shared across warm lambda instances) ─────── */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

/* ─── Accepted prices — prevents tampered amounts ────────────── */
const VALID_AMOUNTS = [80, 85, 90, 95, 100, 135, 140, 145, 150, 155, 160, 165, 170, 185, 190, 195, 200, 220, 225, 230, 235, 285, 290, 295, 300];

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const {
      amount, description, customerName, customerEmail,
      isSubscription, paymentMethodId, freq,
      /* subscriber info stored for webhook use */
      phone, address, unit, complex, serviceId, photoConsent, hasPets
    } = JSON.parse(event.body);

    if (!VALID_AMOUNTS.includes(Number(amount))) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid amount' }) };
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    if (isSubscription) {
      /* ── Create Stripe customer + subscription ── */
      const customer = await stripe.customers.create({
        email:            customerEmail || undefined,
        name:             customerName  || undefined,
        payment_method:   paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
        metadata:         { source: 'booking-page' }
      });

      /* Billing anchor: 2 weeks (biweekly) or 1 month from today */
      const isBiweekly = freq === 'biweekly';
      const anchor = new Date();
      if (isBiweekly) {
        anchor.setUTCDate(anchor.getUTCDate() + 14);
      } else {
        anchor.setUTCMonth(anchor.getUTCMonth() + 1);
      }
      anchor.setUTCHours(0, 0, 0, 0);

      const subscription = await stripe.subscriptions.create({
        customer:               customer.id,
        default_payment_method: paymentMethodId,
        billing_cycle_anchor:   Math.floor(anchor.getTime() / 1000),
        proration_behavior:     'none',
        payment_behavior:       'default_incomplete',
        expand:                 ['latest_invoice.payment_intent'],
        items: [{
          price_data: {
            currency:     'usd',
            unit_amount:  Math.round(amount * 100),
            recurring:    isBiweekly ? { interval: 'week', interval_count: 2 } : { interval: 'month' },
            product_data: { name: description || 'Pullman Home Cleaning' }
          }
        }],
        /* Store all subscriber info here — the webhook reads this directly
           so there is no Firebase race condition on invoice.payment_succeeded */
        metadata: {
          customerName:  customerName       || '',
          customerEmail: customerEmail      || '',
          phone:         phone              || '',
          address:       address            || '',
          unit:          unit               || '',
          complex:       complex            || '',
          serviceId:     serviceId          || '',
          freq:          freq               || 'monthly',
          amount:        String(amount),
          photoConsent:  photoConsent ? 'true' : 'false',
          hasPets:       hasPets       ? 'true' : 'false',
          source:        'booking-page'
        }
      });

      const pi = subscription.latest_invoice.payment_intent;

      /* ── Mirror subscriber record to Firebase ── */
      try {
        await db.collection('subscriptions').doc(subscription.id).set({
          subscriptionId: subscription.id,
          customerId:     customer.id,
          name:           customerName  || '',
          email:          customerEmail || '',
          phone:          phone         || '',
          address:        address       || '',
          unit:           unit          || '',
          complex:        complex       || '',
          serviceId:      serviceId     || '',
          freq:           freq          || 'monthly',
          amount:         Number(amount),
          status:         'active',
          consecutiveUnusedCycles: 0,
          createdAt:      admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (fbErr) {
        /* Non-fatal — Stripe metadata is the source of truth for the webhook */
        console.warn('Firebase subscription write failed:', fbErr.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ clientSecret: pi.client_secret, subscriptionId: subscription.id })
      };

    } else {
      /* ── One-time payment ── */
      const intent = await stripe.paymentIntents.create({
        amount:        Math.round(amount * 100),
        currency:      'usd',
        description:   description    || 'Pullman Home Cleaning',
        receipt_email: customerEmail  || undefined,
        metadata: {
          customerName:  customerName  || '',
          customerEmail: customerEmail || '',
          source:        'booking-page'
        }
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ clientSecret: intent.client_secret })
      };
    }

  } catch (err) {
    console.error('Payment failed:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
