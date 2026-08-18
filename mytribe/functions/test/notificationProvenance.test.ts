import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  NEVER_FIRES,
  NOTIFICATION_EMITTERS,
  RECIPIENT_SENTENCES,
  UNGATED_SENDS,
  whoReceives,
} from '../src/notifications/provenance';
import {
  NOTIFICATION_CATALOG,
  getNotificationDef,
  legacyKeysFor,
} from '../src/notifications/catalog';

/**
 * The drift guard for `notifications/provenance.ts`, modelled on the
 * TEMPLATE_FIELDS / seeds guard in enrichTemplateData.test.ts.
 *
 * A hand-authored map of "what fires this notification" is worth nothing the
 * moment someone adds an emitter without updating it, and #396 exists precisely
 * because nobody could tell whether the documentation matched the code. So the
 * check runs in BOTH directions and against the real source tree: every claim
 * must be findable in a file that exists, and every file that dispatches a
 * notification must have made a claim.
 */

const FUNCTIONS_ROOT = join(__dirname, '..');
const SRC = join(FUNCTIONS_ROOT, 'src');

/** Every .ts file under src/, repo-relative to mytribe/functions/. */
function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      allSourceFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(relative(FUNCTIONS_ROOT, full).split('\\').join('/'));
    }
  }
  return out;
}

const SOURCE_FILES = allSourceFiles(SRC);

function read(relPath: string): string {
  return readFileSync(join(FUNCTIONS_ROOT, relPath), 'utf8');
}

/** Files that actually call [fnName], excluding the ones that define/wrap it. */
function callersOf(fnName: string, exclude: readonly string[]): string[] {
  return SOURCE_FILES.filter(
    (f) => !exclude.includes(f) && read(f).includes(`${fnName}(`),
  ).sort();
}

describe('provenance covers the catalog exactly once', () => {
  const catalogKeys = Object.keys(NOTIFICATION_CATALOG).sort();

  it('every catalog key is either emitted or explicitly listed as never firing', () => {
    const documented = [...Object.keys(NOTIFICATION_EMITTERS), ...NEVER_FIRES].sort();
    expect(documented).toEqual(catalogKeys);
  });

  it('no key is both emitted and listed as never firing', () => {
    const both = NEVER_FIRES.filter((k) => k in NOTIFICATION_EMITTERS);
    expect(both).toEqual([]);
  });

  it('every emitted key names at least one call site', () => {
    for (const [key, emitters] of Object.entries(NOTIFICATION_EMITTERS)) {
      expect(emitters.length, `${key} has no emitters`).toBeGreaterThan(0);
    }
  });
});

describe('every claimed source file exists and mentions its key', () => {
  for (const [key, emitters] of Object.entries(NOTIFICATION_EMITTERS)) {
    for (const emitter of emitters) {
      it(`${key} <- ${emitter.source}`, () => {
        expect(
          existsSync(join(FUNCTIONS_ROOT, emitter.source)),
          `${emitter.source} does not exist`,
        ).toBe(true);
        // The key literal must appear in the file that claims to dispatch it.
        // Dynamic call sites (`key: key as never`) still name every key they
        // can send in a nearby literal, table or union type, which is exactly
        // the property that makes this check work on them too.
        //
        // A RETIRED KEY COUNTS. `dispatchVisitNotification` sends
        // `kincare.report.sent`, which the alias table canonicalizes onto
        // `kintale.published`; the emitter is real and the canonical literal is
        // nowhere in that file. Accepting either the canonical key or any of
        // its retired names is what lets the guard see through an alias instead
        // of forcing the map to lie about where the trigger lives.
        const names = [key, ...legacyKeysFor(key)];
        const src = read(emitter.source);
        expect(
          names.some((n) => src.includes(`'${n}'`)),
          `${emitter.source} mentions none of ${names.join(', ')}`,
        ).toBe(true);
      });
    }
  }
});

describe('no emitter can land undocumented', () => {
  it('the files calling enqueueNotification are exactly the files provenance names', () => {
    // dispatcher.ts DEFINES enqueueNotification rather than calling it.
    const actual = callersOf('enqueueNotification', ['src/notifications/dispatcher.ts']);
    const claimed = [
      ...new Set(
        Object.values(NOTIFICATION_EMITTERS).flatMap((list) => list.map((e) => e.source)),
      ),
    ].sort();
    expect(claimed).toEqual(actual);
  });

  it('the files calling sendFromTemplate are exactly the files UNGATED_SENDS names', () => {
    // sendFromTemplate.ts defines it; emailChannel.ts is the GATED path (it is
    // how a catalog notification's email is rendered), so it is not an ungated
    // send and must not appear in the list.
    const actual = callersOf('sendFromTemplate', [
      'src/lib/sendFromTemplate.ts',
      'src/notifications/senders/emailChannel.ts',
    ]);
    const claimed = [...new Set(UNGATED_SENDS.map((u) => u.source))].sort();
    expect(claimed).toEqual(actual);
  });

  it('every ungated send names a template its source really asks for', () => {
    for (const send of UNGATED_SENDS) {
      expect(existsSync(join(FUNCTIONS_ROOT, send.source))).toBe(true);
      expect(
        read(send.source).includes(`'${send.templateId}'`),
        `${send.source} never asks for '${send.templateId}'`,
      ).toBe(true);
    }
  });
});

describe('quote.accepted and quote.denied really do not fire', () => {
  // The issue claims these two rows are dead. Verified rather than trusted:
  // nothing may pass either key to enqueueNotification anywhere in src/.
  for (const key of ['quote.accepted', 'quote.denied']) {
    it(`${key} is passed to no enqueueNotification call`, () => {
      const dispatching = SOURCE_FILES.filter((f) => {
        const src = read(f);
        return src.includes('enqueueNotification(') && new RegExp(`key:\\s*'${key.replace('.', '\\.')}'`).test(src);
      });
      expect(dispatching).toEqual([]);
    });
    it(`${key} is listed in NEVER_FIRES`, () => {
      expect(NEVER_FIRES).toContain(key);
    });
  }
});

describe('whoReceives renders sentences, not enums', () => {
  it('covers every resolver the catalog actually uses', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      expect(RECIPIENT_SENTENCES[def.recipientResolver]).toBeTruthy();
      if (def.secondaryResolver) {
        expect(RECIPIENT_SENTENCES[def.secondaryResolver]).toBeTruthy();
      }
    }
  });

  it('returns two sentences for a key with a secondary resolver', () => {
    // invoice.new fans out to the household AND the office; reading only the
    // first sentence is how someone concludes it stays inside the household.
    const def = getNotificationDef('invoice.new');
    expect(def.secondaryResolver).toBeTruthy();
    expect(whoReceives(def)).toHaveLength(2);
  });

  it('returns one sentence for a single-resolver key', () => {
    expect(whoReceives(getNotificationDef('kincare.auntie.arrived'))).toHaveLength(1);
  });

  it('never returns a bare resolver name', () => {
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      for (const sentence of whoReceives(def)) {
        expect(sentence).not.toBe(def.recipientResolver);
        expect(sentence.length).toBeGreaterThan(20);
      }
    }
  });
});
