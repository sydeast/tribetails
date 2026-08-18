import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The approval mechanism from #405, exercised the way CI exercises it.
 *
 * These tests exist because the gate was switched off for a reason no unit test could have
 * caught: it was correct about pixels and impossible to satisfy. An intended two-tab move on
 * #374 reported `REGRESSION: react/settings (0.612% changed, threshold 0%)`, and re-capturing
 * and committing the new golden changed nothing, because the CI step deleted it before the
 * comparison ran. So these assert the two halves of that deadlock rather than the diff
 * arithmetic, which was never the broken part:
 *
 *   1. A declared change passes, and says in the report who declared it and why.
 *   2. An UNdeclared change still fails, including one carrying an approval written for some
 *      other branch, which is what a merged entry looks like to every later pull request.
 *
 * baseline.mjs takes every path from its own location, so each case gets a throwaway copy of
 * the script in a temp tree with the goldens and captures laid out around it. `node_modules` is
 * symlinked in, because pngjs and pixelmatch resolve by walking up from the script.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/** A solid-colour PNG. Two different colours differ on 100% of their pixels; two of the same on none. */
function solidPng(path, { width = 40, height = 30, rgb = [0, 0, 0] } = {}) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
}

let tree;

/** Lays out `<tmp>/web/visual/baseline.mjs` plus `<tmp>/visual/{react,baselines/react}`. */
function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), 'baseline-approvals-'));
  mkdirSync(join(dir, 'web', 'visual'), { recursive: true });
  mkdirSync(join(dir, 'visual', 'react'), { recursive: true });
  mkdirSync(join(dir, 'visual', 'baselines', 'react'), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));
  cpSync(join(here, 'baseline.mjs'), join(dir, 'web', 'visual', 'baseline.mjs'));
  return dir;
}

function goldenPath(screen) {
  return join(tree, 'visual', 'baselines', 'react', `${screen}.png`);
}
function capturePath(screen) {
  return join(tree, 'visual', 'react', `${screen}.png`);
}

/** A screen whose capture matches its golden. */
function unchangedScreen(screen) {
  solidPng(goldenPath(screen), { rgb: [10, 20, 30] });
  solidPng(capturePath(screen), { rgb: [10, 20, 30] });
}

/** A screen whose capture differs from its golden on every pixel. */
function movedScreen(screen) {
  solidPng(goldenPath(screen), { rgb: [10, 20, 30] });
  solidPng(capturePath(screen), { rgb: [200, 40, 40] });
}

function writeApprovals(doc) {
  writeFileSync(join(tree, 'web', 'visual', 'approvals.json'), JSON.stringify(doc, null, 2));
}

function approval(overrides = {}) {
  return {
    screen: 'settings',
    branch: 'ui/settings-two-tabs',
    reason: 'Payments and Notifications become tabs inside Settings, so the tab strip gains two entries.',
    approvedBy: 'sydeast',
    date: '2026-08-18',
    ...overrides,
  };
}

