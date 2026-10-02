// #1138: NO UNIT TEST MAY REACH THE NETWORK.
//
// The Node-only mirror of auntieos-admin/test-network-guard.ts and
// mytribe/web/test-network-guard.ts, which carry the full history. In short:
// production logs showed unit tests calling deployed callables and Firestore
// whenever a spec left something unmocked, and the tests stayed green because
// the code under test swallowed the refusal. Here the risk is the Admin SDK and
// the third-party clients (Stripe, Twilio, Google APIs) reaching the real
// service from a spec that forgot to mock them.
//
// Two depths, because this suite runs in plain Node with no XMLHttpRequest:
//
//   `fetch`        names the method and the URL.
//   `net` sockets  the floor under everything else: `http`/`https`, gRPC (the
//                  Admin SDK's Firestore), the GCE metadata server the Admin SDK
//                  asks for credentials. Names host:port, with the hostname
//                  recovered from the DNS lookup that preceded it.
//
// Loopback stays allowed (127.0.0.1, ::1, localhost), so the emulator-backed
// suites keep working. A blocked request is recorded and the test fails in
// `afterEach` naming it, because the code under test usually catches the
// rejection and a throw alone would be swallowed.

import dns from 'node:dns';
import net from 'node:net';
import { afterAll, afterEach, expect } from 'vitest';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '::']);

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h.endsWith('.localhost') || h.startsWith('127.') || h.startsWith('::ffff:127.');
}

function describeUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  return String(input);
}

/** True when `url` leaves the machine. */
function leavesMachine(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false;
  return !isLoopbackHost(parsed.hostname);
}

type GuardState = { violations: string[]; hostByAddress: Map<string, string> };
const STATE_KEY = Symbol.for('tribetails.networkGuard.state');
const PATCHED_KEY = Symbol.for('tribetails.networkGuard.nodePatched');
const globals = globalThis as unknown as Record<symbol, unknown>;
globals[STATE_KEY] = { violations: [], hostByAddress: new Map() } satisfies GuardState;
const currentState = (): GuardState => globals[STATE_KEY] as GuardState;

const HOW_TO_FIX =
  `Tests must never leave the machine (#1138). This is almost always an SDK or client call the ` +
  `spec did not mock (the Admin SDK's Firestore or auth, Stripe, Twilio, a Google API), and ` +
  `without this guard it goes to the real service. Mock it the way the file already mocks its ` +
  `other dependencies, and assert on the mock instead.`;

function block(what: string): Error {
  let test = '(outside a test)';
  try {
    test = expect.getState().currentTestName ?? test;
  } catch {
    // No runner state outside a test body.
  }
  currentState().violations.push(`${what}  [during: ${test}]`);
  return new Error(`A unit test tried to reach the network: ${what}\n${HOW_TO_FIX}`);
}

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const url = describeUrl(input);
    if (leavesMachine(url)) {
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return Promise.reject(block(`${method} ${url} (fetch)`));
    }
    return realFetch(input, init);
  } as typeof fetch;
}

// Patched once per process; the patched functions read the CURRENT file's
// state through the global slot.
if (!globals[PATCHED_KEY]) {
  globals[PATCHED_KEY] = true;

  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    const cb = rest.pop() as (err: unknown, address: unknown, family?: number) => void;
    return (realLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest, (err: unknown, address: unknown, family?: number) => {
      if (!err) {
        const list = Array.isArray(address) ? address : [{ address }];
        for (const a of list as Array<{ address: unknown }>) {
          if (typeof a.address === 'string') currentState().hostByAddress.set(a.address, hostname);
        }
      }
      cb(err, address, family);
    });
  } as typeof dns.lookup;

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    // `net.connect`/`tls.connect` hand the method their already-normalized
    // arguments as ONE array, `[options, callback]`; direct callers pass them
    // spread. Both shapes, or `https.get` walks straight past this check.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    let host: string | undefined;
    let port: unknown;
    if (first && typeof first === 'object') {
      const opts = first as { host?: string; port?: unknown; path?: string | null };
      // `https` passes `path: null` for a TCP connection; only a string is a
      // Unix socket.
      if (typeof opts.path !== 'string') {
        host = opts.host ?? 'localhost';
        port = opts.port;
      }
    } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    }
    // A string first argument that is not a port is a Unix socket path: local.
    if (host !== undefined && !isLoopbackHost(host)) {
      const name = currentState().hostByAddress.get(host);
      const err = block(`connect ${name ? `${name} (${host})` : host}:${String(port)} (socket)`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

function takeViolations(): string[] {
  return currentState().violations.splice(0);
}

afterEach(() => {
  const seen = takeViolations();
  if (seen.length > 0) {
    throw new Error(`A unit test tried to reach the network:\n  ${seen.join('\n  ')}\n${HOW_TO_FIX}`);
  }
});

afterAll(() => {
  const seen = takeViolations();
  if (seen.length > 0) {
    throw new Error(`A unit test tried to reach the network after the file's last test:\n  ${seen.join('\n  ')}\n${HOW_TO_FIX}`);
  }
});
