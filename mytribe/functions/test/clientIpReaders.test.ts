import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * #910: `clientIpOf` in `auth/loginSecurity.ts` is the ONLY code that reads the
 * caller's address.
 *
 * Behind the Functions Framework (Express `trust proxy` on), `rawRequest.ip`,
 * `req.ip` and the first `X-Forwarded-For` entry are all whatever the caller
 * wrote, so any other reader lets a rotating header reset a rate limit or put
 * an attacker-chosen address on an audit row. This scan fails the moment a
 * source file reads one of those directly. Comments are stripped first, so a
 * comment explaining why not to read them does not trip it.
 *
 * Scope: every `.ts`/`.js` under `mytribe/functions/src`, and under
 * `auntieos-admin/web/functions/src` when that directory exists (it does not
 * on 2026-09-14; the admin functions live in `mytribe/functions`).
 */
const ROOTS = [
  resolve(__dirname, '../src'),
  resolve(__dirname, '../../../auntieos-admin/web/functions/src'),
];
const REPO = resolve(__dirname, '../../..');

const READERS: Array<[string, RegExp]> = [
  ['x-forwarded-for', /x-forwarded-for/i],
  ['x-real-ip', /x-real-ip/i],
  ['rawRequest.ip', /\brawRequest\s*\??\.\s*ip\b/],
  ['req.ip / request.ip', /\breq(?:uest)?\s*\??\.\s*ip\b/],
  ['remoteAddress', /\bremoteAddress\b/],
];

/** Files allowed to read the address, each with the reason. */
const ALLOWED = new Map<string, string>([
  ['mytribe/functions/src/auth/loginSecurity.ts', 'home of clientIpOf, the one reader'],
  // PR #903 (#892) moves confirmSecureReset onto clientIpOf and is still open
  // on 2026-09-14. Delete this entry when it merges.
  ['mytribe/functions/src/security/confirmSecureReset.ts', 'moved to clientIpOf by PR #903'],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
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

  it('the allowed reader really is a reader, so the scan is not reading an empty tree', () => {
    const text = readFileSync(resolve(REPO, 'mytribe/functions/src/auth/loginSecurity.ts'), 'utf8');
    expect(readersIn(text)).toContain('x-forwarded-for');
  });

  it('no other source file reads x-forwarded-for, x-real-ip, rawRequest.ip, req.ip or remoteAddress', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      if (!existsSync(root)) continue;
      for (const file of sourceFiles(root)) {
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
