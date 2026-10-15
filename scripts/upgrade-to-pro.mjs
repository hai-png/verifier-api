#!/usr/bin/env node
/**
 * Upgrade one or more workspaces from FREE to PRO.
 *
 * By default this is the full upgrade a paying customer gets: the PRO tier,
 * the PRO allowance applied immediately, and unlimited verifications + image
 * verifications. That is the same grant as
 *
 *   node scripts/grant-unlimited.mjs --tier PRO ws_abc
 *
 * with the tier filled in so the common operation has an obvious command.
 *
 *   node scripts/upgrade-to-pro.mjs ws_abc
 *   node scripts/upgrade-to-pro.mjs --months 12 ws_abc ws_def
 *   node scripts/upgrade-to-pro.mjs --plan-only ws_abc
 *   node scripts/upgrade-to-pro.mjs --verify-only ws_abc
 *
 * --plan-only keeps the workspace on the PRO allowance without granting the
 * unlimited flags; --verify-only / --images-only grant just one of them. Use
 * scripts/grant-unlimited.mjs directly for BUSINESS, FREE, or revocations.
 *
 * A tier change applies the new plan's allowance immediately — the admin
 * endpoint tops the balance up to the new quota (see POST
 * /admin/workspaces/plan), so the workspace can verify against PRO limits on
 * its next request. Without --months no expiry is set and the workspace stays
 * PRO until changed.
 *
 * Environment:
 *   ADMIN_SECRET   required. The same value the API is configured with.
 *   SMOKE_API_URL  optional. Defaults to the production API.
 *
 * Reads ADMIN_SECRET from the environment rather than argv, so it does not land
 * in shell history or in the process list.
 */

import { main } from './grant-unlimited.mjs';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Upgrade workspaces to PRO, with unlimited verifications and images.

Usage:
  node scripts/upgrade-to-pro.mjs <workspace-id> [more ids...]
  node scripts/upgrade-to-pro.mjs --months <n> <id>     add an expiry (1-120 months)
  node scripts/upgrade-to-pro.mjs --plan-only <id>      PRO plan, unlimited flags untouched
  node scripts/upgrade-to-pro.mjs --verify-only <id>    PRO + unlimited verifications only
  node scripts/upgrade-to-pro.mjs --images-only <id>    PRO + unlimited images only
  node scripts/upgrade-to-pro.mjs --help

For another tier or to revoke unlimited, use scripts/grant-unlimited.mjs.

Environment:
  ADMIN_SECRET   required — the API's ADMIN_SECRET
  SMOKE_API_URL  optional — defaults to https://verify.noveld.com.et`);
} else {
  // A dedicated script must not silently ignore a conflicting tier: someone
  // passing --tier BUSINESS here wants BUSINESS, and sending PRO instead would
  // make the audit note and the response a lie.
  if (argv.includes('--tier')) {
    console.error('upgrade-to-pro.mjs always sets --tier PRO. For another tier, use scripts/grant-unlimited.mjs --tier <tier>.');
    process.exitCode = 2;
  } else if (argv.includes('--revoke')) {
    console.error('--revoke belongs to scripts/grant-unlimited.mjs, not an upgrade script.');
    process.exitCode = 2;
  } else {
    if (!argv.includes('--months')) {
      console.log('No --months given: the plan has no expiry date and stays PRO until changed.');
    }
    main(['--tier', 'PRO', ...argv], { scriptName: 'upgrade-to-pro' })
      .then((code) => { process.exitCode = code; })
      .catch(err => {
        console.error(err);
        process.exitCode = 3;
      });
  }
}
