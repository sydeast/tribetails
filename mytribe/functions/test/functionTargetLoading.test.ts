import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1337: a cold start loads only the function it was started for.
 *
 * src/index.ts holds a FUNCTIONS table of `name: () => require('./module')`
 * loaders. With FUNCTION_TARGET naming one of them it exports that one;
 * otherwise (deploy-time discovery, the release tooling, tests, an unknown
 * target) it exports all of them, in the same order as before.
 *
 * The runtime half runs the BUILT lib/index.js in a child node process,
 * because that is the artifact Cloud Run and the emulator load and because
 * FUNCTION_TARGET is read once at module load. CI runs `npm run build` before
 * `npm run test:ci`; locally, build first.
 */
const ROOT = resolve(__dirname, '..');
const SRC_INDEX = resolve(ROOT, 'src/index.ts');
const LIB = resolve(ROOT, 'lib');
const LIB_INDEX = resolve(LIB, 'index.js');

/** The names in src/index.ts's FUNCTIONS table, in source order. */
function tableNames(): string[] {
  const text = readFileSync(SRC_INDEX, 'utf8');
  return [...text.matchAll(/^[ \t]*([A-Za-z_$][\w$]*): \(\) => require\('[^']+'\),$/gm)].map(
    (m) => m[1]!,
  );
}

interface Probe {
  keys: string[];
  hidden: string[];
  loaded: string[];
  endpoints: Record<string, unknown>;
  stderr: string;
}
/** Runs `script` in a fresh node with `env` laid over a clean environment. */
function runNode(script: string, env: Record<string, string>): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // v1 providers build a resource name inside their __endpoint getter and
      // throw without a project; scripts/function-targets.js sets the same.
      GCLOUD_PROJECT: 'auntieos-ttpc',
      FIREBASE_CONFIG: '{"projectId":"auntieos-ttpc"}',
      ...env,
    },
  });
  if (r.status !== 0) throw new Error(`node exited ${r.status}:\n${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}
/**
 * Requires lib/index.js in a fresh node and reports what it exported, what it
 * hid, which lib modules it loaded and what it wrote to stderr.
 */
function probe(env: Record<string, string>): Probe {
  const { stdout, stderr } = runNode(
    `
    const m = require(${JSON.stringify(LIB_INDEX)});
    const keys = Object.keys(m);
    const hidden = Object.getOwnPropertyNames(m).filter((k) => !keys.includes(k));
    const loaded = Object.keys(require.cache)
      .filter((f) => f.startsWith(${JSON.stringify(LIB + '/')}))
      .map((f) => f.slice(${JSON.stringify(LIB + '/')}.length));
    const endpoints = {};
    for (const k of keys) endpoints[k] = m[k] && m[k].__endpoint;
    process.stdout.write(JSON.stringify({ keys, hidden, loaded, endpoints }));
  `,
    env,
  );
  return { ...(JSON.parse(stdout) as Omit<Probe, 'stderr'>), stderr };
}
describe('#1337 the export set', () => {
  it('is exactly the 296 functions index.ts exported before #1337', () => {
    // The fixture is the sorted `Object.keys(require('lib/index.js'))` of main
    // at d8e44164, the commit before #1337. Adding or removing a deployed
    // function means editing this file in the same PR; a name that vanishes
    // from the table without that edit is a function a deploy would delete.
    const fixture = readFileSync(resolve(__dirname, 'fixtures/deployedFunctionNames.txt'), 'utf8')
      .split('\n')
      .filter(Boolean);
    const names = tableNames();
    expect(new Set(names).size, 'a name appears twice in FUNCTIONS').toBe(names.length);
    expect([...names].sort()).toEqual(fixture);
  });
});

describe('#1337 loading the built index', () => {
  beforeAll(() => {
    if (!existsSync(LIB_INDEX)) {
      throw new Error('lib/index.js is missing: run `npm run build` before this suite.');
    }
    if (statSync(LIB_INDEX).mtimeMs < statSync(SRC_INDEX).mtimeMs) {
      throw new Error('lib/index.js is older than src/index.ts: run `npm run build`.');
    }
  });

  it('exports every function, in table order, when FUNCTION_TARGET is unset', () => {
    const p = probe({});
    expect(p.keys).toEqual(tableNames());
    const noEndpoint = p.keys.filter((k) => !p.endpoints[k]);
    expect(noEndpoint, 'every export must be a deployable function').toEqual([]);
    // getIntegrationsHealth's whole-fleet loader rides along, invisible to
    // discovery and to every Object.keys/Object.entries walk.
    expect(p.hidden).toContain('__loadAllFunctions');
  });

  // One of each trigger kind the fleet deploys: callable, onRequest, blocking,
  // Firestore event, schedule, and the one gen1 auth trigger.
  const TARGETS = [
    'getMyKin',
    'health',
    'smtp2goEventWebhook',
    'beforeSignIn',
    'onInvoicesWrite',
    'invoiceRemindersCron',
    'onAuthUserCreate',
  ];

  it.each(TARGETS)(
    'exports only %s, with the same endpoint as discovery, when it is FUNCTION_TARGET',
    (name) => {
      const all = probe({});
      const one = probe({ FUNCTION_TARGET: name });
      expect(one.keys).toEqual([name]);
      // Same __endpoint means setGlobalOptions still ran first and every option
      // (region, memory, cpu, minInstances, secrets) still applies.
      expect(one.endpoints[name]).toEqual(all.endpoints[name]);
      expect(one.loaded.length).toBeLessThan(all.loaded.length);
    },
    30_000,
  );

  it('does not load other functions’ modules for a target', () => {
    const one = probe({ FUNCTION_TARGET: 'health' });
    expect(one.loaded).toContain('health/health.js');
    for (const other of [
      'portal/getMyKin.js',
      'portal/payInvoice.js',
      'admin/getIntegrationsHealth.js',
    ]) {
      expect(one.loaded).not.toContain(other);
    }
  });

  it('exports everything for discovery even if FUNCTION_TARGET leaks into it', () => {
    const p = probe({ FUNCTION_TARGET: 'health', FUNCTIONS_CONTROL_API: 'true' });
    expect(p.keys).toEqual(tableNames());
  });

  it('exports everything, and says so, for a FUNCTION_TARGET it does not know', () => {
    const p = probe({ FUNCTION_TARGET: 'notAFunction' });
    expect(p.keys).toEqual(tableNames());
    expect(p.stderr).toMatch(/FUNCTION_TARGET=notAFunction is not a function index\.ts exports/);
  });

  it('hands getIntegrationsHealth the whole fleet on an instance started for it', () => {
    const script = `
      const m = require(${JSON.stringify(LIB_INDEX)});
      const all = m.__loadAllFunctions();
      process.stdout.write(JSON.stringify({ own: Object.keys(m), all: Object.keys(all) }));
    `;
    const out = runNode(script, { FUNCTION_TARGET: 'getIntegrationsHealth' }).stdout;
    const { own, all } = JSON.parse(out) as { own: string[]; all: string[] };
    expect(own).toEqual(['getIntegrationsHealth']);
    expect(all).toEqual(tableNames());
  });
});
