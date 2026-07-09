/**
 * _mailer.js -- shared email utility for all Pullman Home Cleaning automation functions.
 *
 * Sends via Resend (resend.com) using the verified sending domain send.pullmanhomecleaning.com.
 *
 * Required Netlify env var (one-time setup):
 *   RESEND_API_KEY -- API key from resend.com/api-keys
 *   (Netlify -> Site configuration -> Environment variables -> Add variable)
 */

'use strict';

const FROM_ADDRESS = 'Pullman Home Cleaning <noreply@send.pullmanhomecleaning.com>';
const SITE_URL     = process.env.SITE_URL || 'https://pullmanhomecleaning.com';

/**
 * Send a transactional email via Resend.
 * @param {object} opts
 * @param {string} opts.to        Recipient email address
 * @param {string} opts.subject   Email subject line
 * @param {string} opts.html      Full HTML body
 */
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY env var is not set. Add it in Netlify -> Site configuration -> Environment variables.');
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html
    })
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend error ${resp.status}: ${text}`);
  }
  return resp.json();
}

/**
 * Wrap email content in the shared branded template.
 * @param {string} bodyHtml  Inner HTML content (goes inside the white card)
 */
function wrap(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F9F7F4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9F7F4;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:560px;">

          <!-- Header bar -->
          <tr>
            <td style="background:#0B6E72;padding:22px 32px;border-radius:12px 12px 0 0;text-align:center;">
              <span style="color:#ffffff;font-size:17px;font-weight:600;letter-spacing:-0.2px;">Pullman Home Cleaning</span>
            </td>
          </tr>

          <!-- White card body -->
          <tr>
            <td style="background:#ffffff;padding:32px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f3f4f6;padding:18px 32px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;text-align:center;">
              <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.7;">
                Pullman Home Cleaning &middot; Pullman, WA<br>
                <a href="${SITE_URL}" style="color:#0B6E72;text-decoration:none;">${SITE_URL.replace('https://', '')}</a>
                &nbsp;&middot;&nbsp;
                <a href="mailto:pullmanhomecleaning@gmail.com" style="color:#0B6E72;text-decoration:none;">pullmanhomecleaning@gmail.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { sendEmail, wrap, SITE_URL };
