<?php
header("Content-Type: application/json");

// ── Always answer ────────────────────────────────────────────────────────────
// The API's per-attempt relay timeout is 12s, so this script must always respond
// well before that. Two failure modes used to produce a completely empty response:
//   * cURL can block indefinitely in DNS resolution, which CURLOPT_TIMEOUT does
//     not reliably bound on all PHP/libcurl builds.
//   * When the host kills the script at max_execution_time the fatal error is
//     suppressed, so nothing is written and the caller sees no response at all
//     instead of the intended 502.
// Every exit path therefore goes through respond(), and a shutdown handler emits
// a valid document naming the stalled stage if the script dies unexpectedly.
//
// An empty body is only a *worse* version of a late body, so the whole script is
// budgeted to finish inside RELAY_BUDGET_MS: 2s reachability pre-check + 8s fetch
// leaves ~2s for parse and extract inside the API's 12s. The previous build spent
// up to 14s in those first two stages and then ran DOMDocument::loadHTML plus 14
// XPath queries eagerly and unbounded, so a slow page pushed the response past the
// API's deadline and the caller saw no bytes at all — indistinguishable from a
// dead relay, which is the failure this budget exists to prevent.
//
// Bump when the response contract or timeout behaviour changes. The 401 path
// below is the cheapest place to read it, because it never touches the upstream
// provider — useful for confirming which build is actually deployed.
// Declared before the shutdown handler that reports it.
const RELAY_VERSION = '2026-09-27.bounded-extract';

// Wall-clock ceiling for the whole script, in ms, and the slice of it reserved for
// the DOM/XPath fallback. The fallback is the only stage that cannot be bounded by
// a socket option, so it is the one that gets skipped when the budget is spent.
const RELAY_BUDGET_MS = 11000;
const RELAY_DOM_RESERVE_MS = 2500;

// Hard cap on the provider page size. A receipt page is a few tens of KB; a
// megabyte is far past anything legitimate and is the input that makes loadHTML
// and the XPath fallback expensive. Enforced twice: CURLOPT_MAXFILESIZE covers
// the advertised Content-Length, and the explicit check after the fetch covers
// chunked responses, where the option cannot see a size at all.
const MAX_HTML_BYTES = 1048576;

$__stage = 'boot';
$__startedAt = microtime(true);
$__responded = false;

function respond(array $payload, int $status = 200): void {
    global $__responded;
    if ($__responded) { return; }
    $__responded = true;
    // Some shared hosts buffer output; without this a slow or interrupted
    // response can reach the caller as an empty body.
    while (ob_get_level() > 0) { @ob_end_flush(); }
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    @flush();
}

register_shutdown_function(function (): void {
    global $__responded, $__startedAt, $__stage;
    if ($__responded) { return; }
    $last = error_get_last();
    respond([
        "success" => false,
        "error" => "Relay script terminated before completing (stage: {$__stage}).",
        "relayVersion" => RELAY_VERSION,
        "details" => sprintf(
            'elapsedMs=%d stage=%s maxExecutionTime=%s memoryLimit=%s lastError=%s',
            round((microtime(true) - $__startedAt) * 1000),
            $__stage,
            (string) ini_get('max_execution_time'),
            (string) ini_get('memory_limit'),
            (string) ($last['message'] ?? 'none')
        ),
    ], 502);
});

// Proxy key resolution.
//
// The key lives in this file on purpose, with the environment variable only as
// a fallback. On shared hosting the PHP-FPM pool does not always share one
// environment, so `getenv()` returned empty on some workers: a valid key was
// intermittently rejected with 401 while other workers proceeded, which looks
// exactly like a flaky relay. A literal here is identical on every worker and
// every node, and it takes precedence so it cannot drift from the environment.
//
// ── EDIT THIS ONE VALUE ──────────────────────────────────────────────────────
$TELEBIRR_PROXY_KEY = 'PASTE_YOUR_KEY_HERE';
// ─────────────────────────────────────────────────────────────────────────────
// The sentinel below is intentionally a separate literal, not a reference to
// the line above, so replacing the key above cannot accidentally make the
// unconfigured-check below compare a value against itself.
if ($TELEBIRR_PROXY_KEY === 'PASTE_YOUR_KEY_HERE') {
    $__keyFromEnv = getenv('TELEBIRR_PROXY_KEY');
    if (is_string($__keyFromEnv) && $__keyFromEnv !== '') {
        $TELEBIRR_PROXY_KEY = $__keyFromEnv;
    }
}
if ($TELEBIRR_PROXY_KEY === 'PASTE_YOUR_KEY_HERE') {
    respond([
        "success" => false,
        "error" => "Relay is not configured: set the key in verify.php, or in the TELEBIRR_PROXY_KEY environment variable.",
        "relayVersion" => RELAY_VERSION
    ], 500);
    exit;
}

