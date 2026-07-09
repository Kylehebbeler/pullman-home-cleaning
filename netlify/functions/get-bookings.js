/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: get-bookings
   Returns all bookings for a given customer email. Admin-only.

   POST body: { password, email }

   Returns: { bookings: [ { id, date, time, service, price, paid,
                            paidViaSubscription, status, createdAt } ] }

   ENVIRONMENT VARIABLES:
     FIREBASE_SERVICE_ACCOUNT
     CRM_PASSWORD
   ═══════════════════════════════════════════════════════════════════ */

const admin = require('firebase-admin');

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
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { password, email } = JSON.parse(event.body);

    if (!process.env.CRM_PASSWORD || password !== process.env.CRM_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'email required' }) };
    }

    /* Query bookings collection by email, newest first */
    const snap = await db.collection('bookings')
      .where('email', '==', email)
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    const bookings = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id:                  doc.id,
        date:                d.date        || null,
        time:                d.time        || null,
        service:             d.service     || null,
        price:               d.price       || 0,
        paid:                d.paid        || false,
        paidViaSubscription: d.paidViaSubscription || false,
        paymentIntentId:     d.paymentIntentId || null,
        subscriptionId:      d.subscriptionId  || null,
        status:              d.status      || 'confirmed',
        createdAt:           d.createdAt   || null,
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ bookings }) };

  } catch (err) {
    console.error('get-bookings error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
