/**
 * Tests for seedDemoKinfolk.ts.
 *
 * Validates:
 *   - Payload shape matches the canonical Firestore models (Android Models.kt
 *     + FirestoreClient.kt + MyTribe portal callables).
 *   - Idempotency: re-building the payload yields a deeply-equal structure.
 *   - Placeholder marker discipline: every user-facing string is grep-able
 *     as either "TODO: ..." or "[placeholder]" or an explicitly-structural
 *     enum/timestamp value. No raw fake copy slips through.
 */

import { describe, it, expect } from 'vitest';
import {
  DEMO_FAMILY_IDS,
  buildSeedPayload,
  buildFormSchemas,
  planWritesForFamily,
  planFormSchemaWrites,
  planLinkUidWrite,
  planAllWrites,
  assertNoUserFacingCopy,
  parseArgs,
} from '../seedDemoKinfolk';

describe('seedDemoKinfolk parseArgs', () => {
  it('defaults to a dry run', () => {
    const a = parseArgs([]);
    expect(a.dryRun).toBe(true);
    expect(a.allowProd).toBe(false);
  });

  it('--allow-prod is what turns the dry run off', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.dryRun).toBe(false);
    expect(a.allowProd).toBe(true);
  });

  it('an explicit --dry-run always wins over --allow-prod, in EITHER flag order', () => {
    // The same inversion the backfills carried, wearing a boolean instead of a
    // Mode union: `--dry-run` set `args.dryRun = true` inline, and the
    // unconditional post-loop `if (args.allowProd) args.dryRun = false` then
    // ran once with no memory of it. main() returns before touching Firestore
    // only while `dryRun` is true, so this boolean is the whole guard.
    const allowThenDry = parseArgs(['--allow-prod', '--dry-run']);
    expect(allowThenDry.dryRun).toBe(true);
    // allowProd still reports the flag was seen, even though it lost.
    expect(allowThenDry.allowProd).toBe(true);

    const dryThenAllow = parseArgs(['--dry-run', '--allow-prod']);
    expect(dryThenAllow.dryRun).toBe(true);
    expect(dryThenAllow.allowProd).toBe(true);
  });

  it('one --dry-run beats any number of repeated --allow-prod', () => {
    expect(parseArgs(['--allow-prod', '--dry-run', '--allow-prod']).dryRun).toBe(true);
    // Repetition does not weaken the one intended write path either.
    expect(parseArgs(['--allow-prod', '--allow-prod']).dryRun).toBe(false);
  });

  it('takes a project override and a --link-uid', () => {
    const a = parseArgs(['--project', 'mytribe-test', '--link-uid=uid-1']);
    expect(a.projectId).toBe('mytribe-test');
    expect(a.linkUid).toBe('uid-1');
  });

  it('a valueless --project cannot swallow the --dry-run that follows it', () => {
    // `--project` rejected a MISSING value but happily took the next token, so
    // one forgotten project id turned `--allow-prod --project --dry-run` back
    // into a real seeding run with the safety flag eaten.
    expect(() => parseArgs(['--allow-prod', '--project', '--dry-run'])).toThrow(
      /--project requires a value/,
    );
    expect(() => parseArgs(['--project'])).toThrow(/--project requires a value/);
    // A real project id still passes through untouched, --dry-run intact.
    const ok = parseArgs(['--allow-prod', '--project', 'mytribe-test', '--dry-run']);
    expect(ok.projectId).toBe('mytribe-test');
    expect(ok.dryRun).toBe(true);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('seedDemoKinfolk — payload builder', () => {
  it('produces a kinfolk doc with the demo family id', () => {
    const p = buildSeedPayload('demo-family-001');
    expect(p.kinfolk._id).toBe('demo-family-001');
    expect(p.kinfolk._demo).toBe(true);
    expect(p.kinfolk.status).toBe('active');
    expect(p.kinfolk.householdMemberCount).toBeGreaterThan(0);
  });

  it('uses the RFC 6761 reserved tribetails.test TLD for demo emails', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.kinfolk.email).toMatch(/@tribetails\.test$/);
    }
  });

  it('seeds >= 2 kin per family with kinfolkId backref', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.kin.length).toBeGreaterThanOrEqual(2);
      for (const k of p.kin) {
        expect(k.kinfolkId).toBe(fam);
        expect(k._demo).toBe(true);
        expect(['Dog', 'Cat']).toContain(k.species);
      }
    }
  });

  it('seeds >= 3 completed historical sessions per family', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.sessions.length).toBeGreaterThanOrEqual(3);
      for (const s of p.sessions) {
        expect(s.status).toBe('COMPLETED');
        expect(s.kinfolkId).toBe(fam);
        expect(s.kinIds.length).toBeGreaterThan(0);
        // arrivedAt/departedAt populated for visit replay
        expect(s.arrivedAt).not.toBe('');
        expect(s.departedAt).not.toBe('');
      }
    }
  });

  it('produces one report per session with sessionId FK', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.reports.length).toBe(p.sessions.length);
      const sessionIds = new Set(p.sessions.map((s) => s._id));
      for (const r of p.reports) {
        expect(sessionIds.has(r.sessionId)).toBe(true);
        expect(r.kinfolkId).toBe(fam);
        expect(r.mediaFileIds).toEqual([]); // empty per spec
        expect(r.status).toBe('SENT');
        // sentVia marker so admin orphan-triage UI ignores demos
        expect(r.sentVia).toBe('demo_seed');
      }
    }
  });

  it('seeds one 411 doc per kin, all marked needsMoreSamples', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.the411.length).toBe(p.kin.length);
      const kinIds = new Set(p.kin.map((k) => k._id));
      for (const f of p.the411) {
        expect(kinIds.has(f.kinId)).toBe(true);
        expect(f.needsMoreSamples).toBe(true);
        expect(f._placeholder).toBe(true);
        // 411 doc id follows the legacy `411_{kinId}` Python migration prefix
        expect(f._id).toBe(`411_${f.kinId}`);
      }
    }
  });

  it('seeds one dossier per family, marked placeholder + needsMoreSamples', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.dossier.kinfolkId).toBe(fam);
      expect(p.dossier.needsMoreSamples).toBe(true);
      expect(p.dossier._placeholder).toBe(true);
      expect(p.dossier._id).toBe(`dossier_${fam}`);
    }
  });

  it('rejects unknown family ids', () => {
    expect(() => buildSeedPayload('demo-family-999' as any)).toThrow(/not a known/);
  });
});