// Check for proxy key. Return a real HTTP status as well as the JSON error so a
// broken proxy is distinguishable from a valid-but-missing receipt.
if (!isset($_GET['key']) || !hash_equals($TELEBIRR_PROXY_KEY, (string) $_GET['key'])) {
    respond([
        "success" => false,
        "error" => "Unauthorized: Invalid or missing proxy key",
        "relayVersion" => RELAY_VERSION
    ], 401);
    exit;
}

$reference = trim((string) ($_GET['reference'] ?? ''));
if ($reference === '') {
    respond([
        "success" => false,
        "error" => "Missing reference parameter."
    ], 400);
    exit;
}

$url = "https://transactioninfo.ethiotelecom.et/receipt/" . urlencode($reference);

const UPSTREAM_HOST = 'transactioninfo.ethiotelecom.et';
const UPSTREAM_PORT = 443;
// Per-attempt fetch budget. Three of these plus the pre-check fit inside
// RELAY_BUDGET_MS with room to spare, which is what makes retrying safe: the
// handshake to this provider fails roughly half the time, so a single attempt is
// a coin flip rather than a plan.
const FETCH_ATTEMPT_TIMEOUT_MS = 2500;
const FETCH_MAX_ATTEMPTS = 3;
// Last known address, used when there is no cache file yet. It is a floor, not
// a pin: if a request to it fails, the address is re-resolved and the new one
// cached, so a provider IP change is picked up rather than locked out.
// gethostbyname() cannot be interrupted from PHP and on this host it has been
// observed blocking past 50s, which is the entire failure this script is fixing,
// so the common path must not depend on it at all.
const UPSTREAM_SEED_IP = '196.188.116.120';

/**
 * Resolve the provider once and remember the answer.
 *
 * Why this exists
 * ---------------
 * The relay host's resolver is unreliable for this provider. Two probe runs
 * produced opposite results for identical cURL options, and the failures were:
 *
 *     errno=28 "Resolving timed out after 4000 milliseconds"
 *     errno=28 "Operation timed out ... with 0 out of 0 bytes received"
 *
 * The second is not a dropped packet: the connection never opened, because the
 * name never resolved. That also explains why nothing downstream could bound
 * it. This host runs cURL 7.61.1, and CURLOPT_TIMEOUT does not reliably cover
 * name resolution on this build -- a request that set CURLOPT_TIMEOUT=6 ran for
 * 56 seconds. So the "0 out of 0 bytes" stalls cost the whole budget, the
 * response overran the API's deadline, and the API reported a bare timeout
 * against a relay that was perfectly reachable.
 *
 * Once an address is known it goes into CURLOPT_RESOLVE, which makes libcurl
 * skip the resolver entirely, and CURLOPT_TIMEOUT then actually bounds the
 * request. The address is re-resolved whenever the cached one stops working, so
 * a provider IP change is picked up rather than pinned.
 *
 * The cache is best-effort: if it is not writable the relay still works, it just
 * pays for a lookup on every request.
 */
