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
  RETIRED_NOTIFICATION_KEYS,
  getNotificationDef,
  legacyKeysFor,
} from '../src/notifications/catalog';
import { DIRECT_SEND_KEYS } from '../src/notifications/catalogKeys';

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
  /**
   * A catalog key reaches a recipient by one of exactly two routes: the
   * dispatcher (`enqueueNotification`), or a caller that resolves the gate
   * itself with `resolveChannels` and then sends. `broadcastMessage` is the
   * only one of the second kind, added by #424, and it is a real dispatch path
   * that the operator can see in the gate, so the guard admits both shapes
   * rather than pretending broadcasts have no trigger.
   */
  const DISPATCH_CALLS = ['enqueueNotification', 'resolveChannels'];

  function dispatchingFiles(): string[] {
    return SOURCE_FILES.filter((f) => {
      // These DEFINE the two entry points rather than calling them, and prefs.ts
      // is where resolveChannels lives.
      if (
        f === 'src/notifications/dispatcher.ts' ||
        f === 'src/notifications/prefs.ts' ||
        f === 'src/admin/notificationOverrides.ts'
      ) {
        return false;
      }
      // The one file that resolves the gate to COUNT rather than to send.
      // `countMarketingReach` runs `resolveChannels` over a prospective
      // marketing audience so the Marketing blasts screen can show a real "who
      // this reaches" figure before anything is scheduled. It writes nothing,
      // enqueues nothing, and delivers nothing, so naming it in provenance
      // would claim a trigger that does not exist. The emitter for all three
      // marketing keys is `scheduleMarketingBlast.ts`, which is documented and
      // which is where the key literals live.
      if (f === 'src/admin/marketingAudience.ts') return false;
      const src = read(f);
      return DISPATCH_CALLS.some((fn) => src.includes(`${fn}(`));
    }).sort();
  }

  it('every file that dispatches a catalog key is named by provenance', () => {
    const claimed = new Set(
      Object.values(NOTIFICATION_EMITTERS).flatMap((list) => list.map((e) => e.source)),
    );
    const undocumented = dispatchingFiles().filter((f) => !claimed.has(f));
    expect(undocumented).toEqual([]);
  });

  it('every file provenance names really does dispatch something', () => {
    // The inverse failure: a source path that is stale, renamed, or invented.
    const dispatching = new Set(dispatchingFiles());
    const claimed = [
      ...new Set(
        Object.values(NOTIFICATION_EMITTERS).flatMap((list) => list.map((e) => e.source)),
      ),
    ].sort();
    expect(claimed.filter((f) => !dispatching.has(f))).toEqual([]);
  });

  /**
   * The ungated list does NOT keep its own copy of the key set. `DIRECT_SEND_KEYS`
   * (notifications/catalogKeys.ts, #423) is the one honest list of keys handed
   * straight to `sendFromTemplate`, and `catalogKeys.test.ts` already greps the
   * source for every such literal. Duplicating that grep here would be a second
   * list to forget; what this checks instead is that the gate's footnote covers
   * exactly that list and adds a real trigger sentence for each entry.
   */
  it('UNGATED_SENDS covers exactly the direct-send keys, and nothing else', () => {
    expect(UNGATED_SENDS.map((u) => u.templateId).sort()).toEqual(
      DIRECT_SEND_KEYS.map((d) => d.key).slice().sort(),
    );
  });

  it('every ungated send says what fires it, and names a file that really sends it', () => {
    for (const send of UNGATED_SENDS) {
      expect(send.trigger, `${send.templateId} has no trigger`).toContain(' ');
      expect(existsSync(join(FUNCTIONS_ROOT, send.source)), `${send.source} missing`).toBe(true);
      expect(
        read(send.source).includes(`'${send.templateId}'`),
        `${send.source} never asks for '${send.templateId}'`,
      ).toBe(true);
    }
  });

  /**
   * #424 gave broadcasts a real catalog row, so the gate governs them. A
   * broadcast listed as ungated would tell the operator the gate's toggles do
   * not apply to the one message type they send by hand, which is backwards.
   */
  it('does not list broadcast.message as ungated, because it has a catalog row now', () => {
    expect(UNGATED_SENDS.map((u) => u.templateId)).not.toContain('broadcast.message');
    expect(NOTIFICATION_EMITTERS['broadcast.message']).toBeTruthy();
  });
});

describe('quote.accepted and quote.denied fire from the portal now', () => {
  /**
   * These two rows were dead for the whole life of the catalog, and this block
   * used to prove it. #430 built `acceptQuote` / `denyQuote`, so the same block
   * now proves the opposite: both keys reach someone through
   * `portal/quoteDecision.ts`, and neither may still be badged "Never fires" on
   * the gate, which would tell the operator their toggles are decoration when
   * they are live controls over real mail.
   *
   * NOT ASSERTED WITH A `key:\s*'quote.accepted'` REGEX. The emitter picks the
   * key into a variable and passes it by shorthand, so a literal-argument regex
   * finds nothing, which is how the old negative version of this test stayed
   * green for a file that had already started dispatching both keys. The check
   * below looks for the key literal and the dispatch call in the same file,
   * which is the shape the map itself is guarded by.
   */
  for (const key of ['quote.accepted', 'quote.denied']) {
    it(`${key} is dispatched by src/portal/quoteDecision.ts`, () => {
      const emitters = NOTIFICATION_EMITTERS[key] ?? [];
      expect(emitters.map((e) => e.source)).toContain('src/portal/quoteDecision.ts');
      const src = read('src/portal/quoteDecision.ts');
      expect(src.includes(`'${key}'`), `quoteDecision.ts never names '${key}'`).toBe(true);
      expect(src.includes('enqueueNotification(')).toBe(true);
    });
    it(`${key} is no longer listed in NEVER_FIRES`, () => {
      expect(NEVER_FIRES).not.toContain(key);
    });
  }
});

describe('a retired key leaves no paragraph behind', () => {
  /**
   * Retiring a key deletes its catalog row, and the first check in this file
   * then fails with a bare set difference: a key on one side, absent from the
   * other, and the reader left to work out why. That is how #458
   * (`account.welcome.business`, withdrawn at the operator's request) left this
   * suite red without saying what to do about it.
   *
   * This does NOT filter retired keys out of that comparison before it runs.
   * Doing so would be an allow-list swallowing the exact drift the guard exists
   * to catch, and a provenance paragraph for a notification nobody sends any
   * more would sail through. Nor does it make retirement a one-list job: the
   * prose still has to be deleted by hand, because the prose IS the map. What
   * it adds is a failure that names the key, the date it was retired and the
   * operator's reason, so the next person reads an instruction rather than a
   * diff.
   */
  for (const [key, retired] of Object.entries(RETIRED_NOTIFICATION_KEYS)) {
    it(`${key} is described by no emitter and by no never-fires entry`, () => {
      const why =
        `'${key}' was retired on ${retired.retiredOn}. ${retired.reason} ` +
        'Delete its entry from notifications/provenance.ts.';
      expect(NOTIFICATION_EMITTERS[key], why).toBeUndefined();
      expect(NEVER_FIRES, why).not.toContain(key);
    });
  }

  it('and is gone from the catalog too, so the two checks cannot disagree', () => {
    for (const key of Object.keys(RETIRED_NOTIFICATION_KEYS)) {
      expect(NOTIFICATION_CATALOG[key], `${key} is retired but still a catalog row`).toBeUndefined();
    }
  });
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
