import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY || "";
const resend = apiKey ? new Resend(apiKey) : null;
const FROM = "XRPLink <noreply@xrp-link.com>";

export async function sendWelcomeEmail(email: string, apiKeyValue: string) {
  if (!resend) return console.log("Resend not configured — skipping welcome email to", email);
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Welcome to XRPLink",
    html: `<p>Your XRPLink account is ready.</p>
<p>Your API key is:</p>
<pre style="background:#f1f5f9;padding:1rem;border-radius:6px;font-size:0.85rem">${apiKeyValue}</pre>
<p>Use it to generate cryptographically verified XRP payment receipts.</p>
<p><a href="https://xrp-link.com">Go to Dashboard →</a></p>`,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  if (!resend) return console.log("Resend not configured — skipping password reset email to", email);
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Reset your XRPLink password",
    html: `<p>Reset your password here:</p>
<p><a href="https://xrp-link.com/auth/reset-password?token=${token}">Reset Password →</a></p>
<p>This link expires in 1 hour.</p>`,
  });
}
