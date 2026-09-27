<?php
header("Content-Type: application/json");

// ── Always answer ────────────────────────────────────────────────────────────
// The API's own relay timeout is 18s, so this script must always respond well
// before that. Two failure modes used to produce a completely empty response:
//   * cURL can block indefinitely in DNS resolution, which CURLOPT_TIMEOUT does
//     not reliably bound on all PHP/libcurl builds.
//   * When the host kills the script at max_execution_time the fatal error is
//     suppressed, so nothing is written and the caller sees no response at all
//     instead of the intended 502.
// Every exit path therefore goes through respond(), and a shutdown handler emits
// a valid document naming the stalled stage if the script dies unexpectedly.
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

// Prefer an environment variable when the hosting panel supports one. Otherwise
// replace the placeholder below before uploading this file.
$TELEBIRR_PROXY_KEY = getenv('TELEBIRR_PROXY_KEY') ?: 'YOUR_SECRET_PROXY_KEY_HERE';

// Check for proxy key. Return a real HTTP status as well as the JSON error so a
// broken proxy is distinguishable from a valid-but-missing receipt.
if (!isset($_GET['key']) || !hash_equals($TELEBIRR_PROXY_KEY, (string) $_GET['key'])) {
    respond([
        "success" => false,
        "error" => "Unauthorized: Invalid or missing proxy key"
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

/**
 * Bound DNS + TCP independently of cURL.
 *
 * CURLOPT_TIMEOUT does not reliably cover name resolution, and a stalled resolver
 * on shared hosting is the one failure that produced an unbounded hang. Opening
 * our own socket first gives a hard ceiling and a precise error, and warms the
 * resolver so the cURL that follows begins resolving immediately.
 */
function assertUpstreamReachable(string $host, int $port, int $timeoutSeconds): array {
    $errno = 0;
    $errstr = '';
    $startedAt = microtime(true);
    $socket = @fsockopen("ssl://{$host}:{$port}", $timeoutSeconds, $errno, $errstr, STREAM_CLIENT_CONNECT);
    $elapsedMs = round((microtime(true) - $startedAt) * 1000);
    if ($socket === false) {
        return [
            'ok' => false,
            'elapsedMs' => $elapsedMs,
            'error' => "could not open a socket to {$host}:{$port} after {$elapsedMs}ms (errno={$errno} {$errstr})"
        ];
    }
    fclose($socket);
    return ['ok' => true, 'elapsedMs' => $elapsedMs, 'error' => ''];
}

function fetchReceipt($url) {
    global $__stage;
    $__stage = 'dns-precheck';
    $precheck = assertUpstreamReachable('transactioninfo.ethiotelecom.et', 443, 5);
    if (!$precheck['ok']) {
        return [
            'success' => false,
            'error' => "Ethiotelecom is unreachable. The proxy might be blocked or Ethiotelecom is experiencing hosting issues.",
            'details' => $precheck['error']
        ];
    }

    $__stage = 'provider-fetch';
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 8);
    // 5s DNS/TCP precheck + 10s fetch = 15s worst case, comfortably inside the
    // API's 18s relay timeout, so this script is the one that always answers
    // with a diagnosis rather than the API reporting a bare timeout.
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    // Abort a connection that stalls mid-body instead of burning the full
    // timeout waiting for more data that never arrives.
    curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 512);
    curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, 5);
    curl_setopt($ch, CURLOPT_ENCODING, '');
    curl_setopt($ch, CURLOPT_USERAGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language: am-ET,am;q=0.9,en-US;q=0.8,en;q=0.7"
    ]);

    // Attempt standard fetch (Secure SSL)
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    $response = curl_exec($ch);
    $error_no = curl_errno($ch);
    $error_msg = curl_error($ch);

    if ($error_no === 0) {
        curl_close($ch);
        return ['success' => true, 'html' => $response];
    }

    // Group specific cURL errors
    $is_ssl_error = in_array($error_no, [35, 51, 58, 59, 60, 64, 66, 77, 82, 83]); // SSL related errors
    $is_connection_error = in_array($error_no, [6, 7, 28]); // 6: COULDNT_RESOLVE_HOST, 7: COULDNT_CONNECT, 28: OPERATION_TIMEDOUT

    curl_close($ch);

    if ($is_ssl_error) {
        return [
            'success' => false,
            'error' => "SSL Certificate issue from Ethiotelecom.",
            'details' => $error_msg
        ];
    }

    if ($is_connection_error) {
        return [
            'success' => false,
            'error' => "Ethiotelecom is unreachable. The proxy might be blocked or Ethiotelecom is experiencing hosting issues.",
            'details' => $error_msg
        ];
    }

    // Any other cURL errors
    return [
        'success' => false,
        'error' => "Failed to fetch receipt from Ethiotelecom.",
        'details' => $error_msg
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

// Fallback DOM parsing functions (keeping your original approach as backup)
libxml_use_internal_errors(true);
$dom = new DOMDocument();
$dom->loadHTML('<?xml encoding="utf-8" ?>' . $html);
$xpath = new DOMXPath($dom);
libxml_clear_errors();

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
// attributable rather than looking like a network problem.
$__stage = 'extract';

$response = [
    "success" => true,
    "data" => [
        "payerName" => extractWithRegex($html, ["የከፋይ ስም/Payer Name", "Payer Name"]) ?: getNextCellText($xpath, ["የከፋይ ስም/Payer Name", "Payer Name"]),
        "payerTelebirrNo" => extractWithRegex($html, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]) ?: getNextCellText($xpath, ["የከፋይ ቴሌብር ቁ./Payer telebirr no.", "Payer telebirr no.", "Payer Telebirr No."]),
        "creditedPartyName" => $creditedPartyName,
        "creditedPartyAccountNo" => $creditedPartyAccountNo,
        "bankName" => $bankName,
        "customerNote" => extractWithRegex($html, ["የደንበኛ መልዕክት/Customer Note", "Customer Note"]) ?: getNextCellText($xpath, ["የደንበኛ መልዕክት/Customer Note", "Customer Note"]),
        "transactionStatus" => extractWithRegex($html, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]) ?: getNextCellText($xpath, ["የክፍያው ሁኔታ/transaction status", "Transaction status", "transaction status"]),
        "receiptNo" => extractReceiptNoRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቁጥር/Receipt No.", "Receipt No."]),
        "paymentDate" => extractDateRegex($html) ?: getNextCellText($xpath, ["የክፍያ ቀን/Payment date", "Payment date"]),
        "settledAmount" => $settledAmount,
        "serviceFee" => $serviceFee,
        "serviceFeeVAT" => extractWithRegex($html, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]) ?: getNextCellText($xpath, ["የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT", "Service fee VAT"]),
        "totalPaidAmount" => extractWithRegex($html, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"]) ?: getNextCellText($xpath, ["ጠቅላላ የተከፈለ/Total Paid Amount", "Total Paid Amount"])
    ]
];

$__stage = 'respond';
respond($response, 200);
?>