function resolveUpstreamAddress($forceResolve = false): array {
    $cacheFile = __DIR__ . '/.telebirr-upstream-ip';

    // 1. A cached address from an earlier successful request.
    $cached = @file_get_contents($cacheFile);
    if (is_string($cached)) {
        $cached = trim($cached);
        // A plain IPv4 literal only. Anything else counts as no cache, so a
        // corrupted or hand-edited file cannot end up inside a cURL option.
        if (preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', $cached)) {
            return ['ip' => $cached, 'source' => 'cache'];
        }
    }

    // 2. The seed, so a cold install and the common path never call the resolver.
    if (!$forceResolve && UPSTREAM_SEED_IP !== '') {
        return ['ip' => UPSTREAM_SEED_IP, 'source' => 'seed'];
    }

    // 3. Last resort, and the one path that can still block for a long time.
    $startedAt = microtime(true);
    $ip = gethostbyname(UPSTREAM_HOST);
    $elapsedMs = round((microtime(true) - $startedAt) * 1000);

    // gethostbyname returns its input unchanged when it fails, so an address
    // that still looks like a hostname means nothing was found.
    if ($ip === UPSTREAM_HOST || !preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', (string) $ip)) {
        return ['ip' => null, 'source' => 'unresolved', 'elapsedMs' => $elapsedMs];
    }

    rememberUpstreamAddress($ip);

    return ['ip' => $ip, 'source' => 'resolved', 'elapsedMs' => $elapsedMs];
}

function rememberUpstreamAddress($ip): void {
    // Last writer wins. This is a single-address cache, not shared state needing
    // locking, and a concurrent write of the same value is harmless.
    @file_put_contents(__DIR__ . '/.telebirr-upstream-ip', $ip, LOCK_EX);
}

function forgetUpstreamAddress(): void {
    @unlink(__DIR__ . '/.telebirr-upstream-ip');
}

/**
 * Measure TCP reachability without touching TLS.
 *
 * Deliberately plain TCP: fsockopen('ssl://...') does not send SNI, and many
 * hosts reject or mishandle a SNI-less handshake, so a TLS probe here reports a
 * false "unreachable" for a server that cURL reaches fine. errno=0 with an empty
 * message after a few seconds is that signature.
 *
 * Also advisory only. A failure is recorded as a diagnostic and cURL is still
 * attempted, because cURL's own error is more trustworthy than this probe.
 *
 * Given a resolved address, connects to the literal. fsockopen resolves the name
 * itself, so passing the host here would reintroduce exactly the hang this
 * script exists to avoid.
 */
function measureUpstreamReachability(string $host, int $port, int $timeoutSeconds, $ip = null) {
    $errno = 0;
    $errstr = '';
    $target = ($ip !== null && $ip !== '') ? $ip : $host;
    $startedAt = microtime(true);
    $socket = @fsockopen("tcp://{$target}:{$port}", $timeoutSeconds, $errno, $errstr, STREAM_CLIENT_CONNECT);
    $elapsedMs = round((microtime(true) - $startedAt) * 1000);
    if ($socket === false) {
        return [
            'ok' => false,
            'elapsedMs' => $elapsedMs,
            'error' => "tcp connect to {$target}:{$port} failed after {$elapsedMs}ms (errno={$errno} {$errstr})"
        ];
    }
    fclose($socket);
    return ['ok' => true, 'elapsedMs' => $elapsedMs, 'error' => ''];
}

/**
 * One cURL attempt against the provider.
 *
 * @return array{ok:bool, body:string, errno:int, error:string, ms:int, fromCache:bool}
 */
function attemptFetch($url, $ip, $timeoutMs) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    // Below the per-attempt timeout so a blackholed route is reported as a
    // connect failure rather than consuming the whole attempt.
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 2);
    curl_setopt($ch, CURLOPT_TIMEOUT, (int) ceil($timeoutMs / 1000));
    // Abort a connection that stalls mid-body instead of burning the full
    // timeout waiting for more data that never arrives.
    curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 512);
    curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, 2);
    // Bound the response body as well as its rate. LOW_SPEED_* only caps a stall,
    // not size, and an oversized page is what makes the extract stage run long.
    curl_setopt($ch, CURLOPT_MAXFILESIZE, MAX_HTML_BYTES);
    curl_setopt($ch, CURLOPT_ENCODING, '');
    curl_setopt($ch, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language: am-ET,am;q=0.9,en-US;q=0.8,en;q=0.7"
    ]);

    // ── TLS pinning ───────────────────────────────────────────────────────────
    // transactioninfo.ethiotelecom.et is TLS 1.2 only. This one is deterministic
    // and worth keeping: a probe on the relay host got
    //   errno=35 "tlsv1 alert protocol version"
    // for a TLS 1.3 ClientHello, in 16ms, every time. Pinning 1.2 avoids paying
    // a rejected handshake before every real request.
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    // Not needed on this host, which runs OpenSSL 1.1.1k where level 1 is already
    // the default. Kept so a host that later gains OpenSSL 3.x, where the default
    // is stricter, does not start rejecting this provider's older chain.
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=1');
    // Never disabled. See the probe: disabling verification does not make this
    // provider reachable, so it would buy nothing and cost the guarantee.
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

    // Hand libcurl the address so it never calls the resolver, which on this host
    // can block far past CURLOPT_TIMEOUT.
    if ($ip !== null && $ip !== '') {
        curl_setopt($ch, CURLOPT_RESOLVE, [UPSTREAM_HOST . ':' . UPSTREAM_PORT . ':' . $ip]);
    }

    $startedAt = microtime(true);
    $body = curl_exec($ch);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $ms = round((microtime(true) - $startedAt) * 1000);
    curl_close($ch);

    return [
        'ok' => $errno === 0,
        'body' => is_string($body) ? $body : '',
        'errno' => $errno,
        'error' => $error,
        'ms' => $ms,
        'fromCache' => $ip !== null && $ip !== '',
    ];
}

