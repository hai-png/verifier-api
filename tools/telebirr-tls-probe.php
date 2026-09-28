<?php
/**
 * Telebirr upstream path probe — DIAGNOSTIC, DELETE AFTER USE.
 *
 * One question: is the dead-handshake fault specific to the provider's TLS
 * endpoint, specific to the route to the provider, or a property of this host?
 *
 * Established already, do not re-measure: from this host TCP connects to
 * 196.188.116.120 in <1ms, and the TLS handshake then either completes in ~30ms
 * or never gets a byte back, roughly half of the time per connection. The
 * ~1.0s and ~3.0-3.3s "slow successes" are TCP retransmission backoff, so the
 * outcome is decided per flow. That is why verify.php now hedges fresh
 * connections instead of waiting on one.
 *
 * What is NOT known is where the flows die, and that decides the real fix:
 *
 *   A. provider:443 flaky, provider:80 clean, other TLS hosts clean
 *        -> the provider's TLS endpoint (a bad backend behind its balancer, or
 *           its edge throttling this shared address). Fix: a relay on a
 *           different address, and/or a report to Ethio Telecom with this output.
 *   B. provider:443 AND provider:80 flaky, other hosts clean
 *        -> the route from this host to 196.188.116.120. Fix: hosting-provider
 *           ticket (path/ECMP/MTU), or a relay on a different network.
 *   C. everything flaky
 *        -> this host's uplink/NIC/firewall. Fix: move the relay.
 *   D. everything clean in this run
 *        -> proves nothing; the fault is intermittent. Run it again, and
 *           compare with verify.php's `flows` field in the API logs.
 *
 * Every target is addressed by IP literal with SNI carried separately, because
 * this host's resolver blocks for 28-56s and any hostname in a socket URL would
 * turn the probe into a hang. libcurl's connect timeout covers the TLS
 * handshake, so a target that connects but never completes TLS shows up as
 * errno=28 at the deadline, with tls=0.
 *
 * BUDGET: max_execution_time is 30s here and a script killed at the limit emits
 * nothing. All targets are sampled together in one curl_multi round, so a round
 * costs at most FLOW_TOTAL_MS regardless of how many die:
 *   ROUNDS x FLOW_TOTAL_MS = 8 x 2.5s = 20s worst case, ~1s typical.
 * Output is flushed per round so a partial run still tells you something.
 *
 * SECURITY: prints this host's reachability to whoever can call it, so it
 * refuses to run without the relay key. Upload only long enough to read the
 * output, then delete it.
 */

header('Content-Type: text/plain; charset=utf-8');

const PROBE_VERSION = '2026-09-28.path-vs-provider';
header('X-Probe-Version: ' . PROBE_VERSION);

const PROBE_KEY = 'PASTE_YOUR_KEY_HERE';
const ROUNDS = 8;
const HANDSHAKE_DEADLINE_MS = 2000;
const FLOW_TOTAL_MS = 2500;

// Targets. Addresses are literals on purpose; if one of the controls has moved,
// its row will say so (errno=7 on every round) and the other controls still
// answer the question.
$TARGETS = [
    // The subject.
    'provider:443' => ['url' => 'https://transactioninfo.ethiotelecom.et/', 'host' => 'transactioninfo.ethiotelecom.et', 'port' => 443, 'ip' => null, 'tls' => true],
    // Same address, no TLS. Separates "the TLS endpoint" from "the route".
    'provider:80'  => ['url' => 'http://transactioninfo.ethiotelecom.et/',  'host' => 'transactioninfo.ethiotelecom.et', 'port' => 80,  'ip' => null, 'tls' => false],
    // Another TLS host inside Ethio Telecom's network, different address.
    'ethiotelecom.et:443' => ['url' => 'https://www.ethiotelecom.et/', 'host' => 'www.ethiotelecom.et', 'port' => 443, 'ip' => '196.189.90.58', 'tls' => true],
    // A TLS host outside Ethiopia on a stable anycast address.
    'cloudflare:443' => ['url' => 'https://one.one.one.one/cdn-cgi/trace', 'host' => 'one.one.one.one', 'port' => 443, 'ip' => '1.1.1.1', 'tls' => true],
];

