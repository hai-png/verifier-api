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
// Budget arithmetic for this build (see the fetch section for why it is shaped
// this way): up to 4 rounds of hedged connections, each round abandoned after a
// 900ms handshake deadline, the winning flow allowed 3s in total. Worst case
// 3 x 0.9s + 3s = 5.7s, leaving the rest of RELAY_BUDGET_MS for parse/extract,
// and the whole thing inside the API's 12s per-attempt timeout with room for the
// relay's own diagnosis to arrive instead of a bare timeout.
//
// Bump when the response contract or timeout behaviour changes. The 401 path
// below is the cheapest place to read it, because it never touches the upstream
// provider — useful for confirming which build is actually deployed.
// Declared before the shutdown handler that reports it.
const RELAY_VERSION = '2026-09-28.hedged-flows';

// Wall-clock ceiling for the whole script, in ms, and the slice of it reserved for
// the DOM/XPath fallback. The fallback is the only stage that cannot be bounded by
// a socket option, so it is the one that gets skipped when the budget is spent.
// Mirrored as RELAY_BUDGET_MS in src/services/verifyTelebirr.ts; keep in step.
const RELAY_BUDGET_MS = 9000;
const RELAY_DOM_RESERVE_MS = 2000;

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

// ── How the provider fails from this host, and what that dictates ───────────
//
// Measured on this host (213.55.96.150, Ethio Telecom AS24757, same network as
// the provider at 196.188.116.120), every connection to the provider is one of:
//
//   * good: TCP connects in <1ms and the TLS handshake completes in ~30ms;
//   * dead: TCP connects in <1ms, the ClientHello goes out, and nothing ever
//     comes back — not an alert, not a RST, nothing;
//   * recovered: as dead, then it suddenly completes at ~1.0s or ~3.0-3.3s.
//
// The recovered timings are TCP retransmission backoff (200ms, +400, +800,
// +1600 => 0.2, 0.6, 1.4, 3.0s), which means the outcome is decided per
// connection: whichever path or backend a flow lands on either works or drops
// its handshake packets, and waiting on a dead flow only buys the occasional
// retransmit rescue three seconds later. Roughly half of flows are dead.
//
// That makes the previous strategy — one connection at a time, 4s each, three
// in a row — the worst possible shape: it spent up to 12s waiting on flows that
// were dead after the first 100ms, and with p(dead)=0.5 it still failed 12.5%
// of requests outright. Every earlier attempt at this fault (page size, TLS
// version, security level, DNS, connect-timeout width) tuned how long to wait
// on that single flow. None of them changed how many flows were tried.
//
// This build does the opposite: open a few connections at once, take the first
// whose handshake completes, and give a flow only HANDSHAKE_DEADLINE_MS to prove
// it is alive before abandoning it for a fresh one. A fresh connection means a
// fresh source port, which means a fresh path/backend selection — that is the
// property being exploited. With p(dead)=0.5, HEDGE_WIDTH=2 and MAX_ROUNDS=4,
// the chance every flow is dead is 0.5^8 = 0.4%, and the common case costs one
// handshake (~30ms) instead of a coin flip on a 4s timer.
//
// This is a mitigation, not the fix. The fix is either on the provider's side
// (a bad backend behind its load balancer, or its edge throttling this shared
// address) or on the path between the two, and tools/telebirr-tls-probe.php is
// written to tell those apart. Until that is settled, this is what the relay
// can do about it, and it is a lot.

// A good handshake completes in ~30ms on this host. Anything still handshaking
// at this deadline is almost certainly a dead flow, and a fresh connection has a
// better expected time than waiting for the 3s retransmit rescue. libcurl's
// connect timeout covers TCP connect *and* the TLS handshake, which is exactly
// the phase that fails, so this is the option that implements the deadline.
const HANDSHAKE_DEADLINE_MS = 900;
// Once the handshake is done the page (26KB, same network) arrives in tens of
// milliseconds; this is a generous ceiling for a live flow, not a wait budget.
const FLOW_TOTAL_MS = 3000;
// Connections opened simultaneously per round. Two is the sweet spot: it takes
// a round from 50% to 75% success at the cost of one extra handshake, and it
// keeps the load on the provider modest in case its edge *is* throttling this
// address (the probe will say). Raise to 3 only if the probe rules that out.
const HEDGE_WIDTH = 2;
// Rounds of fresh connections before giving up. Worst case is
// (MAX_ROUNDS - 1) * HANDSHAKE_DEADLINE_MS + FLOW_TOTAL_MS = 5.7s.
const MAX_ROUNDS = 4;

// Last known address, used when there is no cache file yet. gethostbyname()
// cannot be interrupted from PHP and on this host it has been measured blocking
// past 50s (the resolver is a second, unrelated fault on this host), so no
// request path may ever put a hostname in a socket URL. The address comes from
// the cache file or this constant, and nothing else. To move to a new address,
// update this and delete .telebirr-upstream-ip.
const UPSTREAM_SEED_IP = '196.188.116.120';