function fetchReceipt($url) {
    global $__stage;

    $__stage = 'dns-resolve';
    $resolution = resolveUpstreamAddress();
    $ip = $resolution['ip'];

    $__stage = 'dns-precheck';
    $precheck = measureUpstreamReachability(UPSTREAM_HOST, UPSTREAM_PORT, 2, $ip);

    $__stage = 'provider-fetch';
    $attempts = [];
    $body = '';
    $lastErrno = 0;
    $lastError = '';
    $retried = false;

    for ($i = 1; $i <= FETCH_MAX_ATTEMPTS; $i++) {
        $attempt = attemptFetch($url, $ip, FETCH_ATTEMPT_TIMEOUT_MS);
        $attempts[] = sprintf('#%d %dms errno=%d', $i, $attempt['ms'], $attempt['errno']);

        if ($attempt['ok']) {
            $body = $attempt['body'];
            $lastErrno = $attempt['errno'];
            $lastError = $attempt['error'];
            break;
        }

        $lastErrno = $attempt['errno'];
        $lastError = $attempt['error'];

        // A failed attempt against a pinned address means the address may be
        // stale, and a stale seed would otherwise fail forever. So re-resolve
        // once and cache the result, which is what makes this self-healing if
        // the provider ever changes address.
        //
        // Trade-off, stated plainly: gethostbyname() is the unbounded call this
        // design exists to keep off the request path, so this branch can be slow.
        // It is only reached when the address is genuinely wrong, which is rare,
        // and a slow request still answers via the shutdown handler. Refusing to
        // re-resolve would trade a rare slow response for a permanent outage the
        // first time the provider moves.
        if ($attempt['fromCache'] && !$retried) {
            $retried = true;
            forgetUpstreamAddress();
            $fresh = resolveUpstreamAddress(true);
            if ($fresh['ip'] !== null && $fresh['ip'] !== $ip) {
                $ip = $fresh['ip'];
            }
        }
    }

    $probe = sprintf(
        'ipSource=%s tcpProbe=%s tcpProbeMs=%d attempts=%d [%s] curlErrno=%d',
        $resolution['source'],
        $precheck['ok'] ? 'ok' : 'failed',
        $precheck['elapsedMs'],
        count($attempts),
        implode(' ', $attempts),
        $lastErrno
    );

    $error_no = $lastErrno;
    $error_msg = $lastError;
    $response = $body;
    $curlMs = 0;
    foreach ($attempts as $entry) {
        if (preg_match('/^#\d+ (\d+)ms/', $entry, $m)) {
            $curlMs += (int) $m[1];
        }
    }

    if ($error_no === 0) {
        $htmlBytes = is_string($response) ? strlen($response) : 0;
        if ($htmlBytes > MAX_HTML_BYTES) {
            // Do not truncate: a cut-off page parses into plausible-looking but
            // wrong field values, which is worse than an explicit failure.
            return [
                'success' => false,
                'error' => "Provider page is too large to parse ({$htmlBytes} bytes, limit " . MAX_HTML_BYTES . ").",
                'details' => "{$probe} | the receipt page exceeded the parse budget; do not truncate it, because a partial page yields wrong field values"
            ];
        }
        return ['success' => true, 'html' => $response];
    }

    // Group specific cURL errors
    $is_ssl_error = in_array($error_no, [35, 51, 58, 59, 60, 64, 66, 77, 82, 83]); // SSL related errors
    $is_connection_error = in_array($error_no, [6, 7, 28]); // 6: COULDNT_RESOLVE_HOST, 7: COULDNT_CONNECT, 28: OPERATION_TIMEDOUT

    if ($is_ssl_error) {
        // errno 60 is this host's certificate store, not the provider's
        // certificate. The provider presents a GlobalSign RSA OV SSL CA 2018
        // chain; a Plesk box without that root in its CA bundle fails here and
        // the fix is on the host, so do not send the operator chasing Ethio
        // Telecom for it.
        if ($error_no === 60) {
            return [
                'success' => false,
                'error' => "This relay host does not trust Ethiotelecom's certificate chain (curl errno 60).",
                'details' => "{$error_msg} | {$probe} | the relay host is missing the GlobalSign RSA OV SSL CA 2018 root in its CA bundle; install it on the host rather than disabling verification"
            ];
        }
        return [
            'success' => false,
            'error' => "SSL handshake with Ethiotelecom failed (curl errno {$error_no}).",
            'details' => "{$error_msg} | {$probe}"
        ];
    }

    if ($is_connection_error) {
        return [
            'success' => false,
            'error' => "Ethiotelecom is unreachable. The proxy might be blocked or Ethiotelecom is experiencing hosting issues.",
            'details' => "{$error_msg} | {$probe}"
        ];
    }

    // Any other cURL errors
    return [
        'success' => false,
        'error' => "Failed to fetch receipt from Ethiotelecom.",
        'details' => "{$error_msg} | {$probe}"
    ];
}

