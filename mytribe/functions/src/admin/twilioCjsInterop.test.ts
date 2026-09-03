import { describe, it, expect } from 'vitest';

/**
 * MYTRIBE-FUNCTIONS-F: `mintVoiceAccessToken` did `const { jwt } = await
 * import('twilio')` and threw "Cannot read properties of undefined (reading
 * 'AccessToken')" on every real call.
 *
 * twilio 6.x ships CommonJS (`"type": "commonjs"`, `main: ./lib`). When Node
 * dynamic-imports a CJS module it runs cjs-module-lexer over the source to
 * synthesise named exports, and for twilio that yields exactly `default` and
 * `module.exports`. `jwt`, `Twilio`, `validateRequest` and the rest hang off
 * the default. tsconfig sets `module: nodenext`, so `await import()` survives
 * compilation as a real dynamic import instead of being lowered to
 * `require()`, and the mistake typechecks cleanly and fails only in production.
 *
 * WHAT THIS FILE CANNOT DO, stated plainly so nobody trusts it too far: vitest
 * resolves modules through its own transform, not Node's ESM loader, and it
 * hands back the named exports Node withholds. So `mod.jwt` is defined here and
 * undefined in Cloud Functions, and no test run under vitest can reproduce the
 * original crash. Asserting `mod.jwt === undefined` would fail here while being
 * true in production, which is worse than not asserting it.
 *
 * What is left is still worth pinning: the path the handler actually takes has
 * to exist, and it is the path that breaks on a twilio major bump. The real
 * guard against a repeat is the mock in test/mintVoiceAccessToken.test.ts,
 * which now returns the module's true shape; it previously invented a named
 * `jwt` export and kept eight tests green over a handler that never worked.
 */
describe('twilio CJS/ESM interop', () => {
  it('reaches AccessToken and VoiceGrant through the default export', async () => {
    const { default: twilio } = await import('twilio');

    expect(twilio).toBeDefined();
    expect(typeof twilio.jwt).toBe('object');
    expect(typeof twilio.jwt.AccessToken).toBe('function');
    // VoiceGrant is a static on AccessToken, not a sibling of it. The handler
    // reads it as `AccessToken.VoiceGrant`.
    expect(typeof twilio.jwt.AccessToken.VoiceGrant).toBe('function');
  });

  it('keeps every dynamic twilio import in this package on the default', async () => {
    // engagementWebhooks.ts and twilioSignature.ts already destructure
    // `{ default: twilio }`. mintVoiceAccessToken.ts was the odd one out. Read
    // the sources rather than the compiled output so this fails on the change
    // that introduces the bug, not one deploy later.
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    // Resolved off cwd, not import.meta.url: this package compiles to CommonJS
    // (tsc rejects import.meta under that module target) and vitest runs with
    // cwd at the package root, which is what these paths are relative to.
    const files = [
      'src/admin/mintVoiceAccessToken.ts',
      'src/admin/engagementWebhooks.ts',
      'src/twilio/twilioSignature.ts',
    ];

    for (const file of files) {
      const source = await readFile(resolve(process.cwd(), file), 'utf8');
      for (const line of source.split('\n')) {
        if (!line.includes("import('twilio')")) continue;
        expect(line, `${file}: destructure the default, not a named export`).toContain(
          'default:',
        );
      }
    }
  });
});