echo "probe build " . PROBE_VERSION . "\n";
@ob_flush();
@flush();

if (PROBE_KEY === 'PASTE_YOUR_KEY_HERE') {
    http_response_code(500);
    echo "Set PROBE_KEY at the top of this file to your relay key before running it.\n";
    exit;
}
if (!isset($_GET['key']) || !hash_equals(PROBE_KEY, (string) $_GET['key'])) {
    http_response_code(401);
    echo "unauthorized\n";
    exit;
}

// Use the same address verify.php uses, so the sample matches production.
$providerIp = '196.188.116.120';
$cached = @file_get_contents(__DIR__ . '/../.telebirr-upstream-ip');
if (!is_string($cached)) {
    $cached = @file_get_contents(__DIR__ . '/.telebirr-upstream-ip');
}
if (is_string($cached) && preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', trim($cached))) {
    $providerIp = trim($cached);
}
$TARGETS['provider:443']['ip'] = $providerIp;
$TARGETS['provider:80']['ip'] = $providerIp;

$v = curl_version();
printf("host: php=%s curl=%s ssl=%s max_execution_time=%s\n",
    PHP_VERSION, $v['version'], $v['ssl_version'], (string) ini_get('max_execution_time'));
printf("provider address: %s\n", $providerIp);
printf("plan: %d rounds, all %d targets per round, handshake deadline %dms, flow cap %dms\n\n",
    ROUNDS, count($TARGETS), HANDSHAKE_DEADLINE_MS, FLOW_TOTAL_MS);
@ob_flush();
@flush();

function makeHandle(array $t) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $t['url']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_NOBODY, false);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, HANDSHAKE_DEADLINE_MS);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, FLOW_TOTAL_MS);
    curl_setopt($ch, CURLOPT_FRESH_CONNECT, true);
    curl_setopt($ch, CURLOPT_FORBID_REUSE, true);
    curl_setopt($ch, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
    curl_setopt($ch, CURLOPT_MAXFILESIZE, 1048576);
    curl_setopt($ch, CURLOPT_USERAGENT, 'telebirr-path-probe/' . PROBE_VERSION);
    curl_setopt($ch, CURLOPT_RESOLVE, [$t['host'] . ':' . $t['port'] . ':' . $t['ip']]);
    if ($t['tls']) {
        // Mirror verify.php for the provider: TLS 1.2 pinned, verification on.
        if ($t['host'] === 'transactioninfo.ethiotelecom.et') {
            curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
            curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'DEFAULT:@SECLEVEL=1');
        }
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    }
    return $ch;
}

$stats = [];
foreach ($TARGETS as $name => $t) {
    $stats[$name] = ['ok' => 0, 'fail' => 0, 'tlsMs' => [], 'errnos' => []];
}

