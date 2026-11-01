import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ExtractionError,
  extractAll,
  extractFunctionDeclaration,
  extractGlobalFragments,
  extractIndexExports,
  extractNamedConstants,
} from './extractSource';
import { resolveAll } from './resolveAll';

function sourceFile(text: string, fileName = 'fixture.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('extractGlobalFragments', () => {
  it('reads setGlobalOptions({...}) as prop fragments', () => {
    const src = sourceFile(`setGlobalOptions({ cpu: 1, memory: '256MiB', maxInstances: 20 });`);
    const fragments = extractGlobalFragments(src);
    expect(fragments).toEqual([
      { kind: 'prop', key: 'cpu', value: 1 },
      { kind: 'prop', key: 'memory', value: '256MiB' },
      { kind: 'prop', key: 'maxInstances', value: 20 },
    ]);
  });

  it('throws when no setGlobalOptions call exists', () => {
    const src = sourceFile(`export const x = 1;`);
    expect(() => extractGlobalFragments(src)).toThrow(/no setGlobalOptions/);
  });

  it('throws when setGlobalOptions is called with a non-literal argument', () => {
    const src = sourceFile(`setGlobalOptions(someVariable);`);
    expect(() => extractGlobalFragments(src)).toThrow(/object literal/);
  });
});

describe('extractNamedConstants', () => {
  it('reads exported const object literals, including "as const"', () => {
    const src = sourceFile(`
      export const FULL_CPU = { cpu: 1, maxInstances: 10 } as const;
      export const SERIAL = { cpu: 0.25, maxInstances: 2 } as const;
      const NOT_EXPORTED = { cpu: 99 };
      export const NOT_AN_OBJECT = 42;
    `);
    const constants = extractNamedConstants(src);
    expect(constants).toEqual({
      FULL_CPU: { cpu: 1, maxInstances: 10 },
      SERIAL: { cpu: 0.25, maxInstances: 2 },
    });
  });
});

describe('extractIndexExports', () => {
  it('reads export { a, b } from "./module" in source order', () => {
    const src = sourceFile(`
      export { health } from './health/health';
      export {
        getMyHome,
        getMyAccess,
      } from './portal/getMyAccess';
    `);
    const exports = extractIndexExports(src);
    expect(exports.map((e) => e.name)).toEqual(['health', 'getMyHome', 'getMyAccess']);
    expect(exports[1].modulePath).toBe('./portal/getMyAccess');
  });

  it('ignores export declarations with no module specifier', () => {
    const src = sourceFile(`
      export { health } from './health/health';
      export type { Foo } from './types';
      const local = 1;
      export { local };
    `);
    const exports = extractIndexExports(src);
    expect(exports.map((e) => e.name)).toEqual(['health']);
  });
});

