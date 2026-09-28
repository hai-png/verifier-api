<?php
/**
 * Telebirr upstream TLS sample — DIAGNOSTIC, DELETE AFTER USE.
 *
 * One question only: does PHP's own TLS succeed where cURL fails?
 *
 * Both go through OpenSSL but share nothing below it — cURL has its own
 * connection handling — so if they disagree, the fault is libcurl on this host
 * and verify.php can use streams instead. If they agree, the fault is this
 * host's path to the provider and no code change will help.
 *
 * Everything else about this relay is already established: the provider answers
 * other networks in ~40ms, TCP connects here in 0ms, the TLS handshake fails
 * roughly half the time, spacing requests does not help, and the page is 26KB
 * so extraction is irrelevant. Do not re-measure any of that.
 *
 * BUDGET: this host has max_execution_time=30, and a script killed at the limit
 * emits nothing at all. An earlier version of this probe ran 9 cURL rows plus
 * two sample sets and could need over 100s, so it produced a silent hang rather
 * than an answer. Everything below is sized to finish inside 30s even when
 * every single attempt fails:
 *
 *   4 cURL attempts x 3s  = 12s
 *   3 streams x 4s        = 12s
 *   overhead              ~1s
 *
 * SECURITY: prints this host's TLS capabilities to whoever can reach it, so it
 * refuses to run without the relay key. Upload only long enough to read the
 * output, then delete it.
 */

header('Content-Type: text/plain; charset=utf-8');

const PROBE_KEY = 'PASTE_YOUR_KEY_HERE';
const HOST = 'transactioninfo.ethiotelecom.et';
const CURL_SAMPLES = 4;
const CURL_TIMEOUT_S = 3;
const STREAM_SAMPLES = 3;
const STREAM_TIMEOUT_S = 4;

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

echo "=== host ===\n";
echo 'php              ' . PHP_VERSION . "\n";
echo 'curl             ' . (function_exists('curl_version') ? curl_version()['version'] : 'n/a') . "\n";
echo 'curl ssl backend ' . (function_exists('curl_version')
    ? (curl_version()['ssl_version'] ?? 'n/a')
    : 'n/a') . "\n";
echo 'openssl          ' . (defined('OPENSSL_VERSION_TEXT') ? OPENSSL_VERSION_TEXT : 'n/a') . "\n";
echo 'max_execution_time ' . ini_get('max_execution_time') . "\n\n";

/**
 * One cURL attempt, matching verify.php's settings so the sample reflects what
 * verify.php actually does rather than some idealised configuration.
 */
function curlAttempt($ip) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, 'https://' . HOST . '/receipt/');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, CURL_TIMEOUT_S);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, CURL_TIMEOUT_S);
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    if ($ip !== null && $ip !== '') {
        curl_setopt($ch, CURLOPT_RESOLVE, [HOST . ':443:' . $ip]);
    }
    $startedAt = microtime(true);
    curl_exec($ch);
    $errno = curl_errno($ch);
    $ms = round((microtime(true) - $startedAt) * 1000);
    curl_close($ch);
    return ['ok' => $errno === 0, 'ms' => $ms, 'errno' => $errno];
}

// Same address verify.php would use, so this is comparable to production.
$ip = '196.188.116.120';
$cached = @file_get_contents(__DIR__ . '/.telebirr-upstream-ip');
if (is_string($cached) && preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', trim($cached))) {
    $ip = trim($cached);
}

echo "=== cURL, " . CURL_SAMPLES . " attempts, " . CURL_TIMEOUT_S . "s each (ip $ip) ===\n";
$curlOk = 0;
for ($i = 1; $i <= CURL_SAMPLES; $i++) {
    $r = curlAttempt($ip);
    if ($r['ok']) {
        $curlOk++;
    }
    printf("  #%d %-4s %4dms%s\n", $i, $r['ok'] ? 'OK' : 'FAIL', $r['ms'],
        $r['ok'] ? '' : ' errno=' . $r['errno']);
    @ob_flush();
    @flush();
}
printf("  curl: %d/%d\n\n", $curlOk, CURL_SAMPLES);

// default_socket_timeout bounds the TLS handshake, which stream_socket_client's
// own connect timeout does not. Without this a stalled handshake waits far past
// the script's execution limit and the whole probe returns nothing.
ini_set('default_socket_timeout', (string) STREAM_TIMEOUT_S);

echo "=== PHP streams, " . STREAM_SAMPLES . " attempts ===\n";
$streamOk = 0;
for ($i = 1; $i <= STREAM_SAMPLES; $i++) {
    $startedAt = microtime(true);
    $errno = 0;
    $errstr = '';
    $fp = @stream_socket_client(
        'ssl://' . HOST . ':443',
        $errno,
        $errstr,
        STREAM_TIMEOUT_S,
        STREAM_CLIENT_CONNECT,
        stream_context_create([
            'ssl' => [
                'peer_name' => HOST,
                'verify_peer' => true,
                'verify_peer_name' => true,
                'SNI_enabled' => true,
            ],
        ])
    );
    $ms = round((microtime(true) - $startedAt) * 1000);
    if ($fp !== false) {
        $streamOk++;
        fclose($fp);
    }
    printf("  #%d %-4s %4dms%s\n", $i, $fp !== false ? 'OK' : 'FAIL', $ms,
        $fp !== false ? '' : ' errno=' . $errno . ' ' . $errstr);
    @ob_flush();
    @flush();
}
printf("  streams: %d/%d\n\n", $streamOk, STREAM_SAMPLES);

echo "=== answer ===\n";
if ($streamOk === STREAM_SAMPLES && $curlOk < CURL_SAMPLES) {
    echo "PHP streams succeed where cURL fails. The fault is libcurl on this host,\n";
    echo "not the network. verify.php should use streams. This is fixable in code.\n";
} elseif ($streamOk < STREAM_SAMPLES && $curlOk < CURL_SAMPLES) {
    echo "Both fail. The fault is this host's path to the provider, not cURL and\n";
    echo "not PHP. No code change will help. A second relay host on a different\n";
    echo "network is the fix.\n";
} else {
    echo "Inconclusive or both healthy right now. The failure is intermittent, so a\n";
    echo "clean run proves nothing. Re-run a few times and compare the two rates:\n";
    echo "if streams consistently beats cURL, switch verify.php to streams.\n";
}
echo "\nDelete this file once you have the answer.\n";
