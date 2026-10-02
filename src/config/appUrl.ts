/**
 * The public base URL of the web app — the dashboard people actually click on.
 *
 * Distinct from resolvePublicApiUrl(), which addresses the API itself. The two
 * used to be the same variable, which is how every user-facing link ended up
 * aimed at a JSON API: VERITAS_APP_URL was set to the API host, and the auth
 * router is mounted at /auth, so /reset-password, /pl/<id> and
 * /dashboard/billing all fell past every router and landed on apiKeyAuth. A
 * password-reset email, a customer payment link and an upgrade link each
 * answered 401.
 *
 * Everything built from here is a frontend route: the reset-password page, the
 * hosted payment page, the billing page. If you add a link, it wants this, not
 * the API URL.
 *
 * Trailing slashes are stripped so callers can append a path directly.
 */
export function resolveAppUrl(): string {
    return (process.env.VERITAS_APP_URL || 'https://dashboard.noveld.com.et').replace(/\/+$/, '');
}