describe('seedDemoKinfolk — idempotency', () => {
  it('re-running buildSeedPayload yields a deeply-equal payload', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const a = buildSeedPayload(fam);
      const b = buildSeedPayload(fam);
      expect(b).toEqual(a);
    }
  });

  it('planWritesForFamily yields the same paths + payloads on re-run', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const a = planWritesForFamily(fam);
      const b = planWritesForFamily(fam);
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i += 1) {
        expect(b[i].path).toBe(a[i].path);
        expect(b[i].data).toEqual(a[i].data);
      }
    }
  });

  it('every planned write has a deterministic id matching its path', () => {
    for (const w of planAllWrites()) {
      const tail = w.path.split('/').pop();
      const id = (w.data as { _id?: string })._id;
      expect(id).toBe(tail);
    }
  });

  it('no path appears twice across the full plan', () => {
    const paths = planAllWrites().map((w) => w.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
});

describe('seedDemoKinfolk — demo doc discipline', () => {
  it('assertNoUserFacingCopy passes on demo-flagged docs (mock content allowed)', () => {
    // Per operator direction 2026-05-19: free-form mock copy is allowed on
    // `_demo: true` docs; the demo flag is the canonical "fake data" signal.
    expect(() => assertNoUserFacingCopy(planAllWrites())).not.toThrow();
  });

  it('every demo-doc planned write carries _demo: true flag', () => {
    const writes = planAllWrites();
    for (const w of writes) {
      expect(w.data._demo, `${w.path} must carry _demo: true`).toBe(true);
    }
  });

  it('still catches a deliberately leaked non-demo user-facing string', () => {
    // Bad doc lacks _demo flag — should still trip the validator.
    const bad = [
      {
        path: 'kinfolk/real-001',
        data: {
          _id: 'real-001',
          firstName: 'Real Person Name That Slipped Through',
        },
      },
    ];
    expect(() => assertNoUserFacingCopy(bad)).toThrow(/non-placeholder text/);
  });

  it('representative demo fields contain mock content (not the literal TODO marker)', () => {
    const writes = planAllWrites();
    const samples: Array<{ path: string; field: string }> = [
      { path: 'kinfolk/demo-family-001', field: 'firstName' },
      { path: 'kin/demo-family-001-kin-1', field: 'name' },
      { path: 'kin_care_reports/demo-family-001-report-1', field: 'bodyCopy' },
      { path: 'dossiers/dossier_demo-family-001', field: 'householdNotes' },
      { path: 'the_411/411_demo-family-001-kin-1', field: 'personality' },
    ];
    for (const s of samples) {
      const doc = writes.find((w) => w.path === s.path);
      expect(doc, `missing planned write for ${s.path}`).toBeDefined();
      const val = (doc!.data as Record<string, unknown>)[s.field];
      expect(typeof val).toBe('string');
      expect((val as string).length).toBeGreaterThan(0);
      expect(val as string).not.toMatch(/^TODO:/);
    }
  });
});

describe('seedDemoKinfolk — schema field coverage', () => {
  it('kinfolk doc carries the fields downstream MyTribe fns read', () => {
    // getMyHome reads kinfolk/{id}.firstName + lastName; getMyTribeProfile
    // reads families/{id}.displayName (separate collection). The seed should
    // at minimum satisfy the kinfolk-record fallback chain.
    const p = buildSeedPayload('demo-family-001');
    expect(p.kinfolk).toHaveProperty('firstName');
    expect(p.kinfolk).toHaveProperty('lastName');
    expect(p.kinfolk).toHaveProperty('displayName');
  });

  it('session doc carries the fields getMyVisits queries on', () => {
    // getMyVisits.ts: .where('kinfolkId', '==', kinfolkId).orderBy('startTime', 'desc')
    const p = buildSeedPayload('demo-family-001');
    for (const s of p.sessions) {
      expect(s).toHaveProperty('kinfolkId');
      expect(s).toHaveProperty('startTime');
      // serviceType + endTime + arrivedAt + departedAt all surfaced by the DTO
      expect(s).toHaveProperty('serviceType');
      expect(s).toHaveProperty('endTime');
      expect(s).toHaveProperty('arrivedAt');
      expect(s).toHaveProperty('departedAt');
    }
  });

  it('report doc carries the fields getMyKinTales queries on', () => {
    // getMyKinTales.ts: .where('kinfolkId', '==', kinfolkId).where('sentAt', '>', '')
    // .orderBy('sentAt', 'desc'). Plus bodyCopy + mediaFileIds + authorDisplayName.
    const p = buildSeedPayload('demo-family-001');
    for (const r of p.reports) {
      expect(r).toHaveProperty('kinfolkId');
      expect(r.sentAt).not.toBe('');
      expect(r).toHaveProperty('bodyCopy');
      expect(r).toHaveProperty('mediaFileIds');
      expect(r).toHaveProperty('authorDisplayName');
    }
  });

  it('411 + dossier carry placeholder + needsMoreSamples for UI banner', () => {
    const p = buildSeedPayload('demo-family-001');
    for (const f of p.the411) {
      expect(f.needsMoreSamples).toBe(true);
      expect(f._placeholder).toBe(true);
    }
    expect(p.dossier.needsMoreSamples).toBe(true);
    expect(p.dossier._placeholder).toBe(true);
  });
});

describe('seedDemoKinfolk (MyTribe portal docs: home, bookings, invoices)', () => {
  it('seeds a families/{fam} doc with displayName + accountBalanceCents', () => {
    // getMyHome reads families/{fam}.displayName (fallback #1);
    // getMyInvoices reads families/{fam}.accountBalanceCents.
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      expect(p.family._id).toBe(fam);
      expect(p.family._demo).toBe(true);
      expect(typeof p.family.displayName).toBe('string');
      expect(p.family.displayName.length).toBeGreaterThan(0);
      expect(typeof p.family.accountBalanceCents).toBe('number');
    }
  });

  it('seeds bookings spanning every getMyBookings bucket', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      const statuses = p.bookings.map((b) => b.status);
      // live bucket
      expect(statuses).toContain('active');
      // upcoming bucket (two: one requested, one confirmed)
      expect(statuses.filter((s) => s === 'requested' || s === 'confirmed').length).toBe(2);
      // recent bucket
      expect(statuses).toContain('completed');
      for (const b of p.bookings) {
        expect(b.kinfolkId).toBe(fam);
        expect(b._demo).toBe(true);
        // fields getMyBookings.ts maps
        expect(b).toHaveProperty('serviceType');
        expect(b).toHaveProperty('serviceName');
        expect(b).toHaveProperty('title');
        expect(b).toHaveProperty('startTime');
        expect(b).toHaveProperty('endTime');
        expect(b).toHaveProperty('kinIds');
        expect(b).toHaveProperty('kinNames');
        expect(b).toHaveProperty('auntieDisplayName');
        expect(b).toHaveProperty('notes');
        expect(b).toHaveProperty('requestBatchId');
        expect(typeof b.startTime).toBe('number');
        expect(typeof b.updatedAt).toBe('number');
      }
    }
  });

  it('upcoming bookings sit in the future so getMyBookings keeps them', () => {
    // getMyBookings filters upcoming on startTime >= now - 60s. The future
    // anchor must out-live wall-clock at test time.
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      const upcoming = p.bookings.filter((b) => b.status === 'requested' || b.status === 'confirmed');
      for (const b of upcoming) {
        expect(b.startTime).toBeGreaterThan(Date.now());
      }
    }
  });

  it('seeds invoices including an open, a paid, and a credit doc', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const p = buildSeedPayload(fam);
      const statuses = p.invoices.map((i) => i.invoiceStatus);
      expect(statuses).toContain('open');
      expect(statuses).toContain('paid');
      expect(statuses).toContain('credit');
      for (const inv of p.invoices) {
        expect(inv.kinfolkId).toBe(fam);
        expect(inv._demo).toBe(true);
        expect(Array.isArray(inv.lineItems)).toBe(true);
        expect(inv.lineItems.length).toBeGreaterThan(0);
      }
      const credit = p.invoices.find((i) => i.invoiceStatus === 'credit')!;
      // getMyInvoices treats negative amountDue/total as credit math input.
      expect(credit.amountDue).toBeLessThan(0);
      expect(credit.creditTarget).toBe('accountBalance');
    }
  });

  it('writes flat invoices/{id} AND families/{fam}/invoices/{id} (collection split)', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const paths = planWritesForFamily(fam).map((w) => w.path);
      const p = buildSeedPayload(fam);
      for (const inv of p.invoices) {
        expect(paths).toContain(`invoices/${inv._id}`);
        expect(paths).toContain(`families/${fam}/invoices/${inv._id}`);
      }
      // booking + family paths land under the families tree
      expect(paths).toContain(`families/${fam}`);
      for (const b of p.bookings) {
        expect(paths).toContain(`families/${fam}/bookings/${b._id}`);
      }
    }
  });

  it('flat + subcollection invoice copies carry identical data', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const writes = planWritesForFamily(fam);
      const p = buildSeedPayload(fam);
      for (const inv of p.invoices) {
        const flat = writes.find((w) => w.path === `invoices/${inv._id}`)!;
        const sub = writes.find((w) => w.path === `families/${fam}/invoices/${inv._id}`)!;
        expect(sub.data).toEqual(flat.data);
      }
    }
  });
});

