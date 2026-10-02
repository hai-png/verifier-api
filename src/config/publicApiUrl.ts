/**
 * The public base URL of this API, or '' when it is not configured.
 *
 * Only RENDER_EXTERNAL_URL counts. VERITAS_APP_URL names the dashboard, and every
 * URL built from it is a frontend page, so it must never stand in for the API.
 * It used to: the keep-alive pinger fell back to it, aimed itself at a static
 * site that answers 404 on /ready, and reported success while the Render
 * instance idled out. The status page then kept reporting the keep-alive as
 * configured, because the two call sites had drifted onto different variables
 * and the diagnostic could not see what the pinger actually did.
 *
 * So this is the single place that resolves it. Anything that needs to address
 * the API itself — the keep-alive pinger, the status page — reads this. Anything
 * that builds a link a human clicks reads resolveAppUrl() instead.
 *
 * KEEP_ALIVE_URL exists because RENDER_EXTERNAL_URL is set by Render and, on
 * this service, holds an onrender.com hostname that is not routed here, so the
 * pinger 404ed on /ready every five minutes. That variable is awkward to correct
 * in the dashboard; this one is not.
 *
 * Trailing slashes are stripped so callers can append a path directly.
 */
export function resolvePublicApiUrl(): string {
    const configured = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    return configured.replace(/\/+$/, '');
}
