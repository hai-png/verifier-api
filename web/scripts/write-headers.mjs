#!/usr/bin/env node
/**
 * Rewrites `out/_headers` so the Content-Security-Policy allows exactly the API
 * origin this build was configured for.
 *
 * Why this exists: `web/public/_headers` is copied verbatim by `next build`, and
 * `output: "export"` gives us no `headers()` block to compute anything with. The
 * policy therefore has to be a static file — but the origin it must permit is not
 * static, it is whatever `NEXT_PUBLIC_API_URL` was at build time.
 *
 * A hand-maintained file gets this wrong in both directions at once, and did: it
 * listed `https://verify.noveld.com.et` (one deployment) plus `https://*.onrender.com`.
 * The wildcard authorized the dashboard to send its bearer token to *any* Render
 * app — anyone who registers a subdomain there — so the CSP provided no
 * exfiltration protection against an entire third-party PaaS. And it did not
 * permit a self-hoster's own origin, so a correctly-configured fork had its API
 * calls blocked by its own security policy.
 *
 * The checked-in default is same-origin only: fail-closed. This script widens it
 * to the configured origin, and only to that origin.
 *
 * Runs as the second half of `npm run build`. If you invoke `next build` directly
 * you still get valid headers, just the same-origin default.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(webRoot, "out", "_headers");
const templateFile = path.join(webRoot, "public", "_headers");

const fail = (message) => {
  console.error(`[write-headers] ${message}`);
  process.exit(1);
};

/**
 * The configured API origin, or null for same-origin.
 *
 * Mirrors the normalisation in src/lib/config.ts (trim, strip trailing slashes)
 * and then reduces to `URL.origin`, so a path, query string or fragment in the
 * variable cannot widen the CSP.
 */
function configuredOrigin() {
  const raw = (process.env.NEXT_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (raw === "") return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`NEXT_PUBLIC_API_URL is not an absolute URL: ${JSON.stringify(raw)}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`NEXT_PUBLIC_API_URL must be http(s), got ${url.protocol}`);
  }
  // The specific defect this script exists to prevent. A wildcard host in
  // connect-src hands the token to every subdomain of someone else's platform.
  if (url.hostname.includes("*")) {
    fail(`NEXT_PUBLIC_API_URL must be a single origin, wildcards are not allowed: ${url.hostname}`);
  }
  return url.origin;
}

if (!fs.existsSync(templateFile)) {
  fail(`missing template ${path.relative(webRoot, templateFile)}`);
}
if (!fs.existsSync(outFile)) {
  fail(
    `missing ${path.relative(webRoot, outFile)} — run "next build" first ` +
      `(output: "export" must still be set in next.config.ts)`,
  );
}

const origin = configuredOrigin();
const connectSrc = origin ? `connect-src 'self' ${origin}` : "connect-src 'self'";

const template = fs.readFileSync(templateFile, "utf8");
const lines = template.split("\n");

// Rewrite only the Content-Security-Policy header line.
//
// The first version of this script substituted `connect-src[^;]*` across the whole
// file. `[^;]` matches a newline, and this file's explanatory comments mention
// connect-src before the header does — so the match ran from a comment through to
// the real directive and replaced both, leaving out/_headers with no CSP at all.
// The build still exited 0 and deployed a site with no security headers, which is
// the worst possible outcome for a script whose only job is to write them.
// Line-scoped matching, plus the assertions below, make that unreachable.
const headerIndices = lines
  .map((line, i) => (/^\s*Content-Security-Policy:/.test(line) ? i : -1))
  .filter((i) => i !== -1);

if (headerIndices.length !== 1) {
  fail(`expected exactly one Content-Security-Policy header line, found ${headerIndices.length}`);
}

const headerLine = lines[headerIndices[0]];
const directiveCount = (headerLine.match(/connect-src[^;]*/g) ?? []).length;
if (directiveCount !== 1) {
  fail(`expected exactly one connect-src directive on the header line, found ${directiveCount}`);
}

lines[headerIndices[0]] = headerLine.replace(/connect-src[^;]*/, connectSrc);

// Drop comment lines from the deployed artifact. They exist for whoever edits the
// template, not for the CDN — and one of them quotes the historical wildcard
// verbatim, so leaving it in ships `https://*.onrender.com` inside out/_headers
// where it reads like a live directive to anyone grepping the build output.
// Whole-line comments only: a `#` inside a directive value is preserved.
const output = lines
  .filter((line) => !/^\s*#/.test(line))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trimStart();

fs.writeFileSync(outFile, output, "utf8");

// Post-conditions. Re-read what was actually written: a header file that silently
// loses its directives fails open, and nothing downstream would ever notice.
const written = fs.readFileSync(outFile, "utf8");
const writtenHeader = written.split("\n").find((l) => /^\s*Content-Security-Policy:/.test(l));
if (!writtenHeader) fail("wrote a _headers file with no Content-Security-Policy line");
for (const required of [
  "default-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  connectSrc,
]) {
  if (!writtenHeader.includes(required)) {
    fail(`written CSP is missing ${JSON.stringify(required)}`);
  }
}
// No wildcard may appear anywhere in the policy. The default contains none, and
// `configuredOrigin()` rejects a wildcard host, so this is a last line of defence
// against someone editing the template to add one back — which is precisely how
// `https://*.onrender.com` got there in the first place.
if (writtenHeader.includes("*")) {
  fail(`written CSP contains a wildcard: ${writtenHeader.trim()}`);
}
for (const directive of ["script-src", "style-src", "img-src", "font-src", "base-uri", "form-action"]) {
  if (!writtenHeader.includes(directive)) fail(`written CSP lost its ${directive} directive`);
}
// With comments stripped, nothing in the artifact may name a host that was not
// configured for this build. The configured origin is removed first: a maintainer
// whose own deployment lives on one of these domains must still be able to build.
const writtenSansConfigured = origin ? written.split(origin).join("") : written;
for (const host of ["onrender.com", "noveld.com.et", "leulzenebe.pro", "leul.et"]) {
  if (writtenSansConfigured.includes(host)) fail(`written _headers still names ${host}`);
}
if (!/^\s*Strict-Transport-Security:/m.test(written)) {
  fail("written _headers lost its Strict-Transport-Security header");
}

if (origin) {
  console.log(`[write-headers] CSP connect-src pinned to ${origin}`);
} else {
  console.warn(
    "[write-headers] NEXT_PUBLIC_API_URL is not set, so connect-src is 'self' only.\n" +
      "                 Cross-origin API calls will be blocked by the CSP. Rebuild with\n" +
      "                 NEXT_PUBLIC_API_URL=https://your-api.example.com — see web/.env.example.",
  );
}
