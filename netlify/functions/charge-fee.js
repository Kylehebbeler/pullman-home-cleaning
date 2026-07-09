/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: charge-fee
   Admin-triggered fee collection (lockout 50%, or late cancel 25%
   when the automated path couldn't charge). Protected by CRM_PASSWORD.

   POST body:
     { password, email, feeType, bookingPrice, bookingDate, service, subscriptionId }

   feeType: 'lockout' (50%) | 'late_cancel' (25%)

   Charging strategy:
     - Subscription customers: charge directly to their stored Stripe
       payment method (off-session PaymentIntent).
     - One-time customers: create a Stripe invoice and email it to the
       customer — they pay via a hosted Stripe link.

   ENVIRONMENT VARIABLES:
     STRIPE_SECRET_KEY
     FIREBASE_SERVICE_ACCOUNT
     CRM_PASSWORD
   ═══════════════════════════════════════════════════════════════════ */

const Stripe = require('stripe');
const admin  = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const FEE_RATES = { lockout: 0.50, late_cancel: 0.25 };

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
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const {
      password,
      email,
      feeType,
      bookingPrice,
      bookingDate,
      service,
      subscriptionId   // present for subscription customers
    } = JSON.parse(event.body);

    /* ── Auth ── */
    if (!process.env.CRM_PASSWORD || password !== process.env.CRM_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    /* ── Validate inputs ── */
    if (!email || !feeType || !bookingPrice) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: email, feeType, bookingPrice' }) };
    }
    const rate = FEE_RATES[feeType];
    if (!rate) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown feeType "${feeType}". Use 'lockout' or 'late_cancel'.` }) };
    }

    const stripe     = new Stripe(process.env.STRIPE_SECRET_KEY);
    const feeAmount  = Math.round(Number(bookingPrice) * rate * 100); // cents
    const feeLabel   = feeType === 'lockout' ? 'Lockout fee (50%)' : 'Late cancellation fee (25%)';
    const description = `${feeLabel} — ${service || 'cleaning'}${bookingDate ? ' on ' + bookingDate : ''}`;

    let chargeMethod = null;
    let result       = {};

    /* ── Strategy 1: subscription customer — charge directly ── */
    if (subscriptionId) {
      const sub  = await stripe.subscriptions.retrieve(subscriptionId);
      const pmId = sub.default_payment_method
                || (await stripe.customers.retrieve(sub.customer)).invoice_settings?.default_payment_method;

      if (!pmId) {
        return { statusCode: 422, headers, body: JSON.stringify({ error: 'No stored payment method on this subscription. Use invoice method instead.' }) };
      }

      const pi = await stripe.paymentIntents.create({
        amount:         feeAmount,
        currency:       'usd',
        customer:       sub.customer,
        payment_method: pmId,
        confirm:        true,
        off_session:    true,
        description,
        receipt_email:  email || undefined,
        metadata:       { type: feeType, customerEmail: email, originalPrice: String(bookingPrice) }
      });

      chargeMethod = 'direct';
      result       = { paymentIntentId: pi.id, amountCharged: feeAmount / 100 };

    /* ── Strategy 2: one-time customer — try stored PM first, fall back to invoice ── */
    } else {
      /* Find or create Stripe customer by email */
      const existing = await stripe.customers.list({ email, limit: 1 });
      const customer = existing.data.length > 0
        ? existing.data[0]
        : await stripe.customers.create({ email, metadata: { source: 'charge-fee-admin' } });

      /* Try to find a saved payment method from their last booking PaymentIntent */
      let directCharged = false;
      try {
        /* Look up the customer's most recent paymentIntentId from Firestore */
        const custSnap = await db.collection('customers').where('email', '==', email).limit(1).get();
        const custData = custSnap.empty ? null : custSnap.docs[0].data();
        const piId = custData?.paymentIntentId;

        if (piId) {
          const pi = await stripe.paymentIntents.retrieve(piId);
          const pmId = pi.payment_method;
          /* Attach PM to the Stripe customer if not already attached */
          if (pmId && pi.customer !== customer.id) {
            await stripe.paymentMethods.attach(pmId, { customer: customer.id });
            await stripe.customers.update(customer.id, {
              invoice_settings: { default_payment_method: pmId }
            });
          }
          if (pmId) {
            const directPi = await stripe.paymentIntents.create({
              amount:         feeAmount,
              currency:       'usd',
              customer:       customer.id,
              payment_method: pmId,
              confirm:        true,
              off_session:    true,
              description,
              receipt_email:  email,
              metadata:       { type: feeType, customerEmail: email, originalPrice: String(bookingPrice) }
            });
            chargeMethod  = 'direct';
            result        = { paymentIntentId: directPi.id, amountCharged: feeAmount / 100 };
            directCharged = true;
          }
        }
      } catch (pmErr) {
        /* Card declined, auth required, or no PM — fall through to invoice */
        console.warn('Direct charge attempt failed, falling back to invoice:', pmErr.message);
      }

      if (!directCharged) {
        /* Fall back: send a Stripe invoice */
        const inv = await stripe.invoices.create({
          customer:          customer.id,
          collection_method: 'send_invoice',
          days_until_due:    7,
          description,
          metadata:          { type: feeType, customerEmail: email, originalPrice: String(bookingPrice) }
        });

        await stripe.invoiceItems.create({
          customer:    customer.id,
          invoice:     inv.id,
          amount:      feeAmount,
          currency:    'usd',
          description
        });

        const finalInvoice = await stripe.invoices.sendInvoice(inv.id);

        chargeMethod = 'invoice';
        result       = {
          invoiceId:  finalInvoice.id,
          invoiceUrl: finalInvoice.hosted_invoice_url,
          amountDue:  feeAmount / 100,
          dueDate:    new Date(finalInvoice.due_date * 1000).toLocaleDateString('en-US')
        };
      }
    }

    /* -- Log fee to Firestore for records -- */
    try {
      await db.collection('feeCharges').add({
        email,
        feeType,
        rate:          rate * 100 + '%',
        bookingPrice:  Number(bookingPrice),
        feeAmount:     feeAmount / 100,
        description,
        chargeMethod,
        subscriptionId: subscriptionId || null,
        ...result,
        chargedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (logErr) {
      console.warn('feeCharges log failed (non-fatal):', logErr.message);
    }

    console.log('Fee charged via ' + chargeMethod + ' for ' + email);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, chargeMethod, feeAmount: feeAmount / 100, ...result }) };

  } catch (err) {
    console.error('charge-fee error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
