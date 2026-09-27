<?php
/**
 * mpesa.php — M-Pesa receipt relay for Plesk/shared hosting in Ethiopia.
 *
 * The Veritas API calls this from a datacentre whose IP Safaricom's receipt
 * endpoint will not answer. It exists to be a thin, single-purpose relay: take a
 * transaction reference, ask Safaricom for it, hand the body back unchanged.
 *
 * It was written to `verify.php`'s original standard and never updated when that
 * script was hardened, so it shipped with a committed placeholder key
 * ('YOUR_SECRET_PROXY_KEY_HERE') that made it an open relay to a payment API for
 * anyone who read this repository, certificate verification switched off,
 * redirects followed to any host, and a `?debug=true` flag that dumped the full
 * cURL trace to whoever asked. All four are fixed below; the key handling now
 * mirrors verify.php exactly, including the fail-closed behaviour.
 *
 * Deployment: put this file outside any directory that serves user content, set
 * MPESA_PROXY_KEY in the host's environment (or edit the one marked literal
 * below), and point the API's MPESA_FALLBACK_URL at it.
 */

header('Content-Type: application/json; charset=utf-8');
// Deliberately no Access-Control-Allow-Origin. This is a server-to-server relay
// authenticated by a shared secret; advertising it to every browser origin only
// invites someone to call a payment API through a visitor's session.
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');

const RELAY_VERSION = '2.0.0';
const UPSTREAM = 'https://m-pesabusiness.safaricom.et/api/receipt/getReceipt';

/** Uniform JSON + HTTP status. A real status code matters: the API distinguishes
 *  "relay is broken" from "receipt does not exist" by it. */
function respond(array $body, int $status): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

// ── Shared secret ────────────────────────────────────────────────────────────
// A literal takes precedence over the environment for the same reason it does in
// verify.php: `getenv()` behaves differently across PHP-FPM workers depending on
// `clear_env`/`env[...]` in the pool config, so an env-only key is intermittently
// empty and a valid request gets a 401 from some workers and 200 from others.
//
// ── EDIT THIS ONE VALUE, or set MPESA_PROXY_KEY in the environment ────────────
$MPESA_PROXY_KEY = 'PASTE_YOUR_KEY_HERE';
// ─────────────────────────────────────────────────────────────────────────────
// Separate literal on purpose, not a reference to the line above: replacing the
// key must not be able to turn the unconfigured check into a value compared with
// itself.
if ($MPESA_PROXY_KEY === 'PASTE_YOUR_KEY_HERE') {
    $__fromEnv = getenv('MPESA_PROXY_KEY');
    if (is_string($__fromEnv) && $__fromEnv !== '') {
        $MPESA_PROXY_KEY = $__fromEnv;
    }
}
if ($MPESA_PROXY_KEY === 'PASTE_YOUR_KEY_HERE' || strlen($MPESA_PROXY_KEY) < 16) {
    // Fail closed. Shipping the placeholder meant anyone who had read this file
    // could use the relay; refusing to start is the only safe default.
    respond([
        'success' => false,
        'responseCode' => '500',
        'responseDescription' => 'Relay is not configured: set MPESA_PROXY_KEY (at least 16 characters) in the environment or edit the marked literal in mpesa.php.',
        'relayVersion' => RELAY_VERSION,
    ], 500);
    exit;
}

/**
 * The key is read from a header first. A secret in a query string is copied into
 * the host's access log, any reverse proxy's log, and the Referer of anything the
 * response links to — it stops being a secret the first time it is written down.
 * The `key` query parameter is still accepted so the API can be deployed in
 * either order; it logs a warning and should be removed once every caller sends
 * the header.
 */
$__keyFromHeader = isset($_SERVER['HTTP_X_PROXY_KEY']) ? (string) $_SERVER['HTTP_X_PROXY_KEY'] : '';
$__keyFromQuery  = isset($_GET['key']) ? (string) $_GET['key'] : '';
$__presented     = $__keyFromHeader !== '' ? $__keyFromHeader : $__keyFromQuery;

// hash_equals, not !==: a byte-at-a-time comparison leaks the key's length and
// prefix through response timing.
if ($__presented === '' || !hash_equals($MPESA_PROXY_KEY, $__presented)) {
    respond([
        'success' => false,
        'responseCode' => '401',
        'responseDescription' => 'Unauthorized: invalid or missing proxy key',
        'relayVersion' => RELAY_VERSION,
    ], 401);
    exit;
}
if ($__keyFromHeader === '' && $__keyFromQuery !== '') {
    error_log('[mpesa-relay] proxy key was sent as a query parameter; send X-Proxy-Key instead so it stays out of access logs.');
}