/**
 * The provider address, without ever calling the system resolver.
 */
function resolveUpstreamAddress(): array {
    $cached = @file_get_contents(__DIR__ . '/.telebirr-upstream-ip');
    if (is_string($cached)) {
        $cached = trim($cached);
        // A plain IPv4 literal only. Anything else counts as no cache, so a
        // corrupted or hand-edited file cannot end up inside a cURL option.
        if (preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', $cached)) {
            return ['ip' => $cached, 'source' => 'cache'];
        }
    }

    if (UPSTREAM_SEED_IP !== '') {
        return ['ip' => UPSTREAM_SEED_IP, 'source' => 'seed'];
    }

    return ['ip' => null, 'source' => 'unset'];
}

function rememberUpstreamAddress($ip): void {
    // Last writer wins. This is a single-address cache, not shared state needing
    // locking, and a concurrent write of the same value is harmless.
    @file_put_contents(__DIR__ . '/.telebirr-upstream-ip', $ip, LOCK_EX);
}

/**
 * One cURL handle configured for a single fresh flow to the provider.
 */
function makeFlowHandle($url, $ip) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    // The deadline that matters. Covers TCP connect plus the TLS handshake.
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, HANDSHAKE_DEADLINE_MS);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, FLOW_TOTAL_MS);
    // Every handle must be its own TCP connection with its own source port.
    // Reusing a connection would defeat the point of the retry.
    curl_setopt($ch, CURLOPT_FRESH_CONNECT, true);
    curl_setopt($ch, CURLOPT_FORBID_REUSE, true);
    curl_setopt($ch, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
    // Bound the response body. An oversized page is what makes the extract
    // stage run long, and CURLOPT_MAXFILESIZE only sees Content-Length, so the
    // explicit check after the fetch covers chunked responses.
    curl_setopt($ch, CURLOPT_MAXFILESIZE, MAX_HTML_BYTES);
    curl_setopt($ch, CURLOPT_ENCODING, '');
    curl_setopt($ch, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language: am-ET,am;q=0.9,en-US;q=0.8,en;q=0.7"
    ]);

    // The provider is TLS 1.2 only; a TLS 1.3 ClientHello gets a protocol-version
    // alert in 16ms, deterministically. Pinning avoids paying that before every
    // real handshake. SECLEVEL=1 is already the default on this host's OpenSSL
    // 1.1.1k and is kept for a future OpenSSL 3.x host. Verification is never
    // disabled: the probe showed it buys nothing against this fault.
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=1');
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

    // Hand libcurl the address so it never calls the resolver.
    if ($ip !== null && $ip !== '') {
        curl_setopt($ch, CURLOPT_RESOLVE, [UPSTREAM_HOST . ':' . UPSTREAM_PORT . ':' . $ip]);
    }
    return $ch;
}

/**
 * One round: HEDGE_WIDTH fresh flows opened together; the first to complete
 * the transfer wins and the rest are torn down immediately.
 *
 * @return array{ok:bool, body:string, errno:int, error:string, ms:int, flows:string[], winnerMs:int}
 */
function fetchRound($url, $ip, $width, $round) {
    $mh = curl_multi_init();
    $handles = [];
    for ($i = 0; $i < $width; $i++) {
        $ch = makeFlowHandle($url, $ip);
        curl_multi_add_handle($mh, $ch);
        // A plain list: cURL handles are resources on PHP 7 and objects on
        // PHP 8, so they must not be used as array keys.
        $handles[] = $ch;
    }

    $startedAt = microtime(true);
    $flows = [];
    $winner = null;
    $lastErrno = 0;
    $lastError = '';
    $running = 0;

    do {
        // Drive all transfers. On very old libcurl this can ask to be called
        // again immediately; falling through to info_read and select is
        // correct in that case too, so the return value is not inspected.
        curl_multi_exec($mh, $running);
        while (($info = curl_multi_info_read($mh)) !== false) {
            $ch = $info['handle'];
            $errno = (int) $info['result'];
            $ms = (int) round((microtime(true) - $startedAt) * 1000);
            $label = sprintf('r%d.%d', $round, count($flows) + 1);
            if ($errno === CURLE_OK) {
                $flows[] = sprintf('%s ok %dms tls=%dms', $label, $ms,
                    (int) round(curl_getinfo($ch, CURLINFO_APPCONNECT_TIME) * 1000));
                if ($winner === null) {
                    $winner = [
                        'body' => (string) curl_multi_getcontent($ch),
                        'ms' => $ms,
                    ];
                }
            } else {
                $flows[] = sprintf('%s errno=%d %dms', $label, $errno, $ms);
                $lastErrno = $errno;
                $lastError = curl_error($ch);
            }
        }
        if ($winner !== null) {
            break;
        }
        if ($running > 0) {
            // A negative return here means "nothing to wait on yet" on older
            // libcurl builds; back off briefly rather than spin.
            if (curl_multi_select($mh, 0.05) === -1) {
                usleep(10000);
            }
        }
    } while ($running > 0);

    // Tear down everything, including flows still in flight after a win. Removing
    // a handle from the multi aborts its transfer, which closes the socket.
    foreach ($handles as $ch) {
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);

    return [
        'ok' => $winner !== null,
        'body' => $winner !== null ? $winner['body'] : '',
        'errno' => $winner !== null ? 0 : $lastErrno,
        'error' => $winner !== null ? '' : $lastError,
        'ms' => (int) round((microtime(true) - $startedAt) * 1000),
        'flows' => $flows,
        'winnerMs' => $winner !== null ? $winner['ms'] : 0,
    ];
}