$fetchResult = fetchReceipt($url);

if (!$fetchResult['success']) {
    respond([
        "success" => false,
        "error" => $fetchResult['error'],
        "details" => $fetchResult['details']
    ], 502);
    exit;
}

$__stage = 'parse';
$html = $fetchResult['html'];
if (empty($html) || strlen($html) < 100) {
    respond([
        "success" => false,
        "error" => "Failed to fetch receipt or empty response."
    ]);
    exit;
}

// Regex patterns for extracting specific values
function extractSettledAmount($html) {
    $pattern1 = '/የተከፈለው\s+መጠን\/Settled\s+Amount.*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern1, $html, $matches)) return trim($matches[1]);

    $pattern2 = '/<tr[^>]*>.*?የተከፈለው\s+መጠን\/Settled\s+Amount.*?<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern2, $html, $matches)) return trim($matches[1]);

    $pattern3 = '/Settled\s+Amount.*?([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern3, $html, $matches)) return trim($matches[1]);

    $pattern4 = '/የክፍያ\s+ዝርዝር\/Transaction\s+details.*?<tr[^>]*>.*?<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is';
    if (preg_match($pattern4, $html, $matches)) return trim($matches[1]);

    return "";
}

function extractServiceFee($html) {
    $patterns = [
        '/የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is',
        '/<tr[^>]*>.*?የአገልግሎት\s+ክፍያ\/Service\s+fee(?!\s+ተ\.እ\.ታ).*?<td[^>]*>\s*([\d,]+(?:\.\d+)?\s+Birr)/is',
        '/Service\s+fee(?!\s+VAT).*?([\d,]+(?:\.\d+)?\s+Birr)/is'
    ];

    foreach ($patterns as $pattern) {
        if (preg_match($pattern, $html, $matches)) {
            return trim($matches[1]);
        }
    }

    return "";
}

// Enhanced regex extraction functions
function extractWithRegex($html, $labelPatterns, $valuePattern = null) {
    if (!is_array($labelPatterns)) {
        $labelPatterns = [$labelPatterns];
    }
    if ($valuePattern === null) {
        $valuePattern = '([^<]+)';
    }

    foreach ($labelPatterns as $labelPattern) {
        $pattern = '/<td[^>]*>\s*' . preg_quote($labelPattern, '/') . '\s*<\/td>\s*<td[^>]*>\s*' . $valuePattern . '/is';
        if (preg_match($pattern, $html, $matches)) {
            return preg_replace('/\s+/u', ' ', trim(strip_tags($matches[1])));
        }
    }

    return "";
}

