<?php
/**
 * Telebirr upstream TLS probe — DIAGNOSTIC, DELETE AFTER USE.
 *
 * Why this exists
 * ---------------
 * The relay at proxy.noveld.com.et cannot complete a TLS handshake with
 * transactioninfo.ethiotelecom.et. The symptom is curl errno 28 with
 * "0 out of 0 bytes received": fsockopen() reaches the host in ~200-300ms, so
 * TCP is fine, but not a single byte comes back after the ClientHello. The same
 * URL, same reference, over the same provider, succeeds from other networks in
 * ~40ms on the TLS handshake and returns a 26KB page.
 *
 * That makes this a property of the Plesk host or of its path to the provider,
 * not of the provider and not of verify.php. verify.php can only observe the
 * failure; this file isolates which TLS setting, if any, the host can complete.
 *
 * It walks the matrix of options verify.php has used, plus a few it has not, so
 * the answer is a single number rather than another round trip.
 *
 * SECURITY: this prints the host's TLS capabilities to whoever can reach it, so
 * it refuses to run without the relay key. Upload it only long enough to read the
 * output, then delete it. It must never be left on a public document root.
 */

header('Content-Type: text/plain; charset=utf-8');

// ── Same key gate as verify.php. Copy your real key here. ────────────────────
const PROBE_KEY = 'PASTE_YOUR_KEY_HERE';
// ─────────────────────────────────────────────────────────────────────────────
if (PROBE_KEY === 'PASTE_YOUR_KEY_HERE') {
    http_response_code(500);
    echo "Set PROBE_KEY at the top of this file to your relay key before running it.\n";
    exit;
}
if (!isset($_GET['key']) || !hash_equals(PROBE_KEY, (string) $_GET['key'])) {
    http_response_code(401);
    echo "Unauthorized.\n";
    exit;
}

const HOST = 'transactioninfo.ethiotelecom.et';
const PATH = '/receipt/';

/**
 * @return array{label:string, ok:bool, ms:int, errno:int, err:string, note:string}
 */
function attempt(string $label, callable $configure): array
{
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, 'https://' . HOST . PATH);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 6);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
    curl_setopt($ch, CURLOPT_USERAGENT, 'telebirr-tls-probe');
    $configure($ch);

    $startedAt = microtime(true);
    $body = curl_exec($ch);
    $errno = curl_errno($ch);
    $err = curl_error($ch);
    $ms = round((microtime(true) - $startedAt) * 1000);
    $http = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'label' => $label,
        // A 4xx still proves the handshake completed, which is the only thing
        // this probe measures. Treating "not 200" as failure would hide success.
        'ok' => $errno === 0 && $http > 0,
        'ms' => $ms,
        'errno' => $errno,
        'err' => $err,
        'note' => $errno === 0 ? "http={$http} bytes=" . strlen((string) $body) : '',
    ];
}

$sslVersionNames = [];
if (defined('CURL_SSLVERSION_TLSv1_2')) {
    $sslVersionNames['TLSv1_2'] = CURL_SSLVERSION_TLSv1_2;
}
if (defined('CURL_SSLVERSION_TLSv1_3')) {
    $sslVersionNames['TLSv1_3'] = CURL_SSLVERSION_TLSv1_3;
}

echo "=== host ===\n";
echo 'php          ' . PHP_VERSION . "\n";
echo 'curl         ' . (function_exists('curl_version') ? curl_version()['version'] : 'n/a') . "\n";
echo 'ssl backend  ' . (function_exists('curl_version')
    ? (curl_version()['ssl_version'] ?? 'n/a')
    : 'n/a') . "\n";
echo 'openssl      ' . (defined('OPENSSL_VERSION_TEXT') ? OPENSSL_VERSION_TEXT : 'n/a') . "\n";
echo 'max_execution_time ' . ini_get('max_execution_time') . "\n";
echo 'memory_limit       ' . ini_get('memory_limit') . "\n";
echo 'disable_functions  ' . ini_get('disable_functions') . "\n";
echo "\n";

echo "=== raw TCP (no TLS) ===\n";
$errno = 0;
$errstr = '';
$startedAt = microtime(true);
$sock = @fsockopen('tcp://' . HOST . ':443', 4, $errno, $errstr, STREAM_CLIENT_CONNECT);
printf(
    "tcp connect   %s in %dms (errno=%d %s)\n",
    $sock === false ? 'FAILED' : 'ok',
    round((microtime(true) - $startedAt) * 1000),
    $errno,
    $errstr
);
if ($sock !== false) {
    fclose($sock);
}
echo "\n";

echo "=== TLS handshake matrix ===\n";
echo "A 200 or any HTTP status means the handshake completed.\n\n";

