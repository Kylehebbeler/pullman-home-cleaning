/* ═══════════════════════════════════════════════════════════════════
   Netlify Function: get-customers
   Returns all customer CRM data for the admin dashboard.

   Protected by a shared secret set in Netlify env vars:
     CRM_PASSWORD = <your chosen password>

   POST body: { password: "..." }
   Returns: { customers: [...] }
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
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { password } = JSON.parse(event.body || '{}');

    if (!process.env.CRM_PASSWORD || password !== process.env.CRM_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const snap = await db.collection('customers').orderBy('lastBookedAt', 'desc').get();

    const customers = snap.docs.map(doc => {
      const d = doc.data();
      return {
        ...d,
        // Convert Firestore Timestamps to ISO strings for JSON serialization
        firstBookedAt: d.firstBookedAt ? d.firstBookedAt.toDate().toISOString() : null,
        lastBookedAt:  d.lastBookedAt  ? d.lastBookedAt.toDate().toISOString()  : null
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ customers })
    };

  } catch (err) {
    console.error('get-customers error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