for ($round = 1; $round <= ROUNDS; $round++) {
    $mh = curl_multi_init();
    $handles = [];
    foreach ($TARGETS as $name => $t) {
        $ch = makeHandle($t);
        curl_multi_add_handle($mh, $ch);
        // Plain list: handles are resources on PHP 7, objects on PHP 8.
        $handles[] = [$name, $ch];
    }
    $startedAt = microtime(true);
    $running = 0;
    $rows = [];
    do {
        // Drive all transfers. On very old libcurl this can ask to be called
        // again immediately; falling through to info_read and select is
        // correct in that case too, so the return value is not inspected.
        curl_multi_exec($mh, $running);
        while (($info = curl_multi_info_read($mh)) !== false) {
            $ch = $info['handle'];
            $name = '?';
            foreach ($handles as $pair) {
                if ($pair[1] === $ch) { $name = $pair[0]; break; }
            }
            $errno = (int) $info['result'];
            $connectMs = (int) round(curl_getinfo($ch, CURLINFO_CONNECT_TIME) * 1000);
            $tlsMs = (int) round(curl_getinfo($ch, CURLINFO_APPCONNECT_TIME) * 1000);
            $totalMs = (int) round((microtime(true) - $startedAt) * 1000);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($errno === CURLE_OK) {
                $stats[$name]['ok']++;
                $stats[$name]['tlsMs'][] = $tlsMs;
                $rows[$name] = sprintf('ok   http=%d connect=%dms tls=%dms total=%dms', $code, $connectMs, $tlsMs, $totalMs);
            } else {
                $stats[$name]['fail']++;
                $stats[$name]['errnos'][$errno] = ($stats[$name]['errnos'][$errno] ?? 0) + 1;
                $rows[$name] = sprintf('FAIL errno=%d connect=%dms tls=%dms total=%dms %s', $errno, $connectMs, $tlsMs, $totalMs, curl_error($ch));
            }
        }
        if ($running > 0 && curl_multi_select($mh, 0.05) === -1) {
            usleep(10000);
        }
    } while ($running > 0);
    foreach ($handles as $pair) {
        curl_multi_remove_handle($mh, $pair[1]);
        curl_close($pair[1]);
    }
    curl_multi_close($mh);

    echo "round {$round}\n";
    foreach ($TARGETS as $name => $t) {
        printf("  %-22s %s\n", $name, $rows[$name] ?? 'no result');
    }
    @ob_flush();
    @flush();
}

echo "\nsummary (" . ROUNDS . " fresh connections per target)\n";
$rate = [];
foreach ($stats as $name => $s) {
    $n = $s['ok'] + $s['fail'];
    $rate[$name] = $n > 0 ? $s['ok'] / $n : 0;
    $tls = $s['tlsMs'];
    sort($tls);
    $errnos = [];
    foreach ($s['errnos'] as $e => $c) {
        $errnos[] = "errno{$e}x{$c}";
    }
    printf("  %-22s ok=%d/%d  tls(ms)=[%s]  %s\n",
        $name, $s['ok'], $n, implode(',', $tls), $errnos ? implode(' ', $errnos) : '');
}

$flaky = function ($name) use ($rate) { return $rate[$name] < 0.9; };
echo "\nreading\n";
if (!$flaky('provider:443') && !$flaky('provider:80') && !$flaky('ethiotelecom.et:443') && !$flaky('cloudflare:443')) {
    echo "  D. Everything was clean this run. That proves nothing about an intermittent fault;\n";
    echo "     run it again a few times, at different times of day, and compare with the\n";
    echo "     `flows` field verify.php now reports on every success.\n";
} elseif ($flaky('provider:443') && $flaky('provider:80') && $flaky('ethiotelecom.et:443') && $flaky('cloudflare:443')) {
    echo "  C. Every target loses flows from this host. This host's uplink/NIC/firewall is\n";
    echo "     dropping packets on established connections. Nothing in verify.php can fix\n";
    echo "     that; move the relay to another host, and send this output to the hosting provider.\n";
} elseif ($flaky('provider:443') && $flaky('provider:80')) {
    echo "  B. Both ports to the provider lose flows while other hosts are clean: the route\n";
    echo "     from this host to {$providerIp} is at fault (ECMP member, MTU, or a middlebox\n";
    echo "     on that path). Hosting-provider ticket with this output, or a relay on a\n";
    echo "     different network. verify.php's hedging is the right mitigation meanwhile.\n";
} elseif ($flaky('provider:443')) {
    echo "  A. Only the provider's TLS endpoint loses flows; plain HTTP to the same address\n";
    echo "     and other TLS hosts are clean. This is on the provider's side: a bad backend\n";
    echo "     behind its balancer, or its edge throttling this shared address. A relay on a\n";
    echo "     different address is the test that separates those two, and the fix for the\n";
    echo "     second. Report it to Ethio Telecom with this output either way.\n";
} else {
    echo "  Mixed result that does not match a pattern above; read the rows. A control that\n";
    echo "  fails with errno=7 on every round has simply moved address and can be ignored.\n";
}
echo "\nDelete this file when done.\n";