function extractReceiptNoRegex($html) {
    // Extract receipt number from the transaction details table
    $pattern = '/<td[^>]*class="[^"]*receipttableTd[^"]*receipttableTd2[^"]*"[^>]*>\s*([A-Z0-9]+)\s*<\/td>/i';
    if (preg_match($pattern, $html, $matches)) {
        return trim($matches[1]);
    }
    return "";
}

function extractDateRegex($html) {
    // Extract date in format DD-MM-YYYY HH:MM:SS
    $pattern = '/(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}:\d{2})/';
    if (preg_match($pattern, $html, $matches)) {
        return trim($matches[1]);
    }
    return "";
}

/**
 * Lazily-built DOM/XPath over the provider page.
 *
 * The previous build called DOMDocument::loadHTML() and constructed a DOMXPath
 * eagerly, immediately after the fetch, and then ran up to 14 XPath queries as
 * the fallback for every field. That made the parse and extract stages cost the
 * same whether or not any field actually needed the DOM, and neither stage had
 * any bound at all — so a large or slow page pushed the response past the API's
 * deadline and the caller saw an empty body instead of a diagnosis.
 *
 * This defers the whole DOM cost until a fallback is genuinely used, and skips it
 * outright when the remaining budget cannot cover it. Built for PHP 7.1+ so it runs
 * on the older interpreters shared hosts still ship. Implements the same query()
 * surface the call sites already use, so none of them had to change.
 */
class LazyXPath
{
    /** @var DOMXPath|null */
    private $xpath = null;

    /** @var bool */
    private $skipped = false;

    /** @var int */
    private $builtMs = 0;

    /** @var string */
    private $skipReason = '';

    /** @var string */
    private $html;

    public function __construct($html)
    {
        $this->html = $html;
    }

    /**
     * @return DOMNodeList|false
     */
    public function query($expression)
    {
        if ($this->xpath === null) {
            if (!$this->build()) {
                return false;
            }
        }

        return $this->xpath->query($expression);
    }

    public function wasSkipped()
    {
        return $this->skipped;
    }

    public function skipReason()
    {
        return $this->skipReason;
    }

    public function builtMs()
    {
        return $this->builtMs;
    }

    private function build()
    {
        global $__startedAt;

        $elapsedMs = (microtime(true) - $__startedAt) * 1000;
        if ($elapsedMs > RELAY_BUDGET_MS - RELAY_DOM_RESERVE_MS) {
            $this->skipped = true;
            $this->skipReason = sprintf(
                'skipped: %dms of the %dms budget already spent',
                (int) $elapsedMs,
                RELAY_BUDGET_MS
            );
            return false;
        }

        $startedAt = microtime(true);
        // The encoding hint is load-bearing, not decoration: without it libxml can
        // misdetect the page and mangle the Amharic labels, and every XPath query
        // below matches on those labels.
        libxml_use_internal_errors(true);
        $dom = new DOMDocument();
        $dom->loadHTML('<?xml encoding="utf-8" ?>' . $this->html);
        $this->xpath = new DOMXPath($dom);
        libxml_clear_errors();
        $this->builtMs = round((microtime(true) - $startedAt) * 1000);

        return true;
    }
}

// Populated by getNextCellText() below, which stays a free function so the
// existing call sites keep their signature. Nothing here builds the DOM.
$xpath = new LazyXPath($html);

function xpathLiteral($value) {
    if (strpos($value, "'") === false) {
        return "'" . $value . "'";
    }

    if (strpos($value, '"') === false) {
        return '"' . $value . '"';
    }

    $parts = explode("'", $value);
    $segments = [];
    $lastIndex = count($parts) - 1;

    foreach ($parts as $index => $part) {
        if ($part !== '') {
            $segments[] = "'" . $part . "'";
        }

        if ($index < $lastIndex) {
            $segments[] = '"\'"';
        }
    }

    return 'concat(' . implode(', ', $segments) . ')';
}

