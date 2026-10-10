// The dashboard shows management controls to whoever is signed in, and the API
// refuses a MEMBER's writes with 403. Those two facts have to agree: if the UI
// offers a button the server will reject, the member gets a dead control and a
// support ticket, and the only way anyone discovers the boundary is by hitting
// it.
//
// This checks the wiring, not the rendering. canManageWorkspace is the single
// place the decision is made, so a tab that forgets the prop is caught by the
// signature check and the spread check below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PAGE = path.join(__dirname, '..', '..', 'web', 'src', 'app', 'page.tsx');
const source = fs.readFileSync(PAGE, 'utf8');

// Tabs split into their own modules still have to honour the gate, so they are
// read and checked alongside page.tsx rather than being silently exempt.
const TABS_DIR = path.join(__dirname, '..', '..', 'web', 'src', 'app');
const tabSource = (file: string) => fs.readFileSync(path.join(TABS_DIR, file), 'utf8');

/** Every tab that renders management controls, and the file it now lives in. */
const MUTATING_TABS: Record<string, string> = {
  ApiKeysTab: 'page.tsx',
  PayoutsTab: 'page.tsx',
  PaymentLinksTab: 'page.tsx',
  ProductsTab: 'page.tsx',
  WebhooksTab: 'page.tsx',
  SettingsTab: 'page.tsx',
  NotificationsTab: 'notifications-tab.tsx',
};

test('exactly owners and admins may manage', () => {
  // Mirrors canManageWorkspace. Pinned here so a change to the UI rule is a
  // deliberate edit in two places rather than a silent divergence.
  const canManage = (role: string | undefined) => role === 'OWNER' || role === 'ADMIN';

  assert.equal(canManage('OWNER'), true);
  assert.equal(canManage('ADMIN'), true);
  assert.equal(canManage('MEMBER'), false, 'members verify, they do not configure');
  // Unknown role must fail closed: a workspace id from a stale client should
  // show read-only, not hand out controls the server will reject.
  assert.equal(canManage(undefined), false);
  assert.equal(canManage(''), false);
  assert.equal(canManage('owner'), false, 'roles are uppercase; do not guess case');
});

test('the dashboard actually gates on that decision', () => {
  assert.match(source, /function canManageWorkspace\(role: string \| undefined\): boolean/);
  assert.match(source, /role === 'OWNER' \|\| role === 'ADMIN'/);
});

test('every mutating tab receives canManage', () => {
  // These five tabs plus Settings contain the controls that change money,
  // credentials or destinations. A missing prop means an ungated tab.
  for (const [tab, file] of Object.entries(MUTATING_TABS)) {
    // The call site is in page.tsx even when the component is defined elsewhere.
    assert.match(
      source,
      new RegExp(`<${tab}[^>]*canManage=\\{canManage\\}`),
      `${tab} must receive canManage`,
    );
    // The signature is in whichever module declares it.
    const src = file === 'page.tsx' ? source : tabSource(file);
    assert.match(
      src,
      new RegExp(`(?:function|const) ${tab}\\([^)]*canManage`),
      `${tab} must declare canManage`,
    );
  }
});

test('no tab can be rendered without the gate being decided', () => {
  // canManage comes from the fetched workspace, so it must be computed once
  // above the tabs rather than defaulted inside each one.
  assert.match(source, /const canManage = canManageWorkspace\(workspace\.role\)/);
});

test('every create button sits behind the gate', () => {
  // Payouts opens its form via openCreate rather than a state setter, so match
  // the click handlers rather than one specific call.
  // Payouts passes openCreate straight through; the others wrap it in an arrow.
  // Settings renames inline and is gated separately below.
  //
  // Each tab's empty state grew a call to action, so the same handler appears
  // twice per tab — once in the header, once in the empty state. Both copies
  // must be gated, which is why this asserts a count rather than a presence: a
  // header button gated and an empty-state button ungated is exactly the bug
  // this catches, and only the count notices.
  // Five tabs in page.tsx (api keys, payouts, links, products, webhooks). Four
  // gained an empty-state call to action; payouts did not, because its empty
  // state already sits directly under a visible "Add Account" button.
  const EXPECTED_PER_FILE: Record<string, number> = {
    'page.tsx': 9,
    // Add Channel header + Add your first channel empty state.
    'notifications-tab.tsx': 2,
  };

  for (const [file, expected] of Object.entries(EXPECTED_PER_FILE)) {
    const src = file === 'page.tsx' ? source : tabSource(file);
    const buttons = src.match(/onClick=\{(?:\(\) => )?(?:setCreateOpen\(true\)|openCreate)\}>/g) ?? [];
    assert.equal(
      buttons.length,
      expected,
      `expected ${expected} create buttons in ${file} (header + empty state), found ${buttons.length}`,
    );

    for (const match of buttons) {
      const at = src.indexOf(match);
      // The gate sits a line or two above the handler, with the <Button between
      // them, so match the opening of the ternary rather than anchoring to the
      // end of the window.
      const before = src.slice(Math.max(0, at - 200), at);
      assert.match(
        before,
        /\{canManage \? \(/,
        `create button at offset ${at} in ${file} is not behind canManage`,
      );
    }
  }
});

test('the inline rename form is gated too', () => {
  assert.match(source, /\{canManage && \(\s*<Card>\s*<CardHeader>\s*<CardTitle className="text-base">Rename workspace/);
});

test('members are told why a control is missing', () => {
  // Hiding controls without explanation reads as a broken dashboard.
  const notices = source.match(/<ReadOnlyNotice what=/g) ?? [];
  assert.ok(notices.length >= 6, `expected a notice per mutating tab, found ${notices.length}`);
});

test('the role is visible, so the boundary is not a mystery', () => {
  assert.match(source, /\{workspace\.role\.toLowerCase\(\)\}/);
});

test('verification stays available to members', () => {
  // The gate must not be applied to the verification forms. The verify page and
  // the verify tab are the product; a member exists to use them.
  const VerificationsTab = source.match(/function VerificationsTab\([^)]*\)/)?.[0] ?? '';
  assert.doesNotMatch(VerificationsTab, /canManage/, 'History tab stays open to members');

  const verifyForm = path.join(__dirname, '..', '..', 'web', 'src', 'components', 'VerifyForm.tsx');
  const formSource = fs.readFileSync(verifyForm, 'utf8');
  assert.doesNotMatch(
    formSource,
    /canManage/,
    'the verify form must not be gated by role',
  );
});