// ── Input ────────────────────────────────────────────────────────────────────
$reference = trim((string) ($_GET['reference'] ?? ''));
if ($reference === '' || strlen($reference) > 64 || !preg_match('/^[A-Za-z0-9_-]+$/', $reference)) {
    // Charset-checked before it reaches a URL, and bounded: an unbounded value
    // would be urlencoded into a request line of arbitrary length.
    respond([
        'success' => false,
        'responseCode' => '400',
        'responseDescription' => 'Missing or malformed reference parameter (expected up to 64 characters of A-Z a-z 0-9 _ -).',
        'relayVersion' => RELAY_VERSION,
    ], 400);
    exit;
}

$url = UPSTREAM . '?trxNo=' . rawurlencode($reference);

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Gated on a server-side flag, not on `?debug=true`. A public debug switch on an
// authenticated relay hands out the verbose cURL trace — request headers, the
// resolved IP, TLS details — to anyone holding the key, and it did so before the
// response body was ever validated.
$debug = getenv('MPESA_PROXY_DEBUG') === 'true';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
// No redirect following. The destination is a single fixed HTTPS URL; a redirect
// from it is either a misconfiguration or a compromise, and following one would
// turn this relay into a way of reaching whatever host the redirect names.
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
curl_setopt($ch, CURLOPT_MAXREDIRS, 0);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
// Abort a connection that stalls mid-body rather than burning the whole timeout.
curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 512);
curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, 8);
curl_setopt($ch, CURLOPT_ENCODING, '');
// Bound the body: a receipt is a few KB, and an unbounded read is a memory lever.
curl_setopt($ch, CURLOPT_MAXFILESIZE, 2 * 1024 * 1024);

// ── TLS ──────────────────────────────────────────────────────────────────────
// Verification was switched off (`CURLOPT_SSL_VERIFYPEER, false`). For a relay
// whose entire purpose is to fetch proof that a payment happened, that means
// anyone on the network path between this host and Safaricom can return a receipt
// they wrote and the API will report the payment as genuine. Both checks are on;
// if the shared host's CA bundle is too old, point CURLOPT_CAINFO at a current
// bundle rather than disabling verification.
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
$__caBundle = getenv('MPESA_PROXY_CAINFO');
if (is_string($__caBundle) && $__caBundle !== '' && is_readable($__caBundle)) {
    curl_setopt($ch, CURLOPT_CAINFO, $__caBundle);
}
curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);

curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Accept: application/json, text/plain, */*',
    'Referer: https://m-pesabusiness.safaricom.et/',
]);

if ($debug) {
    curl_setopt($ch, CURLOPT_VERBOSE, true);
    $verbose = fopen('php://temp', 'w+');
    curl_setopt($ch, CURLOPT_STDERR, $verbose);
}

$startedAt = microtime(true);
$response = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$errorNo  = curl_errno($ch);
$errorMsg = curl_error($ch);
$elapsedMs = (int) round((microtime(true) - $startedAt) * 1000);
curl_close($ch);

if ($debug) {
    rewind($verbose);
    $trace = (string) stream_get_contents($verbose);
    fclose($verbose);
    respond([
        'success' => false,
        'debug' => true,
        'url' => $url,
        'httpCode' => $httpCode,
        'curlErrno' => $errorNo,
        'curlError' => $errorMsg,
        'elapsedMs' => $elapsedMs,
        'responseBytes' => is_string($response) ? strlen($response) : 0,
        // Headers only — never the upstream body, which is a customer receipt.
        'trace' => $trace,
        'relayVersion' => RELAY_VERSION,
    ], 200);
    exit;
}

if ($response === false || $response === null) {
    // curl_errno is reported, curl_error is not: the message can carry the
    // resolved upstream address and the TLS detail, which belongs in the host's
    // error log, not in a response body forwarded to a third party.
    error_log(sprintf('[mpesa-relay] upstream fetch failed errno=%d msg=%s ref=%s', $errorNo, $errorMsg, $reference));
    respond([
        'success' => false,
        'responseCode' => '502',
        'responseDescription' => 'Upstream receipt endpoint unreachable.',
        'curlErrno' => $errorNo,
        'elapsedMs' => $elapsedMs,
        'relayVersion' => RELAY_VERSION,
    ], 502);
    exit;
}

// Pass Safaricom's body through untouched: the API's parser expects exactly what
// the provider returns. The content type is asserted rather than trusted, so an
// HTML error page is not forwarded as if it were JSON.
$looksLikeHtml = preg_match('/^\s*(<|\xEF\xBB\xBF<)/', (string) $response) === 1;
if ($looksLikeHtml) {
    error_log(sprintf('[mpesa-relay] upstream returned HTML for ref=%s (http %d)', $reference, $httpCode));
    respond([
        'success' => false,
        'responseCode' => (string) ($httpCode ?: 502),
        'responseDescription' => 'Upstream returned an HTML page instead of a receipt.',
        'elapsedMs' => $elapsedMs,
        'relayVersion' => RELAY_VERSION,
    ], 502);
    exit;
}

http_response_code($httpCode >= 200 && $httpCode < 600 ? $httpCode : 200);
echo $response;