function getNextCellText($xpath, $labels) {
    if (!is_array($labels)) {
        $labels = [$labels];
    }

    foreach ($labels as $label) {
        $query = "//td[contains(normalize-space(.), " . xpathLiteral($label) . ")]/following-sibling::td[1]";
        $nodeList = $xpath->query($query);
        if ($nodeList && $nodeList->length > 0) {
            foreach ($nodeList as $node) {
                $value = trim($node->textContent ?? '');
                if ($value !== '') {
                    return preg_replace('/\s+/u', ' ', $value);
                }
            }
        }
    }

    return "";
}

// Extract values using regex first, fallback to DOM parsing
$settledAmount = extractSettledAmount($html) ?: getNextCellText($xpath, ["የተከፈለው መጠን/Settled Amount", "Settled Amount"]);
$serviceFee = extractServiceFee($html) ?: getNextCellText($xpath, ["የአገልግሎት ክፍያ/Service fee", "Service fee"]);

// --- Bank name extraction logic ---
$creditedPartyName = extractWithRegex($html, "የገንዘብ ተቀባይ ስም/Credited Party name") ?: getNextCellText($xpath, "የገንዘብ ተቀባይ ስም/Credited Party name");
$creditedPartyAccountNo = extractWithRegex($html, "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no") ?: getNextCellText($xpath, "የገንዘብ ተቀባይ ቴሌብር ቁ./Credited party account no");
$bankName = "";

$bankAccountNumberRaw = extractWithRegex($html, "የባንክ አካውንት ቁጥር/Bank account number") ?: getNextCellText($xpath, "የባንክ አካውንት ቁጥር/Bank account number");

if ($bankAccountNumberRaw) {
    $bankName = $creditedPartyName; // The original credited party name is the bank
    if (preg_match('/(\d+)\s+(.*)/', $bankAccountNumberRaw, $m)) {
        $creditedPartyAccountNo = trim($m[1]);
        $creditedPartyName = trim($m[2]);
    }
}


// Extraction can be the slow stage on a large page; name it so a stall is
// attributable rather than looking like a network problem. The DOM is built on
// demand by LazyXPath, so a page where every regex matched never pays for it.
$__stage = 'extract';

$response = [
    "success" => true,
    "data" => [
        "payerName" => extractWithRegex($html, ["የከፋይ ስም/Payer Name", "Payer Name"]) ?: getNextCellText($xpath, ["የከፋይ ስም/Payer Name", "Payer Name"]),
        "payerTelebirrNo" => extractWithRegex($html, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]) ?: getNextCellText($xpath, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]),
        "creditedPartyName" => $creditedPartyName,
        "creditedPartyAccountNo" => $creditedPartyAccountNo,
        "bankName" => $bankName,
        "customerNote" => extractWithRegex($html, ["የደንበኛ መልዕክት/Customer Note", "Customer Note"]) ?: getNextCellText($xpath, ["የደንበኛ መልዕክት/Customer Note"]),
        "transactionStatus" => extractWithRegex($html, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]) ?: getNextCellText($xpath, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]),
        "receiptNo" => extractReceiptNoRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቁጥር/Receipt No.", "Receipt No."]),
        "paymentDate" => extractDateRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቀን/Payment date", "Payment date"]),
        "settledAmount" => $settledAmount,
        "serviceFee" => $serviceFee,
        "serviceFeeVAT" => extractWithRegex($html, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]) ?: getNextCellText($xpath, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]),
        "totalPaidAmount" => extractWithRegex($html, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"]) ?: getNextCellText($xpath, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"])
    ]
];

// Report how the extraction went, so a slow or degraded run is visible in the
// API's logs instead of being indistinguishable from a healthy one. The API
// ignores unknown fields, so this is additive.
$response['relayTiming'] = [
    'version' => RELAY_VERSION,
    'totalMs' => round((microtime(true) - $__startedAt) * 1000),
    'htmlBytes' => strlen($html),
    // null means the DOM was never needed, which is the healthy common case.
    'domMs' => $xpath->wasSkipped() ? null : $xpath->builtMs(),
    'domNote' => $xpath->wasSkipped() ? $xpath->skipReason() : ($xpath->builtMs() > 0 ? 'fallback used' : 'not needed'),
];

$__stage = 'respond';
respond($response, 200);
?>
