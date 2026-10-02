// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import https from 'node:https';
// #1138: `test-network-guard.ts` (loaded by test-setup.ts for every spec) is
// what keeps this suite off production. These pin that it intercepts each
// route out, under jsdom, which is where the component specs that leaked run.
// Each case drains the violation it provoked so the guard's own afterEach does
// not fail it for doing so on purpose.
//
// 192.0.2.1 is TEST-NET-1 (RFC 5737): an IP literal, so no DNS query is made,
// and an address nothing routes to, so a guard that failed open would hang
// rather than reach anyone.
type GuardState = { violations: string[] };
const state = () =>
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('tribetails.networkGuard.state')] as GuardState;
afterEach(() => {
  state().violations.splice(0);
});
describe('the unit-test network guard (#1138)', () => {
  it('refuses a fetch to a remote host, naming the method and URL (how httpsCallable posts)', async () => {
    await expect(fetch('https://192.0.2.1/getInvoiceLedger', { method: 'POST' })).rejects.toThrow(
      /reach the network: POST https:\/\/192\.0\.2\.1\/getInvoiceLedger/,
    );
    expect(state().violations).toHaveLength(1);
  });
  it('refuses an XMLHttpRequest to a remote host', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://192.0.2.1/channel');
    expect(() => xhr.send()).toThrow(/reach the network: POST https:\/\/192\.0\.2\.1\/channel/);
    expect(state().violations).toHaveLength(1);
  });
  it('refuses a raw socket, the route Firestore (gRPC) and Node http take', async () => {
    const err = await new Promise<Error>((resolve) => {
      https.get('https://192.0.2.1/', () => resolve(new Error('connected'))).on('error', resolve);
    });
    expect(err.message).toMatch(/reach the network: connect 192\.0\.2\.1:443/);
    expect(state().violations).toHaveLength(1);
  });
  it('leaves loopback alone', async () => {
    await fetch('http://127.0.0.1:9/').catch(() => undefined);
    expect(state().violations).toHaveLength(0);
  });
});
