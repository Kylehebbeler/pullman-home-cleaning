/* ═══════════════════════════════════════════════════════════════════
   Netlify Scheduled Function: check-subscription-health
   Runs daily at 10 AM UTC (configured in netlify.toml).

   Does two things every day:
   1. NUDGE — if a token is 5+ days old and the customer hasn't booked,
      send a reminder email with their booking link.
   2. AUTO-PAUSE — if a token has expired completely unused (30 days),
      increment that subscription's consecutiveUnusedCycles counter.
      After 3 consecutive unused cycles, pause the Stripe subscription
      and notify the customer.

   ENVIRONMENT VARIABLES (same as other functions):
     STRIPE_SECRET_KEY
     FIREBASE_SERVICE_ACCOUNT
     EMAILJS_PUBLIC_KEY
     SITE_URL
   ═══════════════════════════════════════════════════════════════════ */

const Stripe = require('stripe');
const admin  = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = admin.firestore();

const SERVICE_NAMES = {
  qc2: 'Quick Clean — 2 Bathrooms',
  wh1: 'Whole Home — Studio / 1 Bath',
  wh2: 'Whole Home — 2-Bath Home',
  wh3: 'Whole Home — 3-Bath Home',
  dc1: 'Deep Clean — Studio / 1 Bath',
  dc2: 'Deep Clean — 2-Bath Home',
  dc3: 'Deep Clean — 3-Bath Home',
};

const UNUSED_CYCLES_BEFORE_PAUSE = 3;

/* ─── EmailJS helper ──────────────────────────────────────────── */
async function sendEmail(templateId, params) {
  const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id:      'service_5llh4ic',
      template_id:     templateId,
      user_id:         process.env.EMAILJS_PUBLIC_KEY,
      template_params: params
    })
  });
  if (!resp.ok) throw new Error(`EmailJS ${templateId} failed: ${await resp.text()}`);
}

/* ─── Main handler ────────────────────────────────────────────── */
exports.handler = async () => {
  const now        = new Date();
  const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000);
  const siteUrl    = (process.env.SITE_URL || 'https://pullmanhomecleaning.com').replace(/\/$/, '');
  const stripe     = new Stripe(process.env.STRIPE_SECRET_KEY);

  const results = { nudges: 0, expired: 0, paused: 0, errors: [] };

  try {
    /* Fetch all tokens that are not yet used and not yet marked expired.
       Filter by date in JS — avoids needing a composite Firestore index. */
    const snap = await db.collection('subscriptionTokens')
      .where('used', '==', false)
      .where('expired', '==', false)
      .get();

    for (const doc of snap.docs) {
      const token     = doc.data();
      const createdAt = token.createdAt?.toDate?.() || new Date(0);
      const expiresAt = token.expiresAt?.toDate?.() || new Date(0);
      const tokenId   = doc.id;

      /* ── TOKEN EXPIRED ────────────────────────────────────────── */
      if (expiresAt <= now) {
        try {
          await handleExpiredToken(doc, token, tokenId, stripe, siteUrl, results);
        } catch(e) {
          console.error(`Error handling expired token ${tokenId}:`, e.message);
          results.errors.push(`expired:${tokenId}: ${e.message}`);
        }
        continue;
      }

      /* ── NUDGE (5+ days old, no nudge sent yet) ───────────────── */
      if (createdAt <= fiveDaysAgo && !token.nudgeSentAt) {
        try {
          await sendNudge(doc, token, tokenId, siteUrl);
          results.nudges++;
        } catch(e) {
          console.error(`Error sending nudge for token ${tokenId}:`, e.message);
          results.errors.push(`nudge:${tokenId}: ${e.message}`);
        }
      }
    }
  } catch(e) {
    console.error('Health check fatal error:', e.message);
    return { statusCode: 500, body: e.message };
  }

  console.log('Subscription health check complete:', results);
  return { statusCode: 200, body: JSON.stringify(results) };
};