describe('extractFunctionDeclaration', () => {
  it('resolves a plain onCall with an inline options object', () => {
    const src = sourceFile(`
      export const getBreeds = onCall(
        { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
        getBreedsHandler,
      );
    `);
    const decl = extractFunctionDeclaration(
      src,
      'getBreeds',
      'mytribe/functions/src/portal/getBreeds.ts',
    );
    expect(decl.trigger).toBe('onCall');
    expect(decl.generation).toBe('gen2');
    expect(decl.fragments).toEqual([{ kind: 'prop', key: 'region', value: 'us-central1' }]);
  });

  it('resolves an onCall with no options object at all (single-arg form)', () => {
    const src = sourceFile(`export const health = onCall(healthHandler);`);
    const decl = extractFunctionDeclaration(src, 'health', 'x.ts');
    expect(decl.fragments).toEqual([]);
  });

  it('resolves a literal-before-spread options object, preserving source order', () => {
    // The exact shape of src/auth/loginSecurity.ts:328.
    const src = sourceFile(`
      export const beforeSignIn = beforeUserSignedIn(
        { region: 'us-central1', secrets: ['SENTRY_DSN'], minInstances: 1, ...FULL_CPU },
        handler,
      );
    `);
    const decl = extractFunctionDeclaration(src, 'beforeSignIn', 'x.ts');
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'prop', key: 'minInstances', value: 1 },
      { kind: 'spread', constant: 'FULL_CPU' },
    ]);
  });

  it('resolves onDocumentCreated, which always requires an options object', () => {
    const src = sourceFile(`
      export const onKinTaleCreate = onDocumentCreated(
        { document: 'kin_care_reports/{reportId}', region: 'us-central1', secrets: ['SENTRY_DSN'] },
        wrapTrigger('onKinTaleCreate', onKinTaleCreateHandler),
      );
    `);
    const decl = extractFunctionDeclaration(src, 'onKinTaleCreate', 'x.ts');
    expect(decl.trigger).toBe('onDocumentCreated');
    expect(decl.fragments).toEqual([{ kind: 'prop', key: 'region', value: 'us-central1' }]);
  });

  it('resolves onSchedule with the cron string as the first argument', () => {
    const src = sourceFile(`
      export const rotateOldFcmTokens = onSchedule(
        'every 24 hours',
        { region: 'us-central1', ...SERIAL },
        handler,
      );
    `);
    const decl = extractFunctionDeclaration(src, 'rotateOldFcmTokens', 'x.ts');
    expect(decl.trigger).toBe('onSchedule');
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'spread', constant: 'SERIAL' },
    ]);
  });

  it('resolves onSchedule with no options object (schedule, handler)', () => {
    const src = sourceFile(
      `export const aiBatchPollCron = onSchedule('every 5 minutes', handler);`,
    );
    const decl = extractFunctionDeclaration(src, 'aiBatchPollCron', 'x.ts');
    expect(decl.fragments).toEqual([]);
  });

  it('resolves onSchedule with the options object as the first argument (schedule folded in) — the real shape every onSchedule call site in this repo uses', () => {
    // The exact shape of src/scheduled/kincareReminderCron.ts:99 and every
    // other scheduled function: `schedule` lives inside the options object
    // itself, so the call is 2-arg (opts, handler), not 3-arg
    // (schedule, opts, handler).
    const src = sourceFile(`
      export const kincareReminderCron = onSchedule(
        { schedule: 'every 60 minutes', region: 'us-central1', ...FULL_CPU_SERIAL },
        handler,
      );
    `);
    const decl = extractFunctionDeclaration(src, 'kincareReminderCron', 'x.ts');
    expect(decl.trigger).toBe('onSchedule');
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'spread', constant: 'FULL_CPU_SERIAL' },
    ]);
  });

  it('throws (fails loudly) on an onSchedule call with an unrecognized argument shape', () => {
    // Neither a string-first (schedule, handler) call nor an object/const
    // first argument — e.g. a computed expression as the sole options
    // source. This must never resolve to zero fragments silently.
    const src = sourceFile(`
      export const mystery = onSchedule(computeSchedule(), handler);
    `);
    expect(() => extractFunctionDeclaration(src, 'mystery', 'x.ts')).toThrow(ExtractionError);
    expect(() => extractFunctionDeclaration(src, 'mystery', 'x.ts')).toThrow(
      /unrecognized argument shape/,
    );
  });

  it('resolves the one v1 auth.user().onCreate trigger as gen1 with zero fragments', () => {
    const src = sourceFile(`
      export const onAuthUserCreate = auth.user().onCreate(
        wrapTrigger('onAuthUserCreate', async (user) => { /* ... */ }),
      );
    `);
    const decl = extractFunctionDeclaration(src, 'onAuthUserCreate', 'x.ts');
    expect(decl.generation).toBe('gen1');
    expect(decl.fragments).toEqual([]);
  });

  it('resolves an options identifier that points at a local const object literal', () => {
    const src = sourceFile(`
      const OPTS = { region: 'us-central1', minInstances: 1 };
      export const getMyHome = onCall(OPTS, handler);
    `);
    const decl = extractFunctionDeclaration(src, 'getMyHome', 'x.ts');
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'prop', key: 'minInstances', value: 1 },
    ]);
  });

  it('throws (fails loudly) on an unrecognized trigger factory', () => {
    const src = sourceFile(`export const mystery = someWrapper(handler);`);
    expect(() => extractFunctionDeclaration(src, 'mystery', 'x.ts')).toThrow(ExtractionError);
    expect(() => extractFunctionDeclaration(src, 'mystery', 'x.ts')).toThrow(
      /unrecognized trigger factory/,
    );
  });

  it('throws when a runtime-key value is not a static literal', () => {
    const src = sourceFile(`
      export const flaky = onCall({ region: 'us-central1', minInstances: computeIt() }, handler);
    `);
    expect(() => extractFunctionDeclaration(src, 'flaky', 'x.ts')).toThrow(/not a static literal/);
  });

  it('throws when the requested export name is not found in the module', () => {
    const src = sourceFile(`export const somethingElse = onCall(handler);`);
    expect(() => extractFunctionDeclaration(src, 'missingExport', 'x.ts')).toThrow(
      /no "export const missingExport/,
    );
  });
});

