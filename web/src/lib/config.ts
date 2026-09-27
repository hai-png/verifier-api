/**
 * Build-time configuration for the dashboard.
 *
 * `NEXT_PUBLIC_*` values are inlined into the client bundle by Next.js at build
 * time, so this is the one place that decides where the browser sends
 * credentials, session tokens and API keys.
 *
 * The base URL used to be spelled out six times — in lib/api.ts, app/page.tsx,
 * app/verify/page.tsx, app/pl/page.tsx, app/status/page.tsx and
 * components/VerifyForm.tsx — each with its own copy of the same fallback:
 * `https://verifier-api-selfhosted.onrender.com`, a server this repository does
 * not control. This is the `selfhosted` branch: anyone who forks it and forgets
 * to set NEXT_PUBLIC_API_URL would have had their login POST, their bearer token
 * and their verification API keys delivered to that third-party host instead of
 * their own, silently and with a valid TLS certificate. Six copies also meant six
 * places to get wrong, and they had already drifted in quoting and in whether the
 * trailing slash was stripped.
 *
 * There is now one definition, and no third-party default: when the variable is
 * unset the base is same-origin, which fails visibly against your own domain
 * instead of quietly succeeding against someone else's.
 */

const configured = (process.env.NEXT_PUBLIC_API_URL ?? "").trim();

/** Absolute base URL of the verifier-api, without a trailing slash. */
export const API_BASE: string = configured.replace(/\/+$/, "");

/** True when the build did not pin an API origin. */
export const API_BASE_IS_UNSET: boolean = configured === "";

if (API_BASE_IS_UNSET && typeof window !== "undefined") {
  // Same-origin requests. On a static export served from Cloudflare Pages (see
  // next.config.ts) there is no API on that origin, so every call 404s — loudly,
  // and against a host the operator controls.
  console.warn(
    "[verifier-dashboard] NEXT_PUBLIC_API_URL was not set at build time, so API calls are being sent to this " +
      "origin. Rebuild with NEXT_PUBLIC_API_URL=https://your-api.example.com — see web/.env.example.",
  );
}

/** Where the API sends users in password-reset emails; must match VERITAS_APP_URL. */
export const APP_URL: string = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
