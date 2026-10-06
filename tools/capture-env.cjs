// Capture a service's environment variables to a gitignored .env backup.
//
// Prints KEY NAMES and whether each is set — never a value. Writes the real
// values to the backup file so a delete/recreate cycle does not destroy
// configuration that Render's CLI cannot show us and cannot recover.
const fs = require('fs');
const path = require('path');

const SERVICE_ID = process.argv[2];
const OUT = path.join(__dirname, '..', '.env');

if (!SERVICE_ID) {
  console.error('usage: node capture-env.cjs <service-id>');
  process.exit(1);
}

// Minimal read of the CLI's stored key. Never logged.
function readApiKey() {
  const raw = fs.readFileSync(path.join(process.env.USERPROFILE, '.render', 'cli.yaml'), 'utf8');
  // api: { key: <token> }
  const m = raw.match(/^\s*key:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

(async () => {
  const key = readApiKey();
  if (!key) {
    console.log('RESULT: no API key found in ~/.render/cli.yaml');
    process.exit(2);
  }

  const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });

  if (!res.ok) {
    console.log('RESULT: HTTP ' + res.status + ' ' + (res.statusText || ''));
    console.log('  (the stored token may be an OAuth token the public API will not accept)');
    process.exit(3);
  }

  const body = await res.json();
  const vars = (Array.isArray(body) ? body : []).map((e) => e.envVar || e);

  const lines = [
    '# Render environment backup — captured before a service delete/recreate.',
    '# Gitignored. Values are real; treat this file as a credential.',
    '# Source service: ' + SERVICE_ID,
    '',
  ];
  const summary = [];
  for (const v of vars) {
    const set = v.value !== undefined && v.value !== null && String(v.value).length > 0;
    summary.push(`${v.key}=${set ? 'SET(' + String(v.value).length + ' chars)' : 'EMPTY'}`);
    lines.push(`${v.key}=${v.value === undefined || v.value === null ? '' : v.value}`);
  }
  lines.push('');

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

  console.log('RESULT: captured ' + vars.length + ' variables to .env (gitignored)');
  for (const s of summary) console.log('  ' + s);
})().catch((e) => {
  console.log('RESULT: error ' + (e && e.message ? e.message : String(e)));
  process.exit(4);
});