/* ─── Send 5-day nudge email ──────────────────────────────────── */
async function sendNudge(doc, token, tokenId, siteUrl) {
  const bookingLink  = `${siteUrl}/booking.html?token=${tokenId}`;
  const expiresAt    = token.expiresAt.toDate();
  const daysLeft     = Math.ceil((expiresAt - new Date()) / (1000 * 60 * 60 * 24));
  const expiresStr   = expiresAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const serviceName  = SERVICE_NAMES[token.serviceId] || token.serviceId;
  const freqLabel    = token.freq === 'biweekly' ? 'bi-weekly' : 'monthly';

  await sendEmail('template_booking_nudge', {
    customer_name:  token.name,
    customer_email: token.email,
    service_name:   serviceName,
    booking_link:   bookingLink,
    freq_label:     freqLabel,
    days_left:      String(daysLeft),
    expires_date:   expiresStr
  });

  await doc.ref.update({ nudgeSentAt: admin.firestore.FieldValue.serverTimestamp() });
  console.log(`Nudge sent to ${token.email} for token ${tokenId}`);
}

/* ─── Handle an expired unused token ─────────────────────────── */
async function handleExpiredToken(doc, token, tokenId, stripe, siteUrl, results) {
  /* Mark token as expired */
  await doc.ref.update({
    expired:   true,
    expiredAt: admin.firestore.FieldValue.serverTimestamp()
  });
  results.expired++;
  console.log(`Token expired: ${tokenId} (sub: ${token.subscriptionId})`);

  if (!token.subscriptionId) return;

  /* Increment consecutive unused cycle counter on the subscription */
  const subRef  = db.collection('subscriptions').doc(token.subscriptionId);
  const subSnap = await subRef.get();

  /* If subscription doc doesn't exist yet, create a minimal one */
  if (!subSnap.exists) {
    await subRef.set({
      subscriptionId:          token.subscriptionId,
      email:                   token.email,
      name:                    token.name,
      consecutiveUnusedCycles: 1,
      status:                  'active',
      createdAt:               admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Created subscription doc for ${token.subscriptionId} with counter=1`);
    return;
  }

  const subData = subSnap.data();

  /* If already paused, skip further processing */
  if (subData.status === 'paused') {
    console.log(`Subscription ${token.subscriptionId} already paused — skipping`);
    return;
  }

  const newCount = (subData.consecutiveUnusedCycles || 0) + 1;
  await subRef.update({ consecutiveUnusedCycles: newCount });
  console.log(`Sub ${token.subscriptionId} consecutive unused cycles: ${newCount}`);

  /* ── AUTO-PAUSE after threshold ── */
  if (newCount >= UNUSED_CYCLES_BEFORE_PAUSE) {
    await pauseSubscription(token, subRef, stripe, siteUrl);
    results.paused++;
  }
}

/* ─── Pause the Stripe subscription and notify the customer ───── */
async function pauseSubscription(token, subRef, stripe, siteUrl) {
  const subscriptionId = token.subscriptionId;
  console.log(`Auto-pausing subscription ${subscriptionId} for ${token.email}`);

  /* Pause collection in Stripe (stops charges, keeps subscription alive for resume) */
  try {
    await stripe.subscriptions.update(subscriptionId, {
      pause_collection: { behavior: 'void' }
    });
  } catch(stripeErr) {
    /* Subscription may have already been canceled in Stripe — log but continue */
    console.warn(`Stripe pause failed for ${subscriptionId}:`, stripeErr.message);
  }

  /* Update Firebase */
  await subRef.update({
    status:      'paused',
    pausedAt:    admin.firestore.FieldValue.serverTimestamp(),
    pauseReason: 'unused_3_cycles'
  });

  /* Email the customer */
  const serviceName = SERVICE_NAMES[token.serviceId] || token.serviceId;
  const freqLabel   = token.freq === 'biweekly' ? 'bi-weekly' : 'monthly';

  try {
    await sendEmail('template_subscription_paused', {
      customer_name:  token.name,
      customer_email: token.email,
      service_name:   serviceName,
      freq_label:     freqLabel,
      contact_email:  'pullmanhomecleaning@gmail.com'
    });
  } catch(emailErr) {
    console.warn(`Pause notification email failed for ${token.email}:`, emailErr.message);
  }

  console.log(`Subscription ${subscriptionId} paused and customer notified`);
}
