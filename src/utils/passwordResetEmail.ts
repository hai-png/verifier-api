/**
 * passwordResetEmail.ts
 *
 * Sends password-reset links via Resend (same rail as purchase emails).
 * If RESEND_API_KEY / VERITAS_NOTIFICATIONS_FROM_EMAIL are not configured the
 * caller falls back to admin-assisted resets (POST /admin/password-reset-link).
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isResetEmailConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.VERITAS_NOTIFICATIONS_FROM_EMAIL?.trim()
  );
}

export interface SendPasswordResetEmailInput {
  to: string;
  name?: string | null;
  resetUrl: string;
  /** Token lifetime in minutes — shown to the user. */
  ttlMinutes: number;
}

export async function sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const fromEmail = process.env.VERITAS_NOTIFICATIONS_FROM_EMAIL?.trim();
  if (!resendKey || !fromEmail) {
    throw new Error('RESEND_API_KEY and VERITAS_NOTIFICATIONS_FROM_EMAIL are required for password reset emails.');
  }

  const displayName = input.name?.trim() || input.to;

  const text = [
    `Hi ${displayName},`,
    '',
    'Someone (hopefully you) requested a password reset for your payment verification dashboard account.',
    '',
    `Reset your password: ${input.resetUrl}`,
    '',
    `This link expires in ${input.ttlMinutes} minutes and can be used once.`,
    'If you did not request this, you can safely ignore this email — your password is unchanged.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
      <h2 style="margin: 0 0 16px;">Reset your password</h2>
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>Someone (hopefully you) requested a password reset for your payment verification dashboard account.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(input.resetUrl)}"
           style="background: #4f46e5; color: #fff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">
          Reset password
        </a>
      </p>
      <p style="color: #64748b; font-size: 13px;">
        This link expires in ${input.ttlMinutes} minutes and can be used once.<br/>
        If you did not request this, ignore this email — your password is unchanged.
      </p>
    </div>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [input.to],
      subject: 'Reset your dashboard password',
      text,
      html,
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      `Password reset email failed: ${response.status} ${response.statusText} ${data ? JSON.stringify(data) : ''}`.trim()
    );
  }
}
