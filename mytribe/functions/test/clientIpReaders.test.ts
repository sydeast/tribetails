import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #910: `clientIpOf` in `auth/loginSecurity.ts` is the ONLY code that decides
 * what the caller's address is.
 *
 * Behind the Functions Framework (Express `trust proxy` on), `rawRequest.ip`,
 * `req.ip` and the first `X-Forwarded-For` entry are all whatever the caller
 * wrote, so any other reader lets a rotating header reset a rate limit or put
 * an attacker-chosen address on an audit row. This scan fails the moment a
 * source file reads one of those directly. Comments are stripped first, so a
 * comment explaining why not to read them does not trip it.
 *
 * WHY A SCAN AND NOT AN ESLINT RULE. The readers span two packages with two
 * ESLint configs (`mytribe/functions` is TypeScript, `auntieos-admin/web/functions`
 * is plain CommonJS JavaScript with no lint script), and a repo-local rule would
 * have to be registered in both. One vitest file scans both trees, runs in the
 * suite CI already gates on, and names the offending file and pattern.
 */
const REPO = resolve(__dirname, '../../..');

/**
 * Every tree with a server that can see an `X-Forwarded-For` header. Both are
 * the ones #910 names. `auntieos-admin/twilio-service/functions` is Twilio-hosted,
 * not the Functions Framework, and reads no address today.
 */
const ROOTS = ['mytribe/functions/src', 'auntieos-admin/web/functions'];

/** Not our source: vendored code, build output, and test scaffolds that forge headers on purpose. */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'test', 'tests', '__tests__']);

const READERS: Array<[string, RegExp]> = [
  ['x-forwarded-for', /x-forwarded-for/i],
  ['x-real-ip', /x-real-ip/i],
  ['rawRequest.ip', /\brawRequest\s*\??\.\s*ip\b/],
  ['req.ip / request.ip', /\breq(?:uest)?\s*\??\.\s*ip\b/],
  ['remoteAddress', /\bremoteAddress\b/],
];

/** The files allowed to touch the address, each with the reason. */
const ALLOWED = new Map<string, string>([
  ['mytribe/functions/src/auth/loginSecurity.ts', 'home of clientIpOf, the one reader'],
  [
    'mytribe/functions/src/security/confirmSecureReset.ts',
    // An onRequest function, so it has no CallableRequest to pass. It hands the
    // socket address to clientIpOf as the documented no-header fallback and
    // never decides an address itself (#892, PR #903).
    'hands req.socket.remoteAddress to clientIpOf as its fallback',
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (/\.(ts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Drops block and line comments, keeping `://` inside URLs. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function readersIn(text: string): string[] {
  const code = stripComments(text);
  return READERS.filter(([, re]) => re.test(code)).map(([label]) => label);
}

describe('#910 only clientIpOf reads the client address', () => {
  it('the patterns catch every spelling they are for, and ignore comments', () => {
    expect(readersIn("const ip = req.rawRequest?.ip ?? 'unknown';")).toEqual(['rawRequest.ip']);
    expect(readersIn('const ip = req.rawRequest.ip;')).toEqual(['rawRequest.ip']);
    expect(readersIn('const ip = req.ip;')).toEqual(['req.ip / request.ip']);
    expect(readersIn('const ip = request?.ip;')).toEqual(['req.ip / request.ip']);
    expect(readersIn("const h = req.headers['X-Forwarded-For'];")).toEqual(['x-forwarded-for']);
    expect(readersIn("const h = req.headers['x-real-ip'];")).toEqual(['x-real-ip']);
    expect(readersIn('const a = req.socket.remoteAddress;')).toEqual(['remoteAddress']);
    expect(readersIn('// never read rawRequest.ip here\nconst a = 1;')).toEqual([]);
    expect(readersIn('/** not `x-forwarded-for` */\nconst a = 1;')).toEqual([]);
    expect(readersIn("const url = 'https://example.test/x'; const ip = req.ip;")).toEqual(['req.ip / request.ip']);
    expect(readersIn('const zip = req.zip; const tip = request.tipAmount;')).toEqual([]);
  });

  it('every root exists and holds source, so the scan cannot pass on an empty tree', () => {
    for (const root of ROOTS) {
      expect(sourceFiles(resolve(REPO, root)).length, `${root} holds source files`).toBeGreaterThan(0);
    }
  });

  it('the allowed reader really is a reader, so the patterns are not dead', () => {
    const text = readFileSync(resolve(REPO, 'mytribe/functions/src/auth/loginSecurity.ts'), 'utf8');
    expect(readersIn(text)).toContain('x-forwarded-for');
  });

  it('every allowed file is still there, so a stale entry cannot hide a new reader', () => {
    for (const rel of ALLOWED.keys()) {
      expect(() => statSync(resolve(REPO, rel)), `${rel} still exists`).not.toThrow();
    }
  });

  it('no other source file reads x-forwarded-for, x-real-ip, rawRequest.ip, req.ip or remoteAddress', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(resolve(REPO, root))) {
        scanned += 1;
        const rel = relative(REPO, file).split('\\').join('/');
        if (ALLOWED.has(rel)) continue;
        const found = readersIn(readFileSync(file, 'utf8'));
        if (found.length > 0) offenders.push(`${rel}: ${found.join(', ')}`);
      }
    }
    expect(scanned, 'the scan found source files').toBeGreaterThan(100);
    expect(offenders, 'use clientIpOf / checkIpRateLimit from auth/loginSecurity.ts').toEqual([]);
  });
});