describe('seedDemoKinfolk (form schemas)', () => {
  it('builds tribeProfile + homeAccess schemas in the getFormSchema shape', () => {
    const schemas = buildFormSchemas();
    const ids = schemas.map((s) => s.id);
    expect(ids).toContain('tribeProfile');
    expect(ids).toContain('homeAccess');
    for (const s of schemas) {
      expect(s._demo).toBe(true);
      expect(typeof s.name).toBe('string');
      expect(typeof s.version).toBe('number');
      expect(s.sections.length).toBeGreaterThanOrEqual(2);
      for (const sec of s.sections) {
        expect(typeof sec.title).toBe('string');
        expect(sec.fields.length).toBeGreaterThan(0);
        for (const f of sec.fields) {
          expect(typeof f.key).toBe('string');
          expect(typeof f.label).toBe('string');
          expect(typeof f.type).toBe('string');
          expect(typeof f.required).toBe('boolean');
        }
      }
    }
  });

  it('plans formSchemas/{id} writes with matching ids', () => {
    const writes = planFormSchemaWrites();
    const paths = writes.map((w) => w.path);
    expect(paths).toContain('formSchemas/tribeProfile');
    expect(paths).toContain('formSchemas/homeAccess');
    for (const w of writes) {
      expect(w.path).toBe(`formSchemas/${(w.data as { _id?: string })._id}`);
      expect(w.data._demo).toBe(true);
    }
  });

  it('includes form-schema writes in the full plan', () => {
    const paths = planAllWrites().map((w) => w.path);
    expect(paths).toContain('formSchemas/tribeProfile');
    expect(paths).toContain('formSchemas/homeAccess');
  });

  it('builds the account schema with the typed-save field keys', () => {
    const account = buildFormSchemas().find((s) => s.id === 'account');
    expect(account, 'account schema must be built').toBeDefined();
    expect(account!._demo).toBe(true);
    const sectionTitles = account!.sections.map((s) => s.title);
    expect(sectionTitles).toEqual(['Profile', 'Secondary Contact', 'Recovery']);
    const keysBySection = Object.fromEntries(
      account!.sections.map((s) => [s.title, s.fields.map((f) => f.key)]),
    );
    expect(keysBySection.Profile).toEqual(['displayName', 'phone']);
    expect(keysBySection['Secondary Contact']).toEqual(['secondaryEmail', 'secondaryRole']);
    expect(keysBySection.Recovery).toEqual(['backupEmail', 'backupPhone']);
    // displayName is the one required field the typed save depends on.
    const displayName = account!.sections[0].fields.find((f) => f.key === 'displayName')!;
    expect(displayName.required).toBe(true);
    expect(displayName.type).toBe('text');
  });

  it('builds the kinProfile schema with the KinPayload field keys', () => {
    const kinProfile = buildFormSchemas().find((s) => s.id === 'kinProfile');
    expect(kinProfile, 'kinProfile schema must be built').toBeDefined();
    expect(kinProfile!._demo).toBe(true);
    const sectionTitles = kinProfile!.sections.map((s) => s.title);
    expect(sectionTitles).toEqual(['Profile', 'Care']);
    const keysBySection = Object.fromEntries(
      kinProfile!.sections.map((s) => [s.title, s.fields.map((f) => f.key)]),
    );
    expect(keysBySection.Profile).toEqual(['species', 'breed', 'ageYears']);
    expect(keysBySection.Care).toEqual([
      'feedingInstructions',
      'walkingInstructions',
      'medications',
      'allergies',
      'emergencyNotes',
      'sitterNotes',
    ]);
    // ageYears feeds a typed Double so it must render as a number field.
    const ageYears = kinProfile!.sections[0].fields.find((f) => f.key === 'ageYears')!;
    expect(ageYears.type).toBe('number');
  });

  it('plans account + kinProfile schema writes in the full plan', () => {
    const paths = planAllWrites().map((w) => w.path);
    expect(paths).toContain('formSchemas/account');
    expect(paths).toContain('formSchemas/kinProfile');
  });
});