/** Runs verify the way `npm run visual:react:verify` does, and never throws on a non-zero exit. */
function verify({ scope = '', env = {} } = {}) {
  try {
    const stdout = execFileSync('node', [join(tree, 'web', 'visual', 'baseline.mjs'), 'verify', 'react'], {
      encoding: 'utf8',
      env: { ...process.env, VISUAL_APPROVAL_SCOPE: scope, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function report() {
  return readFileSync(join(tree, 'visual', 'report', 'regression.md'), 'utf8');
}

beforeEach(() => {
  tree = makeTree();
});
afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe('verify with no approvals in play', () => {
  it('passes when every capture matches its golden', () => {
    unchangedScreen('settings');
    const run = verify();
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('1 ok, 0 regression(s), 0 approved');
  });

  it('fails an undeclared change, which is the behaviour worth keeping', () => {
    movedScreen('settings');
    const run = verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('REGRESSION: react/settings');
  });

  it('fails a screen the branch deleted, so a removal has to be said out loud', () => {
    solidPng(goldenPath('settings'), { rgb: [10, 20, 30] });
    const run = verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('missing-capture: react/settings');
  });
});

describe('an approval scoped to the branch being verified', () => {
  beforeEach(() => {
    movedScreen('settings');
    unchangedScreen('inbox');
    writeApprovals({ react: [approval()] });
  });

  it('clears the change and names who approved it and why', () => {
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('APPROVED: react/settings');
    expect(run.stdout).toContain('by sydeast on 2026-08-18');
    expect(report()).toContain('## Declared intended changes');
    expect(report()).toContain('| react | settings | 100 | sydeast | 2026-08-18 |');
  });

  it('still writes the diff overlay, because a reviewer approves a picture', () => {
    verify({ scope: 'ui/settings-two-tabs' });
    expect(report()).toContain('[react-settings.png](regress/react-settings.png)');
    expect(() => readFileSync(join(tree, 'visual', 'report', 'regress', 'react-settings.png'))).not.toThrow();
  });

  it('approves only the screen it names, leaving every other screen gated', () => {
    movedScreen('inbox');
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('REGRESSION: react/inbox');
    expect(run.stdout).toContain('APPROVED: react/settings');
  });

  it('covers a deliberate removal of the screen it names', () => {
    rmSync(capturePath('settings'));
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('APPROVED: react/settings');
    expect(run.stdout).not.toContain('missing-capture');
  });
});

describe('an approval written for some other branch', () => {
  // This is what every merged approval looks like to a later pull request. If it were live, the
  // first PR to approve `settings` would approve it forever, for everybody, silently.
  it('does not clear the change', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval()] });
    const run = verify({ scope: 'ui/some-later-branch' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('REGRESSION: react/settings');
    expect(run.stdout).toContain('0 live of 1 declared');
  });

  it('does not clear the change when there is no scope at all', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval()] });
    const run = verify({ scope: '' });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('REGRESSION: react/settings');
  });
});

describe('a declaration nobody can act on stops the run rather than approving nothing quietly', () => {
  it('rejects an unknown field, the misspelling that would otherwise be inert', () => {
    movedScreen('settings');
    const { approvedBy, ...rest } = approval();
    writeApprovals({ react: [{ ...rest, approvedBy, aprovedBy: 'sydeast' }] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('unknown field "aprovedBy"');
  });

  it('rejects a missing reason', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval({ reason: '' })] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('missing a non-empty "reason"');
  });

  it('rejects a reason too short to mean anything', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval({ reason: 'wip' })] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('at least 10 characters');
  });

  it('rejects a glob, so "approve everything" cannot be written down', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval({ screen: '*' })] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('not a single screen name');
  });

  it('rejects a screen name the surface does not have', () => {
    movedScreen('settings');
    writeApprovals({ react: [approval({ screen: 'setings' })] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('react/setings');
  });

  it('rejects a surface that is not a surface', () => {
    movedScreen('settings');
    writeApprovals({ raect: [approval()] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('"raect" is not a surface');
  });

  it('tolerates a missing file, which is the normal state of a branch that changed nothing', () => {
    unchangedScreen('settings');
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(0);
  });
});

describe('an approval that matched nothing', () => {
  it('is reported and does not fail the run', () => {
    unchangedScreen('settings');
    writeApprovals({ react: [approval()] });
    const run = verify({ scope: 'ui/settings-two-tabs' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('STALE APPROVAL: react/settings');
    expect(report()).toContain('Stale approvals');
  });
});

describe('VISUAL_BASELINE_DIR', () => {
  // The CI job used to `rm -rf` the checkout's goldens to stand the base capture up in their
  // place, which is why a branch physically could not commit a golden the job would honour.
  it('reads goldens from somewhere else and leaves the committed ones untouched', () => {
    const elsewhere = join(tree, 'base-goldens');
    mkdirSync(join(elsewhere, 'react'), { recursive: true });
    solidPng(join(elsewhere, 'react', 'settings.png'), { rgb: [200, 40, 40] });
    // The committed golden disagrees with the capture; the redirected one agrees with it.
    movedScreen('settings');
    const before = readFileSync(goldenPath('settings'));

    const run = verify({ env: { VISUAL_BASELINE_DIR: elsewhere } });
    expect(run.code).toBe(0);
    expect(readFileSync(goldenPath('settings')).equals(before)).toBe(true);
  });
});