$attempts = [
    'default (library picks)' => function ($ch) {},
    'TLS1.2 forced' => function ($ch) use ($sslVersionNames) {
        if (isset($sslVersionNames['TLSv1_2'])) {
            curl_setopt($ch, CURLOPT_SSLVERSION, $sslVersionNames['TLSv1_2']);
        }
    },
    'TLS1.3 forced' => function ($ch) use ($sslVersionNames) {
        if (isset($sslVersionNames['TLSv1_3'])) {
            curl_setopt($ch, CURLOPT_SSLVERSION, $sslVersionNames['TLSv1_3']);
        }
    },
    'TLS1.2 + SECLEVEL=1 (current verify.php)' => function ($ch) use ($sslVersionNames) {
        if (isset($sslVersionNames['TLSv1_2'])) {
            curl_setopt($ch, CURLOPT_SSLVERSION, $sslVersionNames['TLSv1_2']);
        }
        curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=1');
    },
    'TLS1.2 + SECLEVEL=0' => function ($ch) use ($sslVersionNames) {
        if (isset($sslVersionNames['TLSv1_2'])) {
            curl_setopt($ch, CURLOPT_SSLVERSION, $sslVersionNames['TLSv1_2']);
        }
        curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=0');
    },
    'SECLEVEL=0, version unpinned' => function ($ch) {
        curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=0');
    },
    'SECLEVEL=2, version unpinned' => function ($ch) {
        curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=2');
    },
    // If the handshake dies only with verification on, the host is missing the
    // issuer root. If it dies with verification off too, the handshake itself is
    // being dropped, which points at the network path rather than the trust store.
    'verify off (diagnostic only)' => function ($ch) {
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
    },
    'TLS1.2 + SECLEVEL=0 + verify off' => function ($ch) use ($sslVersionNames) {
        if (isset($sslVersionNames['TLSv1_2'])) {
            curl_setopt($ch, CURLOPT_SSLVERSION, $sslVersionNames['TLSv1_2']);
        }
        curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=0');
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
    },
];

foreach ($attempts as $label => $configure) {
    $result = attempt((string) $label, $configure);
    printf(
        "%-40s %-7s %5dms  errno=%-3d %s%s\n",
        $result['label'],
        $result['ok'] ? 'OK' : 'FAIL',
        $result['ms'],
        $result['errno'],
        $result['ok'] ? $result['note'] . ' ' : '',
        $result['ok'] ? '' : $result['err']
    );
}

// The single most useful number this probe produces. A provider that fails half
// the time is a retry problem, not a configuration problem, and one pass of the
// matrix above cannot tell those apart: the same options have been observed
// succeeding and failing minutes apart. Repeat one plain request and report the
// success rate.
echo "\n=== repeat sample: 6 identical requests ===\n";
$repeats = 6;
$ok = 0;
$totalMs = 0;
$errnos = [];
for ($i = 1; $i <= $repeats; $i++) {
    $result = attempt('repeat', function ($ch) {});
    $totalMs += $result['ms'];
    if ($result['ok']) {
        $ok++;
    } else {
        $errnos[] = $result['errno'];
    }
    printf(
        "  #%d %-7s %5dms %s\n",
        $i,
        $result['ok'] ? 'OK' : 'FAIL',
        $result['ms'],
        $result['ok'] ? '' : $result['err']
    );
}
printf(
    "\n  %d/%d succeeded, mean %dms, failure errnos: %s\n",
    $ok,
    $repeats,
    (int) round($totalMs / $repeats),
    $errnos === [] ? 'none' : implode(',', $errnos)
);
if ($ok < $repeats) {
    echo "  Intermittent. Retry inside a budget; a single attempt is a coin flip.\n";
}

echo "\n=== how to read this ===\n";
echo "* Rows disagreeing between two runs of this file, or succeeding in some\n";
echo "  rows and not others, is the finding. It means the fault is intermittent,\n";
echo "  so the fix is to retry inside a budget rather than to change TLS options.\n";
echo "  The repeat sample above is the direct measurement of that.\n";
echo "* 'Resolving timed out' in an error is DNS, not TLS. It is worth fixing at\n";
echo "  the host: in /etc/resolv.conf set 'options timeout:1 attempts:1' so a dead\n";
echo "  nameserver fails fast instead of blocking. Note that CURLOPT_TIMEOUT does\n";
echo "  not reliably cover name resolution on every cURL build, so an unbounded\n";
echo "  resolver can overrun any timeout set here.\n";
echo "* TLS 1.3 failing with 'tlsv1 alert protocol version' is expected and\n";
echo "  correct: this provider is TLS 1.2 only. Pin TLS 1.2 and ignore that row.\n";
echo "* If verify-off fails too, disabling verification is not the answer, so do\n";
echo "  not ship it that way.\n";
echo "\nDelete this file once you have the answer.\n";