describe('seedDemoKinfolk (tester link --link-uid)', () => {
  it('links the given uid to demo-family-001 via clients/{uid} set merge', () => {
    const w = planLinkUidWrite('tester-uid-123');
    expect(w.path).toBe('clients/tester-uid-123');
    expect(w.data.kinfolkIds).toEqual(['demo-family-001']);
    expect(w.data._demo).toBe(true);
  });

  it('link write is idempotent (same path + data on re-run)', () => {
    const a = planLinkUidWrite('tester-uid-123');
    const b = planLinkUidWrite('tester-uid-123');
    expect(b.path).toBe(a.path);
    expect(b.data).toEqual(a.data);
  });

  it('the link write is NOT part of the default plan (CLI flag only)', () => {
    const paths = planAllWrites().map((w) => w.path);
    expect(paths.some((p) => p.startsWith('clients/'))).toBe(false);
  });
});

describe('seedDemoKinfolk (new docs idempotency + discipline)', () => {
  it('re-running buildSeedPayload yields deeply-equal family/bookings/invoices', () => {
    for (const fam of DEMO_FAMILY_IDS) {
      const a = buildSeedPayload(fam);
      const b = buildSeedPayload(fam);
      expect(b.family).toEqual(a.family);
      expect(b.bookings).toEqual(a.bookings);
      expect(b.invoices).toEqual(a.invoices);
    }
  });

  it('buildFormSchemas re-run is deeply-equal', () => {
    expect(buildFormSchemas()).toEqual(buildFormSchemas());
  });

  it('every new planned write carries _demo: true', () => {
    // planAllWrites already asserts this elsewhere; re-confirm the new families/
    // + invoices/ + formSchemas/ paths specifically.
    const writes = planAllWrites();
    const newish = writes.filter(
      (w) =>
        w.path.startsWith('families/') ||
        w.path.startsWith('invoices/') ||
        w.path.startsWith('formSchemas/'),
    );
    expect(newish.length).toBeGreaterThan(0);
    for (const w of newish) {
      expect(w.data._demo, `${w.path} must carry _demo: true`).toBe(true);
    }
  });

  it('assertNoUserFacingCopy still passes once new docs are in the plan', () => {
    const writes = planAllWrites();
    writes.push(planLinkUidWrite('tester-uid-123'));
    expect(() => assertNoUserFacingCopy(writes)).not.toThrow();
  });
});
