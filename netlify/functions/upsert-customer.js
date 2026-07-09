/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: upsert-customer
   Called after every successful booking to maintain the CRM.

   Creates or updates a document in Firestore `customers` collection,
   keyed by normalized email address.

   Firestore `customers/{email}` schema:
   {
     email:               string  — normalized (lowercase, trimmed)
     name:                string  — most recent name used
     phone:               string  — most recent phone used
     firstBookedAt:       Timestamp
     lastBookedAt:        Timestamp
     bookingCount:        number  — incremented each booking
     totalRevenue:        number  — lifetime spend in dollars
     referralSource:      string  — how they first heard about us
     notes:               string  — most recent cleaner notes / preferences
     address:             string  — most recent service address
     subscriptionActive:  boolean
     frequency:           string  — 'once' | 'biweekly' | 'monthly'
     subscriptionIds:     array   — all Stripe subscription IDs
     bookingIds:          array   — all Firestore booking doc IDs
     tags:                array   — e.g. ['vip','repeat','churn-risk']
     photoConsent:        boolean — true if customer ever opted in to photo use
     termsAgreedAt:       string  — ISO timestamp of first terms agreement
     autoRenewalAgreedAt: string  — ISO timestamp of auto-renewal consent (subscriptions only)
   }
   ═══════════════════════════════════════════════════════════════════ */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db  = admin.firestore();
const fv  = admin.firestore.FieldValue;

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
      email,
      name,
      phone,
      address,
      notes,
      service,
      price,
      frequency,
      subscriptionActive,
      subscriptionId,
      bookingId,
      referralSource,
      photoConsent,
      termsAgreedAt,
      autoRenewalAgreedAt,
      hasPets
    } = JSON.parse(event.body);

    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing email' }) };
    }

    const key = email.toLowerCase().trim();
    const ref = db.collection('customers').doc(key);
    const snap = await ref.get();

    const now = admin.firestore.Timestamp.now();

    if (!snap.exists) {
      // First-time customer
      const doc = {
        email:               key,
        name:                name  || '',
        phone:               phone || '',
        address:             address || '',
        notes:               notes || '',
        service:             service || '',
        firstBookedAt:       now,
        lastBookedAt:        now,
        bookingCount:        1,
        totalRevenue:        Number(price) || 0,
        referralSource:      referralSource || 'unknown',
        frequency:           frequency || 'once',
        subscriptionActive:  Boolean(subscriptionActive),
        subscriptionIds:     subscriptionId ? [subscriptionId] : [],
        bookingIds:          bookingId      ? [bookingId]      : [],
        tags:                [],
        photoConsent:        Boolean(photoConsent),
        termsAgreedAt:       termsAgreedAt || new Date().toISOString(),
        autoRenewalAgreedAt: autoRenewalAgreedAt || null,
        hasPets:             Boolean(hasPets)
      };
      await ref.set(doc);
    } else {
      // Returning customer
      const update = {
        name:               name  || snap.data().name,
        phone:              phone || snap.data().phone,
        address:            address || snap.data().address,
        lastBookedAt:       now,
        bookingCount:       fv.increment(1),
        totalRevenue:       fv.increment(Number(price) || 0),
        frequency:          frequency || snap.data().frequency,
        subscriptionActive: Boolean(subscriptionActive),
        service:            service || snap.data().service
      };

      // Only overwrite notes if the customer provided new ones
      if (notes && notes.trim()) update.notes = notes.trim();

      // Append IDs without duplicating
      if (subscriptionId) update.subscriptionIds = fv.arrayUnion(subscriptionId);
      if (bookingId)      update.bookingIds      = fv.arrayUnion(bookingId);

      // Auto-tag as repeat after 2+ bookings
      const prevCount = snap.data().bookingCount || 0;
      if (prevCount >= 1) update.tags = fv.arrayUnion('repeat');

      // photoConsent: once given, never revoked here
      if (photoConsent) update.photoConsent = true;

      // autoRenewalAgreedAt: only set if not already stored
      if (autoRenewalAgreedAt && !snap.data().autoRenewalAgreedAt) {
        update.autoRenewalAgreedAt = autoRenewalAgreedAt;
      }

      // Keep original referralSource and termsAgreedAt

      // hasPets: once set to true, stays true (pets don't disappear)
      if (hasPets) update.hasPets = true;

      await ref.update(update);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, customer: key })
    };

  } catch (err) {
    console.error('upsert-customer error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