describe('file-local const spreads (#1388)', () => {
  it('inlines a file-local `as const` spread in source order (the emailFrameSettings.ts shape)', () => {
    const src = sourceFile(`
      const OPTS = { region: 'us-central1', cors: TRIBETAILS_CORS } as const;
      export const getEmailFrame = onCall({ ...OPTS, secrets: ['SENTRY_DSN'] }, handler);
    `);
    const decl = extractFunctionDeclaration(src, 'getEmailFrame', 'x.ts');
    expect(decl.fragments).toEqual([{ kind: 'prop', key: 'region', value: 'us-central1' }]);
  });

  it('keeps JS override order around a local spread, and still defers named constants', () => {
    const src = sourceFile(`
      const BASE = { memory: '512MiB', ...FULL_CPU, region: 'us-east1' };
      export const f = onCall({ region: 'us-central1', ...BASE, minInstances: 1 }, handler);
    `);
    const decl = extractFunctionDeclaration(src, 'f', 'x.ts');
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'region', value: 'us-central1' },
      { kind: 'prop', key: 'memory', value: '512MiB' },
      { kind: 'spread', constant: 'FULL_CPU' },
      { kind: 'prop', key: 'region', value: 'us-east1' },
      { kind: 'prop', key: 'minInstances', value: 1 },
    ]);
  });

  it('a file-local const shadows a same-named import, as JS scoping does', () => {
    const src = sourceFile(`
      import { FULL_CPU } from '../lib/runtimeOptions';
      const FULL_CPU = { cpu: 2 };
      export const f = onCall({ ...FULL_CPU }, handler);
    `);
    const decl = extractFunctionDeclaration(src, 'f', 'x.ts');
    expect(decl.fragments).toEqual([{ kind: 'prop', key: 'cpu', value: 2 }]);
  });

  it('fails loudly, naming the file and construct, when the local const is not an object literal', () => {
    const src = sourceFile(
      `
      const OPTS = buildOpts();
      export const f = onCall({ ...OPTS }, handler);
    `,
      'src/admin/fixture.ts',
    );
    expect(() => extractFunctionDeclaration(src, 'f', 'src/admin/fixture.ts')).toThrow(
      ExtractionError,
    );
    expect(() => extractFunctionDeclaration(src, 'f', 'src/admin/fixture.ts')).toThrow(
      /src\/admin\/fixture\.ts:f: spreads file-local const "OPTS" \(src\/admin\/fixture\.ts:2\), whose initializer is not an object literal \(buildOpts\(\)\)/,
    );
  });

  it('fails loudly on a local const that spreads itself', () => {
    const src = sourceFile(`
      const A = { ...B };
      const B = { ...A };
      export const f = onCall({ ...A }, handler);
    `);
    expect(() => extractFunctionDeclaration(src, 'f', 'x.ts')).toThrow(
      /const "A" spreads itself \(A -> B -> A\)/,
    );
  });
});

describe('imported const spreads (#1388)', () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'rtopts-spread-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it('follows a relative import to the exporting module and inlines its const (the HOURLY_TICK shape)', () => {
    const dir = fixtureDir({
      'schedule.ts': `
        const BASE = { timeoutSeconds: 300 } as const;
        export const TICK = { schedule: '0 * * * *', ...BASE } as const;
      `,
    });
    const file = join(dir, 'cron.ts');
    const src = sourceFile(
      `
      import { TICK as HOURLY } from './schedule';
      export const cron = onSchedule({ ...HOURLY, memory: '512MiB' }, handler);
    `,
      file,
    );
    const decl = extractFunctionDeclaration(src, 'cron', 'cron.ts', file);
    expect(decl.fragments).toEqual([
      { kind: 'prop', key: 'timeoutSeconds', value: 300 },
      { kind: 'prop', key: 'memory', value: '512MiB' },
    ]);
  });

  it('fails loudly when the imported module has no such const', () => {
    const dir = fixtureDir({ 'schedule.ts': `export function TICK() {}` });
    const file = join(dir, 'cron.ts');
    const src = sourceFile(
      `
      import { TICK } from './schedule';
      export const cron = onSchedule({ ...TICK }, handler);
    `,
      file,
    );
    expect(() => extractFunctionDeclaration(src, 'cron', 'cron.ts', file)).toThrow(
      /declares no top-level const "TICK"/,
    );
  });

  it('fails loudly on a spread imported from a package', () => {
    const src = sourceFile(`
      import { OPTS } from 'some-package';
      export const f = onCall({ ...OPTS }, handler);
    `);
    expect(() => extractFunctionDeclaration(src, 'f', 'x.ts')).toThrow(
      /imported from package "some-package"/,
    );
  });
});

describe('extractAll / resolveAll over the real src/index.ts (#1388)', () => {
  // The guard the issue asks for: the next unsupported options shape fails
  // CI here instead of the operator's `runtime-options:diff` mid-release.
  it('extracts every exported function with zero errors', () => {
    const { declarations, errors } = extractAll();
    expect(errors).toEqual([]);
    expect(declarations.length).toBeGreaterThan(200);
  });

  it('resolves every declaration to a concrete shape with zero errors', () => {
    const { declarations, errors } = resolveAll();
    expect(errors).toEqual([]);
    const emailFrame = declarations.filter((d) =>
      ['getEmailFrame', 'saveEmailFrame', 'previewEmailFrame'].includes(d.name),
    );
    expect(emailFrame.map((d) => d.name).sort()).toEqual([
      'getEmailFrame',
      'previewEmailFrame',
      'saveEmailFrame',
    ]);
    for (const d of emailFrame) expect(d.shape.region).toBe('us-central1');
  });
});
