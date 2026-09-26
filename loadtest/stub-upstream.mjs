#!/usr/bin/env node
/**
 * Stand-in for the Ethiopia-hosted PHP relays (verify.php / mpesa.php) plus the
 * upstream providers, for lab runs that must not touch real banks/telecoms.
 *
 *   node loadtest/stub-upstream.mjs --port 4100 --delay-ms 400
 *
 * Routes
 *   GET /verify.php?reference=…&key=…   Telebirr receipt HTML (cheerio path)
 *   GET /mpesa.php?reference=…&key=…    Safaricom-style "receipt not found" JSON
 *   GET /healthz                        readiness
 * Fault injection (for resilience tests):
 *   ?delay=1500        override the delay
 *   ?status=500        force a 5xx
 *   ?ref=slow          placeholder
 */
import http from 'node:http';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(argValue('--port', process.env.STUB_PORT || 4100));
const baseDelayMs = Number(argValue('--delay-ms', process.env.STUB_DELAY_MS || 400));
const proxyKey = process.env.STUB_PROXY_KEY || 'stub-proxy-key';

function telebirrHtml(reference) {
  // Shaped like the Ethio Telecom receipt page: the extractor looks for
  // "label</td><td>value" pairs (a mix of regex and css selectors).
  return `<!DOCTYPE html><html><head><title>Telebirr Receipt</title></head><body>
<div class="container"><table class="receipttable">
<tr><td>የክፍያ ቁጥር/Receipt No.</td><td class="receipttableTd receipttableTd2">${reference}</td></tr>
<tr><td>የገዢ ስም/Payer Name</td><td class="receipttableTd receipttableTd2">Abebe Kebede</td></tr>
<tr><td>የገዢ ቴሌብር ቁጥር/Payer Telebirr No</td><td class="receipttableTd receipttableTd2">251911223344</td></tr>
<tr><td>የገንዘብ ተቀባይ ስም/Credited Party Name</td><td class="receipttableTd receipttableTd2">FitLife Hub</td></tr>
<tr><td>የገንዘብ ተቀባይ አካውንት/Credited Party Account No</td><td class="receipttableTd receipttableTd2">1000123456789</td></tr>
<tr><td>የክፍያ ሁኔታ/Transaction Status</td><td class="receipttableTd receipttableTd2">Completed</td></tr>
<tr><td>የክፍያ ቀን/Payment date</td><td class="receipttableTd receipttableTd2">2026-09-26 10:15:32</td></tr>
<tr><td>የተከፈለው መጠን/Settled Amount</td><td class="receipttableTd receipttableTd2">299.00 Birr</td></tr>
<tr><td>የአገልግሎት ክፍያ/Service fee</td><td class="receipttableTd receipttableTd2">1.50 Birr</td></tr>
<tr><td>የአገልግሎት ክፍያ ተ.እ.ታ/Service fee VAT</td><td class="receipttableTd receipttableTd2">0.23 Birr</td></tr>
<tr><td>ጠቅላላ የተከፈለ/Total Paid Amount</td><td class="receipttableTd receipttableTd2">300.73 Birr</td></tr>
</table></div></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const delay = Number(url.searchParams.get('delay') ?? baseDelayMs);
  const forcedStatus = url.searchParams.get('status');

  const respond = () => {
    if (forcedStatus) {
      res.writeHead(Number(forcedStatus), { 'content-type': 'text/plain' });
      res.end('stub forced failure');
      return;
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    const key = url.searchParams.get('key');
    const reference = url.searchParams.get('reference') || '';

    if (key !== proxyKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized: Invalid or missing proxy key' }));
      return;
    }

    if (url.pathname === '/mpesa.php') {
      // What Safaricom returns for a receipt that does not exist — a real
      // response, so the app takes the "domain failure" path (no PDF parsing).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        responseCode: '2032',
        responseDescription: 'The transaction receipt number does not exist.',
      }));
      return;
    }

    if (url.pathname === '/verify.php' || url.pathname === '/telebirr') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(telebirrHtml(reference || 'CE2513001XYT'));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"success":false,"error":"stub: unknown route"}');
  };

  setTimeout(respond, Number.isFinite(delay) ? delay : baseDelayMs);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`stub upstream listening on http://0.0.0.0:${port} (delay ${baseDelayMs}ms, key ${proxyKey === 'stub-proxy-key' ? 'default' : 'custom'})`);
});