function fetchReceipt($url) {
    global $__stage, $__startedAt;

    $__stage = 'dns-resolve';
    $resolution = resolveUpstreamAddress();
    $ip = $resolution['ip'];

    // No TCP pre-check any more. It answered a question that is no longer open
    // (TCP always connects here), cost up to 1s of budget, and opened a
    // connection that sent no data before closing — a pattern that some edges
    // count against a source address. The flows below are the reachability test.

    $__stage = 'provider-fetch';
    $allFlows = [];
    $body = '';
    $ok = false;
    $lastErrno = 0;
    $lastError = '';
    $rounds = 0;

    for ($round = 1; $round <= MAX_ROUNDS; $round++) {
        $elapsedMs = (microtime(true) - $__startedAt) * 1000;
        // Never start a round the budget cannot absorb; an explicit failure
        // inside the budget beats a truthful one after the API has hung up.
        if ($round > 1 && $elapsedMs + FLOW_TOTAL_MS > RELAY_BUDGET_MS - RELAY_DOM_RESERVE_MS) {
            break;
        }
        $rounds = $round;
        $result = fetchRound($url, $ip, HEDGE_WIDTH, $round);
        $allFlows = array_merge($allFlows, $result['flows']);
        if ($result['ok']) {
            $ok = true;
            $body = $result['body'];
            if ($ip !== null && $ip !== '' && $resolution['source'] !== 'cache') {
                rememberUpstreamAddress($ip);
            }
            break;
        }
        $lastErrno = $result['errno'];
        $lastError = $result['error'];
    }

    $probe = sprintf(
        'ipSource=%s ip=%s rounds=%d width=%d handshakeDeadlineMs=%d flows=[%s] curlErrno=%d',
        $resolution['source'],
        (string) $ip,
        $rounds,
        HEDGE_WIDTH,
        HANDSHAKE_DEADLINE_MS,
        implode(' ', $allFlows),
        $lastErrno
    );

    if ($ok) {
        $htmlBytes = strlen($body);
        if ($htmlBytes > MAX_HTML_BYTES) {
            // Do not truncate: a cut-off page parses into plausible-looking but
            // wrong field values, which is worse than an explicit failure.
            return [
                'success' => false,
                'error' => "Provider page is too large to parse ({$htmlBytes} bytes, limit " . MAX_HTML_BYTES . ").",
                'details' => "{$probe} | the receipt page exceeded the parse budget; do not truncate it, because a partial page yields wrong field values"
            ];
        }
        return ['success' => true, 'html' => $body, 'probe' => $probe];
    }

    $error_no = $lastErrno;
    $error_msg = $lastError;

    // Group specific cURL errors
    $is_ssl_error = in_array($error_no, [35, 51, 58, 59, 60, 64, 66, 77, 82, 83]); // SSL related errors
    $is_connection_error = in_array($error_no, [6, 7, 28]); // 6: COULDNT_RESOLVE_HOST, 7: COULDNT_CONNECT, 28: OPERATION_TIMEDOUT

    if ($is_ssl_error) {
        // errno 60 is this host's certificate store, not the provider's
        // certificate. The provider presents a GlobalSign RSA OV SSL CA 2018
        // chain; a host without that root in its CA bundle fails here and the
        // fix is on the host, so do not send the operator chasing Ethio Telecom.
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
            'error' => "Ethiotelecom did not complete a TLS handshake on any of " . count($allFlows) . " fresh connections. Every flow from this host to the provider was dead this time; see the probe for whether that is the provider, this address, or the path.",
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
    // The per-flow log from the fetch stage. This is the number that matters
    // for this provider: how many fresh connections it took to find a live one.
    // Watch it in the API logs; if it trends towards every flow dying, the
    // provider-side fault is getting worse and no relay budget will save it.
    'flows' => isset($fetchResult['probe']) ? $fetchResult['probe'] : null,
];

$__stage = 'respond';
respond($response, 200);
?>
