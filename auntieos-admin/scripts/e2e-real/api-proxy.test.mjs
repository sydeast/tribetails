import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_API_REWRITES, realServicesApiProxy } from './api-proxy.mjs';

/**
 * #1201. The real-services run must reach the admin's own signer and
 * generator through the same paths the app calls in production. These tests
 * pin the three things that make that true: the proxy exists only in that run,
 * it forwards to the emulator URL of the right function, and its table is the
 * one firebase.json rewrites, served by a codebase e2e.real.firebase.json
 * actually starts.
 */

const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ADMIN_DIR, rel), 'utf8'));

const RUN_ENV = {
  VITE_E2E_EMULATOR: '127.0.0.1',
  VITE_E2E_PROJECT_ID: 'demo-auntieos-e2e',
  VITE_E2E_FUNCTIONS_PORT: '5398',
};

/** The entry whose anchored-regex key matches [path], as vite would pick it. */
function entryFor(proxy, path) {
  const hits = Object.entries(proxy).filter(([key]) => new RegExp(key).test(path));
  expect(hits.length, `entries matching ${path}`).toBeLessThanOrEqual(1);
  return hits[0]?.[1];
}

describe('realServicesApiProxy', () => {
  it('is empty outside the real-services run', () => {
    expect(realServicesApiProxy({})).toEqual({});
    // The PR-time suite sets the emulator host but serves no functions.
    expect(realServicesApiProxy({ VITE_E2E_EMULATOR: '127.0.0.1' })).toEqual({});
    expect(realServicesApiProxy({ ...RUN_ENV, VITE_E2E_FUNCTIONS_PORT: '' })).toEqual({});
  });

  it('forwards each /api path to its function on the emulator, keeping the query', () => {
    const proxy = realServicesApiProxy(RUN_ENV);
    const sign = entryFor(proxy, '/api/cloudinary/sign-upload');
    expect(sign.target).toBe('http://127.0.0.1:5398');
    expect(sign.changeOrigin).toBe(true);
    expect(sign.rewrite('/api/cloudinary/sign-upload')).toBe('/demo-auntieos-e2e/us-central1/signCloudinaryUpload');
    const generate = entryFor(proxy, '/api/generate?x=1');
    expect(generate.rewrite('/api/generate?x=1')).toBe('/demo-auntieos-e2e/us-central1/generateAuntieCopy?x=1');
  });

  it('matches whole paths only', () => {
    const proxy = realServicesApiProxy(RUN_ENV);
    expect(entryFor(proxy, '/api/generated')).toBeUndefined();
    expect(entryFor(proxy, '/x/api/generate')).toBeUndefined();
    expect(entryFor(proxy, '/api/cloudinary/sign-upload/extra')).toBeUndefined();
  });

  it('refuses a project id that is not a demo- one', () => {
    expect(() => realServicesApiProxy({ ...RUN_ENV, VITE_E2E_PROJECT_ID: 'auntieos-ttpc' })).toThrow(/not a demo- project id/);
  });

  it('refuses a port that is not a number', () => {
    expect(() => realServicesApiProxy({ ...RUN_ENV, VITE_E2E_FUNCTIONS_PORT: '5398/evil' })).toThrow(/not a port number/);
  });
});

describe('parity with production hosting', () => {
  it('proxies exactly the function rewrites firebase.json declares', () => {
    const rewrites = readJson('firebase.json').hosting.rewrites.filter((r) => typeof r.function === 'string');
    expect(Object.fromEntries(rewrites.map((r) => [r.source, r.function]))).toEqual(ADMIN_API_REWRITES);
  });

  it('serves the codebase those functions live in, from the same source production deploys', () => {
    const real = readJson('e2e.real.firebase.json');
    const prod = readJson('web/firebase.json').functions.find((f) => f.codebase === 'default');
    const served = real.functions.find((f) => f.codebase === 'default');
    expect(served, 'e2e.real.firebase.json serves the default codebase').toBeDefined();
    // web/firebase.json's sources are relative to web/, this config's to auntieos-admin/.
    expect(served.source).toBe(join('web', prod.source));
    expect(real.functions.map((f) => f.codebase).sort()).toEqual(['default', 'mytribe']);
    expect(real.emulators.functions.port).toBe(Number(RUN_ENV.VITE_E2E_FUNCTIONS_PORT));
    const index = readFileSync(join(ADMIN_DIR, served.source, 'index.js'), 'utf8');
    for (const fn of Object.values(ADMIN_API_REWRITES)) {
      expect(index, `${fn} is exported by ${served.source}`).toMatch(new RegExp(`exports\\.${fn} = onRequest\\(`));
    }
  });
});
