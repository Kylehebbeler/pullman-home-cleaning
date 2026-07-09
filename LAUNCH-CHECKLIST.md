# Pullman Home Cleaning — Launch Checklist

**Relax about attempts: Netlify does NOT limit deploys.** You can push fixes 50 times today if you want. The only thing you can't easily undo is a bad first impression with a real customer — so we verify everything in Step 6 before promoting the site.

---

## Step 0 — Fix the Stripe key (BLOCKER — do this first)

`booking.html` line 210 has a **TEST** publishable key. Real customers' cards will be declined until this is swapped.

1. Go to https://dashboard.stripe.com → toggle **"Test mode" OFF** (top right)
2. Developers → API keys → copy the **Publishable key** (`pk_live_...`)
3. Replace the `pk_test_51ThBjJ...` key in booking.html with it
   (or paste the key to Claude and it'll be swapped for you)

While you're there, also copy the **Secret key** (`sk_live_...`) — you'll need it in Step 3. Never put the secret key in any HTML file.

---

## Step 1 — Push the code to GitHub

1. Open the `website` folder
2. Double-click **PUSH-TO-GITHUB.bat**
3. Confirm it ends with "Done!" and check https://github.com/Kylehebbeler/pullman-home-cleaning shows today's date

---

## Step 2 — Connect Netlify to the repo

Your current live site (storied-khapse-ebc8b5.netlify.app) is the OLD version. We update that same site so any printed QR codes keep working.

1. Log in at https://app.netlify.com → open your site
2. **Site configuration → Build & deploy → Continuous deployment**
3. If it already shows the GitHub repo → a deploy triggered when you pushed; skip to Step 3
4. If it says "Not linked" → click **Link repository** → GitHub → `pullman-home-cleaning` → branch `main` → deploy
   - Publish directory: `.`  · Functions directory: `netlify/functions` (netlify.toml sets these automatically)

---

## Step 3 — Set environment variables in Netlify

Site configuration → **Environment variables** → Add each of these:

| Variable | Value / where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` from Stripe (Step 0) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` — created in Step 4, come back and add it |
| `FIREBASE_SERVICE_ACCOUNT` | Firebase console → Project settings (gear) → Service accounts → **Generate new private key** → open the downloaded JSON → paste the ENTIRE contents as one line |
| `RESEND_API_KEY` | https://resend.com → API Keys |
| `EMAILJS_PUBLIC_KEY` | `hgNTK0-romAlWB7Ls` (already in your frontend — it's public, that's fine) |
| `CRM_PASSWORD` | Make up a STRONG password — this protects all your customer data |
| `CLEANER_EMAIL` | Email address where cleaner job notifications go |
| `GOOGLE_REVIEW_URL` | Your Google Business review link |
| `SITE_URL` | `https://pullmanhomecleaning.com` |

**Important:** after adding/changing env vars, trigger a redeploy (Deploys → Trigger deploy → Deploy site) so functions pick them up.

---

## Step 4 — Stripe webhook (live mode)

This is what keeps subscriptions working (payment succeeded/failed handling).

1. Stripe dashboard, **Live mode** → Developers → Webhooks → **Add endpoint**
2. Endpoint URL: `https://storied-khapse-ebc8b5.netlify.app/.netlify/functions/stripe-webhook`
   (use the netlify.app URL — it works immediately and keeps working after the custom domain is added)
3. Select events: `invoice.payment_succeeded` and `invoice.payment_failed`
4. Copy the **Signing secret** (`whsec_...`) → add as `STRIPE_WEBHOOK_SECRET` in Netlify (Step 3) → redeploy

---

## Step 5 — Connect pullmanhomecleaning.com

1. Netlify → **Domain management → Add a domain** → enter `pullmanhomecleaning.com`
2. Easiest path: choose **Netlify DNS** and update the nameservers at the registrar where you bought the domain (Netlify shows you the 4 nameservers to paste)
3. HTTPS certificate is automatic — can take a few minutes to an hour after DNS propagates
4. The old storied-khapse URL keeps serving the site, so existing QR codes still work

---

## Step 6 — Verify EVERYTHING (before telling anyone)

- [ ] Open pullmanhomecleaning.com on your phone AND computer
- [ ] Click every pricing button → confirms correct service loads in the booking calendar
- [ ] **Make a real booking yourself with a real card** (cheapest service, $45):
  - [ ] Payment appears in Stripe (live mode)
  - [ ] Booking appears in Firestore
  - [ ] Confirmation email arrives
  - [ ] The time slot disappears from the calendar
  - [ ] Then **refund yourself** in Stripe (Payments → select → Refund)
- [ ] Test the cancel link in the confirmation email
- [ ] Log into crm.html with your new CRM password
- [ ] Check terms.html and policies.html links in the footer load
- [ ] FAQ says customer must be home at the start ✓ (already verified)

## After launch
- [ ] Update Instagram bio / Google Business / door hangers to pullmanhomecleaning.com
- [ ] Set up Stripe payout bank account (Live mode → Settings → Payouts) if not done
