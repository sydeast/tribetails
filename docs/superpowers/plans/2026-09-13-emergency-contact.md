# Emergency Contact (PR 1 of #829) Implementation Plan

**Goal:** Give Emergency Contact one store (`kinfolk/{id}.emergencyContacts`, up to two, in call order), one write path (`saveEmergencyContacts`), a read path (`listEmergencyContacts`), required-ness, the "not a household member" rule, proof that nobody messages them, a dry-run-first migration of the 8 flat records, and working editors on all five clients.

**Architecture:** A pure lib (`mytribe/functions/src/lib/emergencyContacts.ts`) owns normalising, matching, merging and reading (array first, flat triple as legacy fallback). Two strict-schema callables in `mytribe/functions/src/portal/emergencyContacts.ts` gate on `requireKinfolkPerm(..., 'home_access', ...)` and replace the array whole. Rules stop the kinfolk claim writing any Emergency Contact field. Every client reads through a per-client pure helper (array, else flat fallback) and writes only through the callable. The migration is a `mytribe/scripts` backfill in the house `backfillKinfolkVetToHousehold.ts` shape.

**Tech Stack:** Firebase Functions v2 (Node 22, zod 4, vitest 5, libphonenumber-js), Firestore rules + `@firebase/rules-unit-testing`, React 19 + Vite + vitest/RTL (admin `auntieos-admin/src`, portal `mytribe/web`), Cypress 16, Android (Kotlin, Compose, mockk, Robolectric), Compose Multiplatform desktop (`auntieos-admin/web/composeApp`, jvm), KMP portal (`mytribe/src`, `:jvmTest`).

**Spec:** `docs/superpowers/specs/2026-09-13-household-roles-design.md`, sections 1, 3, the Emergency Contact rows of section 4, and the migration. Section 2 (secondary kinfolk) is PR 2 and is out of scope.

**Global Constraints:**
- Full vertical on all five clients: admin React web, admin Android, admin desktop console, portal web, portal Android. Web and Android are both mandatory.
- Persisted fields are editable and clearable. Relationship is optional; an emptied relationship persists as `null`.
- Android saves stay diff-not-rebuild. `emergencyContacts` is never part of `KINFOLK_DIFF_FIELDS`; it is declared in `KINFOLK_SERVER_OWNED` so the drift guard in `DirectorySaveTest` stays honest.
- Rules are edited in `mytribe/firestore.rules` only. `auntieos-admin/web/firestore.rules` is a symlink to it (verified 2026-09-13), so there is nothing to copy; `rules-mirror.test.js` still runs.
- No client writes `kinfolk.emergencyContacts` directly. No rule is loosened.
- `FieldValue.serverTimestamp()` cannot sit inside an array element. Contact `recordedAt`/`updatedAt` use `Timestamp.now()`; tests freeze the clock.
- Never log a contact's name or phone. `logEvent` carries the household id and counts.
- User-facing copy: no em dashes. Kin = pet, Kinfolk = household, Auntie = caregiver. Verbatim spec strings: `A household needs at least one Emergency Contact` and `An Emergency Contact has to be someone outside the household.` Explanatory text goes in a tooltip, never a subtitle under a panel title (operator ruling 2026-09-11).
- Old flat fields (`emergencyContactName/Phone/Relation`) stay readable as a fallback until the operator verifies the migration. No client writes them after this PR.
- Branch `feat/829-emergency-contact` in a manual worktree, never on main. Long commit messages go through `git commit -F <file>`. Merge with `gh pr merge --merge`.
- The migration write is the operator's step after release. The PR contains the dry run only.

---

## File Structure

### Backend (`mytribe/functions`)
| File | Action | Responsibility |
|---|---|---|
| `src/lib/emergencyContacts.ts` | Create | Constants, spec messages, name/phone comparison, household clash check, merge that keeps `recordedAt`, read-with-legacy-fallback, `recordedAtForLegacy` (updatedAt, then joinDate, then null) |
| `src/portal/emergencyContacts.ts` | Create | `saveEmergencyContacts` and `listEmergencyContacts` callables (strict zod, gate, logEvent) |
| `src/index.ts` | Modify | Export the two callables |
| `CALLABLE_CONTRACT.md` | Modify | Document both callables |
| `test/emergencyContacts.test.ts` | Create | Lib and callable tests |
| `test/emergencyContactsNeverMessaged.test.ts` | Create | Static scan plus one test per audience builder |
| `test/rules/kinfolkProfile.test.ts` | Modify | Kinfolk claim can no longer write any Emergency Contact field |
| `package.json` | Modify | `backfill:emergency-contacts` script |

### Rules
| File | Action | Responsibility |
|---|---|---|
| `mytribe/firestore.rules` | Modify | Drop the three flat keys from `onlyAllowedKinfolkFields()` |

### Migration (`mytribe/scripts`)
| File | Action | Responsibility |
|---|---|---|
| `backfillKinfolkEmergencyContacts.ts` | Create | Dry run by default, per-household diff, `--allow-prod` apply |
| `test/backfillKinfolkEmergencyContacts.test.ts` | Create | Planner and arg parser |
| `test/backfillKinfolkEmergencyContacts.emulator.test.ts` | Create | Real write against the emulator, idempotence |

### Admin React (`auntieos-admin/src`)
| File | Action | Responsibility |
|---|---|---|
| `api/emergencyContacts.ts` (+ `.test.ts`) | Create | Callable wrappers, doc reader, draft validation |
| `components/EmergencyContactsEditor.tsx` (+ `.test.tsx`, `.css`) | Create | Two-slot ordered editor |
| `components/NoEmergencyContactFlag.tsx` | Create | The "No Emergency Contact" pill |
| `api/kinfolkProfile.ts` | Modify | Replace the flat triple with `emergencyContacts: EmergencyContact[]` |
| `api/kinfolkProfileWrite.ts` (+ test) | Modify | Remove the three flat keys from `KinfolkEditPatch`, `KINFOLK_EDIT_FIELDS`, `TRIMMED` |
| `screens/KinfolkEdit.tsx` (+ test) | Modify | Editor over the callable; a household with none can still save other edits |
| `screens/KinfolkProfile.tsx` (+ test) | Modify | Ordered list, flag when empty |
| `components/AddKinfolkDialog.tsx` (+ test) | Modify | One contact required; create, then save contacts, with a retry state |
| `api/directory.ts`, `screens/Directory.tsx` (+ test) | Modify | Flag on the card |
| `api/members.ts` | Modify | Widened `home_access` description |
| `cypress/e2e/kinfolk-profile.cy.ts` | Modify | Drive the editor, intercept the callable |

### Admin Android (`auntieos-admin/android/app/src`)
| File | Action | Responsibility |
|---|---|---|
| `main/.../data/model/EmergencyContacts.kt` | Create | `EmergencyContact`, `EmergencyContactDraft`, `emergencyContactsOf`, `validateEmergencyContactDrafts`, `decodeEmergencyContacts` |
| `main/.../data/model/Models.kt` | Modify | `var emergencyContacts: Any? = null` on `Kinfolk` |
| `main/.../ui/directory/DirectoryFieldChanges.kt` | Modify | Flat keys leave the diff; four keys join `KINFOLK_SERVER_OWNED` |
| `main/.../data/repository/AuntieRepository.kt` | Modify | `listEmergencyContacts`, `saveEmergencyContacts` |
| `main/.../ui/directory/DirectoryViewModel.kt` | Modify | Draft state for add and edit, save through the callable |
| `main/.../ui/directory/EmergencyContactsEditor.kt` | Create | Shared Compose editor |
| `main/.../ui/directory/EditKinfolkScreen.kt`, `AddKinfolkScreen.kt` | Modify | Use the editor |
| `main/.../ui/directory/KinfolkProfileScreen.kt`, `DirectoryScreen.kt` | Modify | Ordered panel, flag |
| `main/.../ui/admin/KinCareDetailScreen.kt`, `ui/kintales/KinTaleTemplateEngine.kt` | Modify | Read through `emergencyContactsOf` |
| `main/.../ui/members/HouseholdMembersScreen.kt` | Modify | Widened description |
| `test/.../data/model/EmergencyContactsTest.kt` | Create | Pure helpers |
| `test/.../ui/directory/DirectoryViewModelEmergencyContactsTest.kt` | Create | Add and edit saves |
| `test/.../ui/directory/EmergencyContactsEditorUiTest.kt` | Create | Editor controls |

### Admin desktop console (`auntieos-admin/web/composeApp/src`)
| File | Action | Responsibility |
|---|---|---|
| `commonMain/.../web/data/EmergencyContacts.kt` | Create | Model, reader, validation, `kinfolkWriteJson` |
| `commonMain/.../web/data/FirestoreClient.kt` | Modify | `emergencyContacts: JsonElement?` on `Kinfolk`; callable wrappers |
| `jvmMain/.../web/data/FirestoreInterop.jvm.kt` | Modify | Kinfolk update becomes a merge write that never names `emergencyContacts` |
| `jvmMain/.../web/data/JvmFirestoreRest.kt` | Modify | `mergeDoc` records `lastWrite` |
| `commonMain/.../web/screens/directory/EmergencyContactsEditor.kt` | Create | Editor |
| `commonMain/.../web/screens/directory/KinfolkEditScreen.kt`, `KinfolkProfileScreen.kt`, `DirectoryScreen.kt` | Modify | Editor, panel, flag |
| `commonMain/.../web/screens/sessions/KinCareDetailScreen.kt`, `data/KinTaleConditionEngine.kt` | Modify | Read through the helper |
| `commonTest/.../web/data/EmergencyContactsTest.kt` | Create | Pure helpers |
| `jvmTest/.../web/data/EmergencyContactsClientTest.kt` | Create | Callable wrappers and the merge write |

### Portal web (`mytribe/web/src`)
| File | Action | Responsibility |
|---|---|---|
| `api/tribeApi.ts` | Modify | Wrappers and DTOs |
| `components/EmergencyContactsCard.tsx` (+ `.test.tsx`) | Create | Card: read-only without `home_access`, prompt when empty |
| `screens/TribeProfile.tsx` | Modify | Card replaces the old fields; `vetFields` becomes `vetClinicFields`; no `emergencyContact*` in `saveTribeProfile` |
| `screens/TribeProfile.test.tsx`, `TribeProfile.contacts.test.tsx` | Modify | Mocks for the new calls; payload assertion |

### Portal Android (`mytribe/src`)
| File | Action | Responsibility |
|---|---|---|
| `commonMain/.../portal/TribeDtos.kt` | Modify | DTOs |
| `commonMain/.../portal/PortalApi.kt` | Modify | `listEmergencyContacts`, `saveEmergencyContacts` |
| `commonMain/.../screens/tribe/EmergencyContactsCard.kt` | Create | Card |
| `commonMain/.../screens/tribe/TribeScreen.kt` | Modify | Card replaces fields; `vetFields` becomes `vetClinicFields` |
| `commonTest/.../portal/EmergencyContactsPortalApiTest.kt` | Create | Wire payloads |
| `composeUiTest/.../screens/tribe/EmergencyContactsCardTest.kt` | Create | Card behaviour |

---

## Task 0: Worktree

- [ ] **Step 1: Create the worktree from fresh main**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails
git fetch origin main
git worktree add ../tribetails-worktrees/829-emergency-contact -b feat/829-emergency-contact origin/main
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/sydeast/Projects/testai/CascadeProjects/tribetails-worktrees/829-emergency-contact
npm ci
npm ci --prefix mytribe/functions
```

Expected: both finish with no `ERR!`. Every later path is relative to this worktree root.

## Task 1: Lib and callables (`saveEmergencyContacts`, `listEmergencyContacts`)

**Files:**
- Create: `mytribe/functions/src/lib/emergencyContacts.ts`
- Create: `mytribe/functions/src/portal/emergencyContacts.ts`
- Create: `mytribe/functions/test/emergencyContacts.test.ts`
- Modify: `mytribe/functions/src/index.ts` (after the `householdContacts` export block, ~line 282)
- Modify: `mytribe/functions/CALLABLE_CONTRACT.md` (new section after `removeHouseholdContact`)
- Modify: `mytribe/functions/test/callableContract.test.ts` (freeze the request shape: five hand-built clients mirror it)

**Interfaces:**
- Consumes: `normalizeE164(input, defaultCountry?)`, `isValidPhone(input)` from `src/lib/phoneNormalize.ts`; `resolveKinfolkAccess(uid, requested, hasAdminClaim, fn): Promise<{kinfolkId, isOperator}>`; `requireKinfolkPerm(uid, kinfolkId, perm, hasAdminClaim, fn)`; `hasKinfolkPerm(uid, kinfolkId, perm, hasAdminClaim, fn): Promise<boolean>`; `isStaff(uid, hasAdminClaim, fn): boolean`; `MemberDoc` from `src/lib/schema.ts`.
- Produces:
  - `EMERGENCY_CONTACTS_MAX = 2`, `EMERGENCY_CONTACT_NAME_MAX = 80`, `EMERGENCY_CONTACT_PHONE_MAX = 32`, `EMERGENCY_CONTACT_RELATIONSHIP_MAX = 40`
  - `EMERGENCY_CONTACT_REQUIRED_MESSAGE = 'A household needs at least one Emergency Contact'`
  - `EMERGENCY_CONTACT_OUTSIDE_MESSAGE = 'An Emergency Contact has to be someone outside the household.'`
  - `interface EmergencyContactInput { name: string; phone: string; relationship: string | null }`
  - `interface StoredEmergencyContact extends EmergencyContactInput { recordedAt: Timestamp | null; updatedAt: Timestamp | null }`
  - `interface HouseholdIdentity { names: string[]; phones: string[] }`
  - `normaliseName(v: string): string`, `comparablePhone(v: string | null | undefined): string | null`
  - `householdIdentity(kinfolk: Record<string, unknown>, members: Array<Record<string, unknown>>): HouseholdIdentity`
  - `householdClash(contacts: EmergencyContactInput[], who: HouseholdIdentity): number` (index, or -1)
  - `mergeEmergencyContacts(existing: StoredEmergencyContact[], incoming: EmergencyContactInput[], now: Timestamp): StoredEmergencyContact[]`
  - `timestampFromStored(v: unknown): Timestamp | null`
  - `recordedAtForLegacy(kinfolk): { value: Timestamp | null; source: 'updatedAt' | 'joinDate' | null }`
  - `readStoredEmergencyContacts(kinfolk): { contacts: StoredEmergencyContact[]; legacy: boolean }`
  - Callable `saveEmergencyContacts` req `{ kinfolkId?: string, contacts: Array<{ name: string, phone: string, relationship?: string | null }> }`, res `{ contacts: EmergencyContactDTO[] }`
  - Callable `listEmergencyContacts` req `{ kinfolkId?: string }`, res `{ contacts: EmergencyContactDTO[], canEdit: boolean, legacy: boolean }`
  - `interface EmergencyContactDTO { name: string; phone: string; relationship: string | null; recordedAt: string | null; updatedAt: string | null }` (ISO-8601)

- [ ] **Step 1: Write the failing test**

Create `mytribe/functions/test/emergencyContacts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

import {
  comparablePhone,
  householdClash,
  mergeEmergencyContacts,
  normaliseName,
  readStoredEmergencyContacts,
  recordedAtForLegacy,
  EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
  EMERGENCY_CONTACT_REQUIRED_MESSAGE,
} from '../src/lib/emergencyContacts';
import {
  saveEmergencyContactsHandler,
  listEmergencyContactsHandler,
} from '../src/portal/emergencyContacts';

const NOW_ISO = '2026-09-14T15:00:00.000Z';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
});
afterEach(() => vi.useRealTimers());

const PRIMARY_DOC = {
  firstName: 'Dana',
  lastName: 'Mercer',
  phoneNumber: '(805) 555-0100',
  secondaryPhone: '',
  updatedAt: '2026-03-02T10:00:00.000Z',
};

function household(opts: {
  caller?: { uid: string; member?: Record<string, unknown> | null };
  kinfolk?: Record<string, unknown>;
  members?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  const caller = opts.caller ?? { uid: 'primary-uid', member: { role: 'PRIMARY', status: 'ACTIVE' } };
  const members = opts.members ?? [];
  return buildDbMock({
    docs: {
      [`clients/${caller.uid}`]: { kinfolkIds: ['fam1'] },
      ...(caller.member ? { [`families/fam1/members/${caller.uid}`]: caller.member } : {}),
      ...Object.fromEntries(members.map((m) => [`families/fam1/members/${m.id}`, m.data])),
      'kinfolk/fam1': opts.kinfolk ?? PRIMARY_DOC,
    },
    queryDocs: { 'families/fam1/members': members },
  });
}

function call(data: unknown, uid = 'primary-uid', token: Record<string, unknown> = {}) {
  return { data, auth: { uid, token } } as never;
}

describe('emergencyContacts lib', () => {
  it('normaliseName ignores case and spacing', () => {
    expect(normaliseName('  Rae   MERCER ')).toBe('rae mercer');
  });

  it('comparablePhone matches formatted and E.164 spellings, and never throws on junk', () => {
    expect(comparablePhone('(805) 555-0199')).toBe(comparablePhone('+18055550199'));
    expect(comparablePhone('ext 12')).toBe('12');
    expect(comparablePhone('')).toBeNull();
  });

  it('householdClash finds a phone or a name that belongs to the household', () => {
    const who = { names: ['Dana Mercer', 'Sam  Mercer'], phones: ['805-555-0100'] };
    expect(householdClash([{ name: 'Rae', phone: '+18055550100', relationship: null }], who)).toBe(0);
    expect(householdClash([{ name: 'Rae', phone: '8055550199', relationship: null }, { name: 'sam mercer', phone: '8055550188', relationship: null }], who)).toBe(1);
    expect(householdClash([{ name: 'Rae', phone: '8055550199', relationship: null }], who)).toBe(-1);
  });

  it('merge keeps recordedAt for a known contact, and keeps updatedAt when nothing changed', () => {
    const then = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
    const now = Timestamp.fromDate(new Date(NOW_ISO));
    const existing = [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: then, updatedAt: then }];
    const [same] = mergeEmergencyContacts(existing, [{ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' }], now);
    expect(same.recordedAt).toEqual(then);
    expect(same.updatedAt).toEqual(then);
    const [edited] = mergeEmergencyContacts(existing, [{ name: 'Rae Mercer', phone: '+18055550199', relationship: null }], now);
    expect(edited.recordedAt).toEqual(then);
    expect(edited.updatedAt).toEqual(now);
    const [fresh] = mergeEmergencyContacts(existing, [{ name: 'Lee Park', phone: '+18055550177', relationship: null }], now);
    expect(fresh.recordedAt).toEqual(now);
  });

  it('reads the array first, then the flat triple as a legacy contact dated by updatedAt', () => {
    const legacy = readStoredEmergencyContacts({ ...PRIMARY_DOC, emergencyContactName: 'Rae Mercer', emergencyContactPhone: '805-555-0199', emergencyContactRelation: '' });
    expect(legacy.legacy).toBe(true);
    expect(legacy.contacts).toHaveLength(1);
    expect(legacy.contacts[0].relationship).toBeNull();
    expect(legacy.contacts[0].recordedAt?.toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(readStoredEmergencyContacts(PRIMARY_DOC)).toEqual({ contacts: [], legacy: false });
  });

  it('recordedAtForLegacy falls back from updatedAt to joinDate to null', () => {
    expect(recordedAtForLegacy({ updatedAt: '2026-03-02T10:00:00.000Z' }).source).toBe('updatedAt');
    expect(recordedAtForLegacy({ joinDate: '2025-11-20' }).source).toBe('joinDate');
    expect(recordedAtForLegacy({})).toEqual({ value: null, source: null });
  });
});

describe('saveEmergencyContactsHandler', () => {
  it('rejects unauth', async () => {
    await expect(saveEmergencyContactsHandler({ data: { contacts: [] }, auth: undefined } as never)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('REQUIRED: refuses an empty list with the spec message and writes nothing', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [] }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_REQUIRED_MESSAGE,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a third contact', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const c = (n: string, p: string) => ({ name: n, phone: p });
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [c('A', '8055550101'), c('B', '8055550102'), c('C', '8055550103')] })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('STRICT: refuses an unknown key by name', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199', uid: 'x' }] })),
    ).rejects.toMatchObject({ code: 'invalid-argument', message: /uid/ });
  });

  it('refuses a missing name and an invalid phone', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: '  ', phone: '8055550199' }] }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '12' }] }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses the same phone twice', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }, { name: 'Lee', phone: '(805) 555-0199' }] })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it("OUTSIDE: refuses the primary's own phone, spelled differently", async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '+1 805 555 0100' }] }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it("OUTSIDE: refuses a secondary member's name, case and spacing ignored", async () => {
    const ctx = household({ members: [{ id: 'second-uid', data: { role: 'SECONDARY', status: 'ACTIVE', displayName: 'Sam Mercer', phone: '' } }] });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: ' sam   MERCER', phone: '8055550177' }] }))).rejects.toMatchObject({
      message: EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
    });
  });

  it('saves two in call order: E.164 phones, empty relationship as null, dated now, never logging the phone', async () => {
    const ctx = household();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(
      call({ kinfolkId: 'fam1', contacts: [{ name: ' Rae Mercer ', phone: '(805) 555-0199', relationship: 'Sister' }, { name: 'Lee Park', phone: '805.555.0177', relationship: '' }] }),
    );
    const write = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    const stored = write?.data.emergencyContacts as Array<Record<string, unknown>>;
    expect(stored.map((c) => c.name)).toEqual(['Rae Mercer', 'Lee Park']);
    expect(stored.map((c) => c.phone)).toEqual(['+18055550199', '+18055550177']);
    expect(stored[1].relationship).toBeNull();
    expect((stored[0].recordedAt as Timestamp).toDate().toISOString()).toBe(NOW_ISO);
    expect(write?.data.updatedAt).toBe('__SERVER_TS__');
    expect(res.contacts[0]).toMatchObject({ name: 'Rae Mercer', recordedAt: NOW_ISO });
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('0199');
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('Rae');
  });

  it('a reorder keeps both recordedAt values', async () => {
    const t1 = Timestamp.fromDate(new Date('2026-01-01T00:00:00Z'));
    const t2 = Timestamp.fromDate(new Date('2026-02-01T00:00:00Z'));
    const ctx = household({
      kinfolk: {
        ...PRIMARY_DOC,
        emergencyContacts: [
          { name: 'Rae Mercer', phone: '+18055550199', relationship: null, recordedAt: t1, updatedAt: t1 },
          { name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: t2, updatedAt: t2 },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Lee Park', phone: '+18055550177' }, { name: 'Rae Mercer', phone: '+18055550199' }] }));
    const stored = ctx.writes[0].data.emergencyContacts as Array<{ recordedAt: Timestamp }>;
    expect(stored[0].recordedAt).toEqual(t2);
    expect(stored[1].recordedAt).toEqual(t1);
  });

  it('GATE: a SECONDARY without home_access is denied and writes nothing', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: false } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'second-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('GATE: a SECONDARY with home_access may save', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: { home_access: true } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'second-uid'));
    expect(res.contacts).toHaveLength(1);
  });

  it('GATE: staff with the admin claim may save on any household', async () => {
    const ctx = buildDbMock({ docs: { 'clients/op-uid': { kinfolkIds: [] }, 'kinfolk/fam1': PRIMARY_DOC }, queryDocs: { 'families/fam1/members': [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveEmergencyContactsHandler(call({ kinfolkId: 'fam1', contacts: [{ name: 'Rae', phone: '8055550199' }] }, 'op-uid', { admin: true }));
    expect(res.contacts).toHaveLength(1);
  });
});

describe('listEmergencyContactsHandler', () => {
  it('projects the legacy flat triple, marks it legacy, and tells a primary it can edit', async () => {
    const ctx = household({ kinfolk: { ...PRIMARY_DOC, emergencyContactName: 'Rae Mercer', emergencyContactPhone: '805-555-0199' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }));
    expect(res).toMatchObject({ legacy: true, canEdit: true });
    expect(res.contacts[0]).toMatchObject({ name: 'Rae Mercer', phone: '805-555-0199', recordedAt: '2026-03-02T10:00:00.000Z' });
  });

  it('an ACTIVE SECONDARY without home_access reads, and cannot edit', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'ACTIVE', permissions: {} } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }, 'second-uid'));
    expect(res).toEqual({ contacts: [], canEdit: false, legacy: false });
  });

  it('a member who is not ACTIVE is denied', async () => {
    const ctx = household({ caller: { uid: 'second-uid', member: { role: 'SECONDARY', status: 'REMOVED', permissions: { home_access: true } } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listEmergencyContactsHandler(call({ kinfolkId: 'fam1' }, 'second-uid'))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mytribe/functions && npx vitest run test/emergencyContacts.test.ts
```

Expected: FAIL, `Failed to resolve import "../src/lib/emergencyContacts"`.

- [ ] **Step 3: Write the lib**

Create `mytribe/functions/src/lib/emergencyContacts.ts`:

```ts
import { Timestamp } from 'firebase-admin/firestore';
import { normalizeE164 } from './phoneNormalize';

/**
 * Emergency Contacts, issue #829 section 1. The person called when no kinfolk
 * answers. Never a recipient of anything (see
 * test/emergencyContactsNeverMessaged.test.ts), never a household member.
 *
 * Stored as `kinfolk/{id}.emergencyContacts`, index 0 called first. Until the
 * operator verifies the migration, a doc with no array still carries the old
 * flat `emergencyContactName/Phone/Relation` triple; `readStoredEmergencyContacts`
 * projects it as one legacy contact so no reader goes blank in between.
 */
export const EMERGENCY_CONTACTS_MAX = 2;
export const EMERGENCY_CONTACT_NAME_MAX = 80;
export const EMERGENCY_CONTACT_PHONE_MAX = 32;
export const EMERGENCY_CONTACT_RELATIONSHIP_MAX = 40;
export const EMERGENCY_CONTACT_REQUIRED_MESSAGE = 'A household needs at least one Emergency Contact';
export const EMERGENCY_CONTACT_OUTSIDE_MESSAGE = 'An Emergency Contact has to be someone outside the household.';

export interface EmergencyContactInput {
  name: string;
  phone: string;
  relationship: string | null;
}

export interface StoredEmergencyContact extends EmergencyContactInput {
  /** When the office first had this person. Null only for a migrated record with no date at all. */
  recordedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface HouseholdIdentity {
  names: string[];
  phones: string[];
}

export function normaliseName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A phone reduced to digits for comparison. E.164 when libphonenumber accepts
 * it; otherwise bare digits with a US country code added to a 10-digit string.
 * Never throws: a malformed stored member phone must not turn a save into a 500.
 */
export function comparablePhone(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === '') return null;
  try {
    const e164 = normalizeE164(t);
    return e164 === null ? null : e164.replace(/\D/g, '');
  } catch {
    const d = t.replace(/\D/g, '');
    if (d === '') return null;
    return d.length === 10 ? `1${d}` : d;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

/** The primary (from the kinfolk doc) plus every member doc of the household. */
export function householdIdentity(
  kinfolk: Record<string, unknown>,
  members: Array<Record<string, unknown>>,
): HouseholdIdentity {
  const primaryName = `${str(kinfolk['firstName'])} ${str(kinfolk['lastName'])}`;
  return {
    names: [primaryName, ...members.map((m) => str(m['displayName']))].filter((n) => n.trim() !== ''),
    phones: [str(kinfolk['phoneNumber']), str(kinfolk['secondaryPhone']), ...members.map((m) => str(m['phone']))].filter((p) => p !== ''),
  };
}

/** Index of the first contact who is really a household member, or -1. */
export function householdClash(contacts: EmergencyContactInput[], who: HouseholdIdentity): number {
  const names = new Set(who.names.map(normaliseName).filter((n) => n !== ''));
  const phones = new Set(who.phones.map(comparablePhone).filter((p): p is string => p !== null));
  return contacts.findIndex((c) => {
    const phone = comparablePhone(c.phone);
    return names.has(normaliseName(c.name)) || (phone !== null && phones.has(phone));
  });
}

/**
 * Replace-whole, without losing history. Each incoming contact is matched to a
 * stored one by phone, then by name; a match keeps its `recordedAt`, and keeps
 * its `updatedAt` when name, phone and relationship are all unchanged. A
 * reorder is therefore one write that changes no dates.
 */
export function mergeEmergencyContacts(
  existing: StoredEmergencyContact[],
  incoming: EmergencyContactInput[],
  now: Timestamp,
): StoredEmergencyContact[] {
  const used = new Set<number>();
  return incoming.map((c) => {
    const phone = comparablePhone(c.phone);
    let idx = existing.findIndex((e, i) => !used.has(i) && phone !== null && comparablePhone(e.phone) === phone);
    if (idx === -1) idx = existing.findIndex((e, i) => !used.has(i) && normaliseName(e.name) === normaliseName(c.name));
    if (idx === -1) return { ...c, recordedAt: now, updatedAt: now };
    used.add(idx);
    const prev = existing[idx];
    const unchanged = prev.name === c.name && prev.phone === c.phone && (prev.relationship ?? null) === c.relationship;
    return { ...c, recordedAt: prev.recordedAt, updatedAt: unchanged ? (prev.updatedAt ?? now) : now };
  });
}

/** Timestamp | ISO string | `{_seconds}` | `YYYY-MM-DD` to a Timestamp, else null. */
export function timestampFromStored(v: unknown): Timestamp | null {
  if (v instanceof Timestamp) return v;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['toDate'] === 'function') return Timestamp.fromDate((o['toDate'] as () => Date)());
    if (typeof o['_seconds'] === 'number') return new Timestamp(o['_seconds'] as number, Number(o['_nanoseconds'] ?? 0));
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : Timestamp.fromDate(d);
  }
  return null;
}

/**
 * The date a legacy flat record gets. The kinfolk doc's own `updatedAt` (the
 * closest real date the old record has, stored as a String on most docs and a
 * Timestamp on some), then `joinDate`, then null. Never the migration time.
 */
export function recordedAtForLegacy(
  kinfolk: Record<string, unknown>,
): { value: Timestamp | null; source: 'updatedAt' | 'joinDate' | null } {
  const fromUpdated = timestampFromStored(kinfolk['updatedAt']);
  if (fromUpdated) return { value: fromUpdated, source: 'updatedAt' };
  const fromJoin = timestampFromStored(kinfolk['joinDate']);
  if (fromJoin) return { value: fromJoin, source: 'joinDate' };
  return { value: null, source: null };
}

export function readStoredEmergencyContacts(
  kinfolk: Record<string, unknown>,
): { contacts: StoredEmergencyContact[]; legacy: boolean } {
  const raw = kinfolk['emergencyContacts'];
  if (Array.isArray(raw) && raw.length > 0) {
    const contacts = raw
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((o) => ({
        name: str(o['name']),
        phone: str(o['phone']),
        relationship: strOrNull(o['relationship']),
        recordedAt: timestampFromStored(o['recordedAt']),
        updatedAt: timestampFromStored(o['updatedAt']),
      }))
      .filter((c) => c.name !== '' || c.phone !== '');
    return { contacts, legacy: false };
  }
  const name = str(kinfolk['emergencyContactName']);
  const phone = str(kinfolk['emergencyContactPhone']);
  if (name === '' && phone === '') return { contacts: [], legacy: false };
  const dated = recordedAtForLegacy(kinfolk).value;
  return {
    contacts: [{ name, phone, relationship: strOrNull(kinfolk['emergencyContactRelation']), recordedAt: dated, updatedAt: dated }],
    legacy: true,
  };
}
```

- [ ] **Step 4: Write the callables**

Create `mytribe/functions/src/portal/emergencyContacts.ts`:

```ts
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { hasKinfolkPerm, requireKinfolkPerm } from '../lib/memberGate';
import { isStaff } from '../lib/staffGate';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveKinfolkAccess } from '../lib/resolveKinfolkAccess';
import { isValidPhone, normalizeE164 } from '../lib/phoneNormalize';
import type { MemberDoc } from '../lib/schema';
import {
  comparablePhone,
  EMERGENCY_CONTACTS_MAX,
  EMERGENCY_CONTACT_NAME_MAX,
  EMERGENCY_CONTACT_OUTSIDE_MESSAGE,
  EMERGENCY_CONTACT_PHONE_MAX,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX,
  EMERGENCY_CONTACT_REQUIRED_MESSAGE,
  householdClash,
  householdIdentity,
  mergeEmergencyContacts,
  readStoredEmergencyContacts,
  type StoredEmergencyContact,
} from '../lib/emergencyContacts';

/**
 * The one write path for Emergency Contacts (#829 section 1), used by all five
 * clients, and its read. Gate is `home_access` (section 3): staff and the
 * PRIMARY pass inside `requireKinfolkPerm`; a SECONDARY needs the flag. Reading
 * is open to any ACTIVE member; `canEdit` tells the portal whether to draw the
 * editor. Never logs a name or a phone.
 */

const ContactZ = z
  .object({
    name: z.string().trim().min(1, 'An Emergency Contact needs a name.').max(EMERGENCY_CONTACT_NAME_MAX),
    phone: z
      .string()
      .trim()
      .min(1, 'An Emergency Contact needs a phone number.')
      .max(EMERGENCY_CONTACT_PHONE_MAX)
      .refine((p) => isValidPhone(p), 'That phone number is not a valid number.')
      .transform((p) => normalizeE164(p) as string),
    relationship: z
      .union([z.string().max(EMERGENCY_CONTACT_RELATIONSHIP_MAX), z.null()])
      .optional()
      .transform((v) => {
        const t = (v ?? '').trim();
        return t === '' ? null : t;
      }),
  })
  .strict();

const SaveArgs = z
  .object({
    kinfolkId: z.string().optional(),
    contacts: z.array(ContactZ).max(EMERGENCY_CONTACTS_MAX, 'A household can have at most two Emergency Contacts.'),
  })
  .strict();

const ListArgs = z.object({ kinfolkId: z.string().optional() }).strict();

function parseArgs<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
  throw new HttpsError('invalid-argument', `${issue?.message ?? 'Invalid arguments.'}${where}`);
}

export interface EmergencyContactDTO {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

function toDto(c: StoredEmergencyContact): EmergencyContactDTO {
  return {
    name: c.name,
    phone: c.phone,
    relationship: c.relationship,
    recordedAt: c.recordedAt ? c.recordedAt.toDate().toISOString() : null,
    updatedAt: c.updatedAt ? c.updatedAt.toDate().toISOString() : null,
  };
}

export async function saveEmergencyContactsHandler(
  req: CallableRequest<unknown>,
): Promise<{ contacts: EmergencyContactDTO[] }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(SaveArgs, req.data);
  const isAdmin = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, isAdmin, 'saveEmergencyContacts');
  await requireKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'saveEmergencyContacts');

  if (args.contacts.length === 0) {
    throw new HttpsError('failed-precondition', EMERGENCY_CONTACT_REQUIRED_MESSAGE);
  }
  if (args.contacts.length === 2 && comparablePhone(args.contacts[0].phone) === comparablePhone(args.contacts[1].phone)) {
    throw new HttpsError('invalid-argument', 'The two Emergency Contacts need different phone numbers.');
  }

  const firestore = db();
  const ref = firestore.doc(`kinfolk/${kinfolkId}`);
  const [kinSnap, membersSnap] = await Promise.all([ref.get(), firestore.collection(`families/${kinfolkId}/members`).get()]);
  if (!kinSnap.exists) throw new HttpsError('not-found', 'That household no longer exists.');
  const kinfolk = (kinSnap.data() ?? {}) as Record<string, unknown>;
  const who = householdIdentity(kinfolk, membersSnap.docs.map((d) => (d.data() ?? {}) as Record<string, unknown>));
  if (householdClash(args.contacts, who) !== -1) {
    throw new HttpsError('failed-precondition', EMERGENCY_CONTACT_OUTSIDE_MESSAGE);
  }

  const merged = mergeEmergencyContacts(readStoredEmergencyContacts(kinfolk).contacts, args.contacts, Timestamp.now());
  await ref.update({ emergencyContacts: merged, updatedAt: FieldValue.serverTimestamp() });

  logEvent({
    severity: 'info',
    function: 'saveEmergencyContacts',
    event: 'kinfolk.emergencyContacts.saved',
    uid,
    extra: { kinfolkId, count: merged.length },
  });
  return { contacts: merged.map(toDto) };
}

export async function listEmergencyContactsHandler(
  req: CallableRequest<unknown>,
): Promise<{ contacts: EmergencyContactDTO[]; canEdit: boolean; legacy: boolean }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = parseArgs(ListArgs, req.data);
  const isAdmin = req.auth?.token?.admin === true;
  const { kinfolkId } = await resolveKinfolkAccess(uid, args.kinfolkId, isAdmin, 'listEmergencyContacts');

  const firestore = db();
  if (!isStaff(uid, isAdmin, 'listEmergencyContacts')) {
    const memberSnap = await firestore.doc(`families/${kinfolkId}/members/${uid}`).get();
    // Missing member doc: the legacy single-primary account, same anti-lockout
    // rule as requireKinfolkPerm. Present but not ACTIVE: denied.
    if (memberSnap.exists && (memberSnap.data() as MemberDoc).status !== 'ACTIVE') {
      throw new HttpsError('permission-denied', 'permission-denied');
    }
  }
  const [kinSnap, canEdit] = await Promise.all([
    firestore.doc(`kinfolk/${kinfolkId}`).get(),
    hasKinfolkPerm(uid, kinfolkId, 'home_access', isAdmin, 'listEmergencyContacts'),
  ]);
  if (!kinSnap.exists) throw new HttpsError('not-found', 'That household no longer exists.');
  const { contacts, legacy } = readStoredEmergencyContacts((kinSnap.data() ?? {}) as Record<string, unknown>);

  logEvent({
    severity: 'info',
    function: 'listEmergencyContacts',
    event: 'kinfolk.emergencyContacts.listed',
    uid,
    extra: { kinfolkId, count: contacts.length, legacy },
  });
  return { contacts: contacts.map(toDto), canEdit, legacy };
}

// AUNTIE_OPERATOR_UIDS because isStaff reads it: without the secret an
// allowlisted operator with no admin claim is denied in production.
const OPTIONS = {
  region: 'us-central1' as const,
  cors: TRIBETAILS_CORS,
  secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
};

export const saveEmergencyContacts = onCall(OPTIONS, wrapCallable('saveEmergencyContacts', saveEmergencyContactsHandler));
export const listEmergencyContacts = onCall(OPTIONS, wrapCallable('listEmergencyContacts', listEmergencyContactsHandler));
```

Add to `mytribe/functions/src/index.ts`, directly after the `householdContacts` export block:

```ts
// #829 section 1: the one store and the one write path for Emergency Contacts,
// used by all five clients. Gated on home_access.
export { saveEmergencyContacts, listEmergencyContacts } from './portal/emergencyContacts';
```

Add to `mytribe/functions/CALLABLE_CONTRACT.md`, after the `removeHouseholdContact` entry:

```md
### saveEmergencyContacts / listEmergencyContacts (#829)
- `saveEmergencyContacts`
  - req `{ kinfolkId?: string, contacts: Array<{ name: string /* 1..80 */, phone: string /* valid, stored E.164 */, relationship?: string | null /* <= 40, '' and null persist as null */ }> }` (strict, max 2)
  - res `{ contacts: EmergencyContactDTO[] }`
  - Replaces `kinfolk/{id}.emergencyContacts` whole, index 0 called first. A contact matched by phone, then name, keeps `recordedAt`.
  - Refuses `[]` with `failed-precondition` "A household needs at least one Emergency Contact".
  - Refuses a contact whose phone matches the primary's `phoneNumber`/`secondaryPhone` or any member's `phone`, or whose name matches a member name (case and spacing ignored), with `failed-precondition` "An Emergency Contact has to be someone outside the household."
- `listEmergencyContacts`
  - req `{ kinfolkId?: string }`, res `{ contacts: EmergencyContactDTO[], canEdit: boolean, legacy: boolean }`
  - `legacy: true` means the doc has no array yet and the flat `emergencyContact*` triple was projected as one contact.
- `EmergencyContactDTO` `{ name, phone, relationship: string | null, recordedAt: string | null, updatedAt: string | null }` (ISO-8601)
- GATE: `resolveKinfolkAccess` + `requireKinfolkPerm(..., 'home_access')` for save; any ACTIVE member (or staff, or a legacy primary with no member doc) for list, with `canEdit` from `hasKinfolkPerm(..., 'home_access')`. Secrets `SENTRY_DSN`, `AUNTIE_OPERATOR_UIDS`.
- NEVER a recipient: no audience builder reads these fields (`test/emergencyContactsNeverMessaged.test.ts`). NEVER logged: name or phone.
- Clients: `auntieos-admin/src/api/emergencyContacts.ts`, Android `AuntieRepository.listEmergencyContacts / saveEmergencyContacts`, desktop `FirestoreClient.listEmergencyContacts / saveEmergencyContacts`, `mytribe/web/src/api/tribeApi.ts`, `PortalApi.listEmergencyContacts / saveEmergencyContacts`.
```

- [ ] **Step 5: Run the tests**

```bash
cd mytribe/functions && npx vitest run test/emergencyContacts.test.ts test/callableContract.test.ts && npm run typecheck
```

Expected: all tests in `emergencyContacts.test.ts` and `callableContract.test.ts` PASS; `tsc` exits 0.

Before this run, freeze the request shape in `mytribe/functions/test/callableContract.test.ts`. In `src/portal/emergencyContacts.ts`, directly after `SaveArgs`:

```ts
/** Exported for the callable-contract freeze: five clients hand-build this payload. */
export { SaveArgs as Args };
```

In the test, beside the other schema imports:

```ts
// #829: five hand-built clients (admin web, admin Android, desktop, portal web,
// portal Android) mirror this payload, and `contacts[]` is nested, so it gets
// the recursive signature.
import { Args as SaveEmergencyContactsArgs } from '../src/portal/emergencyContacts';
```

and in the recursive-signature map beside `saveTemplate`:

```ts
  saveEmergencyContacts: {
    schema: SaveEmergencyContactsArgs,
    signature: ['contacts[].name', 'contacts[].phone', 'contacts[].relationship', 'kinfolkId'],
  },
```

(If `shapeSignature` orders or spells the paths differently, run the test once and copy the signature it reports.)

- [ ] **Step 6: Commit**

```bash
git add mytribe/functions/src/lib/emergencyContacts.ts mytribe/functions/src/portal/emergencyContacts.ts mytribe/functions/src/index.ts mytribe/functions/CALLABLE_CONTRACT.md mytribe/functions/test/emergencyContacts.test.ts
git commit -m "Add saveEmergencyContacts and listEmergencyContacts behind home_access (#829)"
```

## Task 2: Rules, the kinfolk claim writes no Emergency Contact field

Decision recorded here: the kinfolk-claim allowlist still carried the three flat keys. No portal surface ever wrote `kinfolk/{id}` directly, and the callable is now the only door, so they come out. `emergencyContacts` was never on the list and stays refused. The `isAuntie()` branch is not changed (the desktop and Android admins write this document directly, and Task 7/8 keep them off the array instead).

**Files:**
- Modify: `mytribe/firestore.rules` (`onlyAllowedKinfolkFields`, ~line 294)
- Modify: `mytribe/functions/test/rules/kinfolkProfile.test.ts` (the test at ~line 80)

**Interfaces:**
- Consumes: `getEnv`, `cleanup`, `shutdown` from `test/rules/setup.ts`; local `asKinfolk`, `seedKinfolk`.
- Produces: rule `onlyAllowedKinfolkFields()` allows `['preferredContactMethod', 'bestTimeToContact', 'secondaryPhone', 'secondaryEmail']`.

- [ ] **Step 1: Write the failing test**

In `mytribe/functions/test/rules/kinfolkProfile.test.ts`, replace the test `'a household can still update its allowlisted contact fields'` with:

```ts
  it('a household can still update its allowlisted contact fields', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertSucceeds(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({
        preferredContactMethod: 'text',
        bestTimeToContact: 'Mornings',
      }),
    );
  });

  // #829: the callable `saveEmergencyContacts` is the only way in. A household
  // writing its own flat field would put a second, unvalidated copy beside the
  // array that nobody checks against household members.
  it('a household cannot write a flat Emergency Contact field', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({ emergencyContactPhone: '805-555-0199' }),
    );
  });

  it('a household cannot write the emergencyContacts array', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({
        emergencyContacts: [{ name: 'Rae Mercer', phone: '+18055550199', relationship: null }],
      }),
    );
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mytribe/functions && npm run test:rules
```

Expected: FAIL on `a household cannot write a flat Emergency Contact field` (the write succeeds today). The array test already passes; it pins the behaviour.

- [ ] **Step 3: Change the rule**

In `mytribe/firestore.rules`:

```
    function onlyAllowedKinfolkFields() {
      // #829: the three flat emergencyContact* keys left this list. Emergency
      // Contacts are written only by the saveEmergencyContacts callable.
      let allowed = ['preferredContactMethod', 'bestTimeToContact', 'secondaryPhone', 'secondaryEmail'];
      return request.resource.data.diff(resource.data).affectedKeys().hasOnly(allowed);
    }
```

- [ ] **Step 4: Run the tests**

```bash
cd mytribe/functions && npm run test:rules
cd ../../auntieos-admin/web/functions && npm test
```

Expected: the rules suite PASSES (always through the npm script; bare vitest reports green having run nothing). `rules-mirror.test.js` PASSES (the admin copy is a symlink).

- [ ] **Step 5: Commit**

```bash
git add mytribe/firestore.rules mytribe/functions/test/rules/kinfolkProfile.test.ts
git commit -m "Stop the kinfolk claim writing Emergency Contact fields directly (#829)"
```

---

## Task 3: Emergency Contacts are never messaged

Audience builders found: `broadcastMessage` (`resolveRecipientsFromKinfolk` over a private `toKinfolkLike`, SMS to `phoneNumber`), `resolveMarketingAudience` (uids), `resolveRecipients` in `notifications/recipientResolver.ts` (uids), and `sendSmsChannel`'s `lookupRecipientPhone` (phones from `clients/`/`staff/`). `sendInvoiceReminder`, `lib/autoReminder.ts` and `src/scheduled/*` read no phone. The dispatcher only resolves uids. None reads Emergency Contact fields today; these tests keep it that way.

**Files:**
- Create: `mytribe/functions/test/emergencyContactsNeverMessaged.test.ts`

**Interfaces:**
- Consumes: `broadcastMessageHandler(req)`, `resolveMarketingAudience(args: AudienceArgs): Promise<ResolvedAudience>`, `resolveRecipients(def, args)`, `sendSmsChannel({ def, recipientUid, data })`, `buildDbMock`.
- Produces: nothing beyond the tests.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildDbMock } from './_helpers/mockDb';
import type { CallableRequest } from 'firebase-functions/v2/https';
import type { NotificationDef } from '../src/notifications/types';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  twilioCreate: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  multicast: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: () => ({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) }),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: () => ({ messages: { create: mocks.twilioCreate } }),
  getTwilioFromNumber: () => '+15550000000',
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { broadcastMessageHandler } from '../src/admin/broadcastMessage';
import { resolveMarketingAudience } from '../src/admin/marketingAudience';
import { resolveRecipients } from '../src/notifications/recipientResolver';
import { sendSmsChannel } from '../src/notifications/senders/smsChannel';

/** Phones that belong to Emergency Contacts, in both the new and the legacy store. */
const EC_PHONE = '+18055550199';
const EC_FLAT_PHONE = '+18055550198';
const PRIMARY_PHONE = '+14155552671';

const KINFOLK_WITH_EC = {
  status: 'active',
  tags: [],
  email: 'a@x.com',
  phoneNumber: PRIMARY_PHONE,
  uid: 'u1',
  emergencyContacts: [{ name: 'Rae Mercer', phone: EC_PHONE, relationship: 'Sister', recordedAt: null, updatedAt: null }],
  emergencyContactName: 'Rae Mercer',
  emergencyContactPhone: EC_FLAT_PHONE,
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SM1' });
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('sg-1');
  mocks.multicast.mockReset().mockResolvedValue({ successCount: 1, responses: [{ success: true, messageId: 'fcm-1' }] });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('Emergency Contacts are never a recipient (#829)', () => {
  it('STATIC: only the Emergency Contact lib, its callable and index.ts name the fields', () => {
    const src = join(__dirname, '..', 'src');
    const allowed = new Set(['lib/emergencyContacts.ts', 'portal/emergencyContacts.ts', 'index.ts']);
    const offenders = walk(src)
      .map((f) => relative(src, f).split('\\').join('/'))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => /emergencyContact(s|Name|Phone|Relation)\b/.test(readFileSync(join(src, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('broadcastMessage texts the household phone and never an Emergency Contact phone', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'clients/u1': { notificationPrefs: { byKey: { 'broadcast.message': { sms: true } } } } },
      queryDocs: { kinfolk: [{ id: 'k1', data: KINFOLK_WITH_EC }], fcm_tokens: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler({
      data: { criteria: { kind: 'all' }, channels: ['sms'], body: 'Closed Monday' },
      auth: { uid: 'admin1', token: { admin: true } },
    } as unknown as CallableRequest<unknown>);
    const tos = mocks.twilioCreate.mock.calls.map((c) => (c[0] as { to: string }).to);
    expect(tos).toEqual([PRIMARY_PHONE]);
    expect(tos).not.toContain(EC_PHONE);
    expect(tos).not.toContain(EC_FLAT_PHONE);
  });

  it('resolveMarketingAudience resolves account uids only', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [{ id: 'k1', data: KINFOLK_WITH_EC }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const audience = await resolveMarketingAudience({ criteria: { kind: 'all' } });
    expect(audience.uids).toEqual(['u1']);
    expect(JSON.stringify(audience)).not.toContain(EC_PHONE);
    expect(JSON.stringify(audience)).not.toContain('Rae');
  });

  it('resolveRecipients returns the supplied account and nothing from the household record', async () => {
    const def = {
      key: 't.k', label: 'Test', audience: 'kinfolk', audiences: { kinfolk: true }, category: 'visit',
      allowedChannels: ['sms'], required: {}, alwaysEnabled: false, kinfolkFacing: true, deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct', templates: { sms: 't.k' }, description: 'test',
    } as NotificationDef;
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'kinfolk/k1': KINFOLK_WITH_EC } }).db);
    const out = await resolveRecipients(def, { key: 't.k', recipientUid: 'u1', data: { kinfolkId: 'k1' } } as never);
    expect(out).toEqual([{ uid: 'u1', collection: 'clients' }]);
  });

  it('sendSmsChannel sends to the account phone even when the household carries Emergency Contacts', async () => {
    const def = {
      key: 't.k', label: 'Test', audience: 'kinfolk', audiences: { kinfolk: true }, category: 'visit',
      allowedChannels: ['sms'], required: {}, alwaysEnabled: false, kinfolkFacing: true, deliveryMode: 'trigger',
      recipientResolver: 'kinfolkAcct', templates: { sms: 't.k' }, description: 'test',
    } as NotificationDef;
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        docs: { 'smsTemplates/t.k': { text: 'Hi' }, 'clients/u1': { phone: PRIMARY_PHONE }, 'kinfolk/k1': KINFOLK_WITH_EC },
      }).db,
    );
    await sendSmsChannel({ def, recipientUid: 'u1', data: { kinfolkId: 'k1' } });
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
    expect((mocks.twilioCreate.mock.calls[0][0] as { to: string }).to).toBe(PRIMARY_PHONE);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd mytribe/functions && npx vitest run test/emergencyContactsNeverMessaged.test.ts
```

Expected: PASS. These are guards over current behaviour, so there is no red step. Prove each guard can fail before trusting it: temporarily add `const x = 'emergencyContacts';` to `src/admin/audienceCriteria.ts` and re-run; expect `STATIC` to FAIL naming `admin/audienceCriteria.ts`. Revert and re-run to PASS. If the broadcast test reports `no_recipients` or a zod error, open `test/broadcastMessage.test.ts` `kinfolkDb()` and match its fixture before changing any assertion.

- [ ] **Step 3: Commit**

```bash
git add mytribe/functions/test/emergencyContactsNeverMessaged.test.ts
git commit -m "Pin that no audience builder ever reaches an Emergency Contact (#829)"
```

## Task 4: Migration script (dry run in the PR, write run by the operator)

**Files:**
- Create: `mytribe/scripts/backfillKinfolkEmergencyContacts.ts`
- Create: `mytribe/scripts/test/backfillKinfolkEmergencyContacts.test.ts`
- Create: `mytribe/scripts/test/backfillKinfolkEmergencyContacts.emulator.test.ts`
- Modify: `mytribe/functions/package.json` (scripts)

**Interfaces:**
- Consumes: `recordedAtForLegacy`, `comparablePhone` from `../functions/src/lib/emergencyContacts`; `normalizeE164` from `../functions/src/lib/phoneNormalize`.
- Produces:
  - `parseArgs(argv: string[]): { mode: 'dry-run' | 'apply'; allowProd: boolean; projectId: string | null }` (same precedence rules as `backfillKinfolkVetToHousehold.ts`: `--dry-run` always wins)
  - `type EcPlan = { action: 'migrate'; contact: { name: string; phone: string; relationship: string | null; recordedAt: Timestamp | null; updatedAt: Timestamp | null }; dateSource: 'updatedAt' | 'joinDate' | null; phoneCarriedAsTyped: boolean } | { action: 'skip'; reason: 'already-has-array' | 'no-flat-fields' } | { action: 'report'; reason: 'name-missing' | 'phone-missing' }`
  - `planEmergencyContactMigration(kinfolk: Record<string, unknown>): EcPlan`
  - `buildPlan(db: Firestore): Promise<Array<{ kinfolkId: string; plan: EcPlan }>>`
  - `applyPlan(db: Firestore, rows: Array<{ kinfolkId: string; plan: EcPlan }>): Promise<number>`
  - npm script `backfill:emergency-contacts`

What it writes: `emergencyContacts: [contact]` only, via `update`. It does not touch `updatedAt` (that would move the very date it copies) and does not delete the flat fields (they stay readable until the operator verifies; their removal is a follow-up). It skips any doc that already holds a non-empty array, so a household that saved through the callable before the run keeps its newer choice.

- [ ] **Step 1: Write the failing tests**

`mytribe/scripts/test/backfillKinfolkEmergencyContacts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { parseArgs, planEmergencyContactMigration } from '../backfillKinfolkEmergencyContacts';

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('applies only with --allow-prod, and --dry-run wins in either order', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses an unknown arg and a valueless --project', () => {
    expect(() => parseArgs(['--wipe'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project requires a value/);
  });
});

describe('planEmergencyContactMigration', () => {
  it('moves the flat triple into slot 0, dated by the doc updatedAt string, never now', () => {
    const plan = planEmergencyContactMigration({
      emergencyContactName: ' Rae Mercer ',
      emergencyContactPhone: '805-555-0199',
      emergencyContactRelation: 'Sister',
      updatedAt: '2026-03-02T10:00:00.000Z',
    });
    expect(plan.action).toBe('migrate');
    if (plan.action !== 'migrate') return;
    expect(plan.contact).toMatchObject({ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' });
    expect(plan.contact.recordedAt?.toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(plan.contact.updatedAt).toEqual(plan.contact.recordedAt);
    expect(plan.dateSource).toBe('updatedAt');
  });

  it('accepts a Timestamp updatedAt and falls back to joinDate, then null', () => {
    const ts = Timestamp.fromDate(new Date('2026-04-01T00:00:00Z'));
    const a = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', updatedAt: ts });
    expect(a.action === 'migrate' && a.contact.recordedAt).toEqual(ts);
    const b = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', joinDate: '2025-11-20' });
    expect(b.action === 'migrate' && b.dateSource).toBe('joinDate');
    const c = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199' });
    expect(c.action === 'migrate' && c.contact.recordedAt).toBeNull();
  });

  it('an empty relationship becomes null', () => {
    const p = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', emergencyContactRelation: '  ' });
    expect(p.action === 'migrate' && p.contact.relationship).toBeNull();
  });

  it('carries an unparseable phone as typed and flags it', () => {
    const p = planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: 'ask neighbour' });
    expect(p.action === 'migrate' && p.contact.phone).toBe('ask neighbour');
    expect(p.action === 'migrate' && p.phoneCarriedAsTyped).toBe(true);
  });

  it('skips a doc that already has the array, and one with nothing to move', () => {
    expect(planEmergencyContactMigration({ emergencyContactName: 'Rae', emergencyContactPhone: '8055550199', emergencyContacts: [{ name: 'Lee', phone: '+18055550177' }] })).toEqual({ action: 'skip', reason: 'already-has-array' });
    expect(planEmergencyContactMigration({ firstName: 'Dana' })).toEqual({ action: 'skip', reason: 'no-flat-fields' });
  });

  it('reports half a record for a person instead of inventing the other half', () => {
    expect(planEmergencyContactMigration({ emergencyContactName: 'Rae' })).toEqual({ action: 'report', reason: 'phone-missing' });
    expect(planEmergencyContactMigration({ emergencyContactPhone: '8055550199' })).toEqual({ action: 'report', reason: 'name-missing' });
  });
});
```

`mytribe/scripts/test/backfillKinfolkEmergencyContacts.emulator.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getApps, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { buildPlan, applyPlan } from '../backfillKinfolkEmergencyContacts';

const EMULATOR = process.env['FIRESTORE_EMULATOR_HOST'];

describe.runIf(EMULATOR)('the Emergency Contact migration against a real document', () => {
  let db: Firestore;
  beforeAll(() => {
    if (getApps().length === 0) initializeApp({ projectId: 'ec-migration-test' });
    db = getFirestore();
  });
  afterAll(async () => {
    await Promise.all(getApps().map((a) => deleteApp(a)));
  });

  it('writes the array, keeps the flat fields and updatedAt, and is idempotent', async () => {
    await db.collection('kinfolk').doc('kf_ec').set({
      firstName: 'Dana',
      updatedAt: '2026-03-02T10:00:00.000Z',
      emergencyContactName: 'Rae Mercer',
      emergencyContactPhone: '805-555-0199',
      emergencyContactRelation: 'Sister',
    });
    await db.collection('kinfolk').doc('kf_done').set({
      emergencyContactName: 'Old',
      emergencyContactPhone: '8055550100',
      emergencyContacts: [{ name: 'Lee Park', phone: '+18055550177', relationship: null, recordedAt: null, updatedAt: null }],
    });

    const written = await applyPlan(db, await buildPlan(db));
    expect(written).toBe(1);

    const kf = (await db.collection('kinfolk').doc('kf_ec').get()).data() ?? {};
    const [c] = kf['emergencyContacts'] as Array<Record<string, any>>;
    expect(c).toMatchObject({ name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister' });
    expect(c['recordedAt'].toDate().toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['updatedAt']).toBe('2026-03-02T10:00:00.000Z');
    expect(kf['emergencyContactName']).toBe('Rae Mercer');

    const done = (await db.collection('kinfolk').doc('kf_done').get()).data() ?? {};
    expect((done['emergencyContacts'] as unknown[])).toHaveLength(1);
    expect((done['emergencyContacts'] as Array<Record<string, unknown>>)[0]['name']).toBe('Lee Park');

    expect(await applyPlan(db, await buildPlan(db))).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd mytribe/functions && npx vitest run ../scripts/test/backfillKinfolkEmergencyContacts.test.ts
```

Expected: FAIL, `Failed to resolve import "../backfillKinfolkEmergencyContacts"`.

- [ ] **Step 3: Write the script**

`mytribe/scripts/backfillKinfolkEmergencyContacts.ts`:

```ts
/**
 * backfillKinfolkEmergencyContacts.ts, #829 section 1 migration.
 *
 *   FROM  kinfolk/{id}  emergencyContactName / emergencyContactPhone / emergencyContactRelation
 *   TO    kinfolk/{id}  emergencyContacts[0] = { name, phone, relationship, recordedAt, updatedAt }
 *
 * recordedAt is the doc's existing `updatedAt` (a String on most docs, a
 * Timestamp on some), else `joinDate`, else null. NEVER the migration time: a
 * record the office has held since March must not read as entered today.
 *
 * WHAT IT NEVER DOES: overwrite a non-empty array (a callable save is the newer
 * decision); bump `updatedAt`; delete the flat fields (they stay readable until
 * the operator verifies this run, and go in a follow-up); invent half a record.
 *
 * Modes: default DRY RUN, prints a per-household diff. `--allow-prod` applies.
 * Runbook: the operator runs the dry run after release, reads it, then applies.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import { recordedAtForLegacy } from '../functions/src/lib/emergencyContacts';
import { normalizeE164 } from '../functions/src/lib/phoneNormalize';

type Mode = 'dry-run' | 'apply';
export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillKinfolkEmergencyContacts.ts: flat emergencyContact* fields into emergencyContacts[0] (#829)',
          '',
          '  npm run backfill:emergency-contacts                    # DRY RUN (default)',
          '  npm run backfill:emergency-contacts -- --allow-prod    # apply',
          '  npm run backfill:emergency-contacts -- --dry-run       # always wins',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

export interface MigratedContact {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export type EcPlan =
  | { action: 'migrate'; contact: MigratedContact; dateSource: 'updatedAt' | 'joinDate' | null; phoneCarriedAsTyped: boolean }
  | { action: 'skip'; reason: 'already-has-array' | 'no-flat-fields' }
  | { action: 'report'; reason: 'name-missing' | 'phone-missing' };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The decision for ONE household. Pure. */
export function planEmergencyContactMigration(kinfolk: Record<string, unknown>): EcPlan {
  const existing = kinfolk['emergencyContacts'];
  if (Array.isArray(existing) && existing.length > 0) return { action: 'skip', reason: 'already-has-array' };
  const name = str(kinfolk['emergencyContactName']);
  const rawPhone = str(kinfolk['emergencyContactPhone']);
  if (name === '' && rawPhone === '') return { action: 'skip', reason: 'no-flat-fields' };
  if (rawPhone === '') return { action: 'report', reason: 'phone-missing' };
  if (name === '') return { action: 'report', reason: 'name-missing' };

  let phone = rawPhone;
  let phoneCarriedAsTyped = false;
  try {
    phone = normalizeE164(rawPhone) ?? rawPhone;
  } catch {
    phoneCarriedAsTyped = true;
  }
  const relationship = str(kinfolk['emergencyContactRelation']) || null;
  const dated = recordedAtForLegacy(kinfolk);
  return {
    action: 'migrate',
    contact: { name, phone, relationship, recordedAt: dated.value, updatedAt: dated.value },
    dateSource: dated.source,
    phoneCarriedAsTyped,
  };
}

export async function buildPlan(db: Firestore): Promise<Array<{ kinfolkId: string; plan: EcPlan }>> {
  const snap = await db.collection('kinfolk').get();
  return snap.docs.map((d) => ({ kinfolkId: d.id, plan: planEmergencyContactMigration(d.data() as Record<string, unknown>) }));
}

function report(rows: Array<{ kinfolkId: string; plan: EcPlan }>, mode: Mode): void {
  const migrate = rows.filter((r) => r.plan.action === 'migrate');
  console.log('');
  console.log(`=== #829 Emergency Contact migration (${mode.toUpperCase()}) ===`);
  console.log(`kinfolk scanned        : ${rows.length}`);
  console.log(`households to migrate  : ${migrate.length}`);
  console.log(`already migrated       : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'already-has-array').length}`);
  console.log(`nothing to move        : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'no-flat-fields').length}`);
  console.log(`half records (manual)  : ${rows.filter((r) => r.plan.action === 'report').length}`);
  console.log('');
  console.log('-- per household --');
  for (const { kinfolkId, plan } of rows) {
    if (plan.action === 'migrate') {
      const c = plan.contact;
      const when = c.recordedAt ? c.recordedAt.toDate().toISOString() : 'NO DATE (null)';
      console.log(`  kinfolk/${kinfolkId}  emergencyContacts: [] -> [{ name: "${c.name}", phone: "${c.phone}", relationship: ${c.relationship === null ? 'null' : `"${c.relationship}"`}, recordedAt: ${when} (from ${plan.dateSource ?? 'nothing'}) }]`);
      if (plan.phoneCarriedAsTyped) console.log(`    ! phone is not a valid number, carried exactly as typed`);
    } else if (plan.action === 'report') {
      console.log(`  kinfolk/${kinfolkId}  NOT WRITTEN: ${plan.reason}. Fix by hand in the admin.`);
    }
  }
  console.log('');
}

/** Returns how many households were written. Exported for the emulator test. */
export async function applyPlan(db: Firestore, rows: Array<{ kinfolkId: string; plan: EcPlan }>): Promise<number> {
  const targets = rows.filter((r): r is { kinfolkId: string; plan: Extract<EcPlan, { action: 'migrate' }> } => r.plan.action === 'migrate');
  const CHUNK = 200;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = db.batch();
    for (const t of targets.slice(i, i + CHUNK)) {
      batch.update(db.collection('kinfolk').doc(t.kinfolkId), { emergencyContacts: [t.plan.contact] });
    }
    await batch.commit();
  }
  return targets.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !args.allowProd && !emulator) {
    throw new Error('refusing to write without --allow-prod (or FIRESTORE_EMULATOR_HOST)');
  }
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error('a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }
  const projectId = args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();
  const rows = await buildPlan(db);
  report(rows, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const n = await applyPlan(db, rows);
  console.log(`APPLIED: ${n} household(s) migrated. Flat fields left in place until verified.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Add to `mytribe/functions/package.json` `scripts`, after `backfill:household-vet`:

```json
    "backfill:emergency-contacts": "NODE_PATH=node_modules ts-node --project ../scripts/tsconfig.json ../scripts/backfillKinfolkEmergencyContacts.ts",
```

- [ ] **Step 4: Run the tests**

```bash
cd mytribe/functions
npx vitest run ../scripts/test/backfillKinfolkEmergencyContacts.test.ts
firebase emulators:exec --only firestore --project mytribe-rules-test "npx vitest run ../scripts/test/backfillKinfolkEmergencyContacts.emulator.test.ts"
npm run typecheck
```

Expected: unit tests PASS. The emulator run prints `1 passed`; if it prints `1 skipped`, `FIRESTORE_EMULATOR_HOST` did not reach vitest and the run proves nothing. Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add mytribe/scripts/backfillKinfolkEmergencyContacts.ts mytribe/scripts/test/backfillKinfolkEmergencyContacts.test.ts mytribe/scripts/test/backfillKinfolkEmergencyContacts.emulator.test.ts mytribe/functions/package.json
git commit -m "Add the dry-run-first Emergency Contact migration (#829)"
```

Operator runbook step (after release, not in the PR): `cd mytribe/functions && npm run backfill:emergency-contacts`, read the diff (expect 8 to migrate), then `npm run backfill:emergency-contacts -- --allow-prod`.

## Task 5: Admin React, API module and two-slot editor

**Files:**
- Create: `auntieos-admin/src/api/emergencyContacts.ts`, `auntieos-admin/src/api/emergencyContacts.test.ts`
- Create: `auntieos-admin/src/components/EmergencyContactsEditor.tsx`, `EmergencyContactsEditor.css`, `EmergencyContactsEditor.test.tsx`
- Create: `auntieos-admin/src/components/NoEmergencyContactFlag.tsx`

**Interfaces:**
- Consumes: `call<Req, Res>(name, payload)` from `src/lib/fns.ts`; `StatusPill` from `src/components/DenScreenKit`.
- Produces:
  - `EMERGENCY_CONTACT_REQUIRED`, `EMERGENCY_CONTACT_OUTSIDE` (spec strings)
  - `interface EmergencyContact { name: string; phone: string; relationship: string | null; recordedAt: string | null; updatedAt: string | null }`
  - `interface EmergencyContactDraft { name: string; phone: string; relationship: string }`, `EMPTY_EMERGENCY_CONTACT_DRAFT`
  - `emergencyContactsOf(raw: Record<string, unknown> | null | undefined): EmergencyContact[]`
  - `hasEmergencyContact(raw): boolean`
  - `toDrafts(contacts: EmergencyContact[]): EmergencyContactDraft[]` (at least one slot)
  - `isBlankDrafts(drafts): boolean`, `draftsEqual(a, b): boolean`
  - `validateEmergencyContactDrafts(drafts, household: { names: string[]; phones: string[] }): string | null`
  - `listEmergencyContacts(kinfolkId: string): Promise<{ contacts: EmergencyContact[]; canEdit: boolean; legacy: boolean }>`
  - `saveEmergencyContacts(kinfolkId: string, drafts: EmergencyContactDraft[]): Promise<EmergencyContact[]>`
  - `<EmergencyContactsEditor idPrefix value onChange disabled? />`, `<NoEmergencyContactFlag compact? />`

- [ ] **Step 1: Write the failing tests**

`auntieos-admin/src/api/emergencyContacts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  EMERGENCY_CONTACT_OUTSIDE,
  EMERGENCY_CONTACT_REQUIRED,
  draftsEqual,
  emergencyContactsOf,
  hasEmergencyContact,
  isBlankDrafts,
  listEmergencyContacts,
  saveEmergencyContacts,
  toDrafts,
  validateEmergencyContactDrafts,
} from './emergencyContacts';

beforeEach(() => call.mockReset());

const HOUSEHOLD = { names: ['Dana Mercer'], phones: ['(805) 555-0100'] };

describe('emergencyContactsOf', () => {
  it('reads the array in call order, with a Timestamp recordedAt as ISO', () => {
    const ts = { toDate: () => new Date('2026-03-02T10:00:00.000Z') };
    const out = emergencyContactsOf({
      emergencyContacts: [
        { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: ts, updatedAt: ts },
        { name: 'Lee Park', phone: '+18055550177', relationship: null },
      ],
    });
    expect(out.map((c) => c.name)).toEqual(['Rae Mercer', 'Lee Park']);
    expect(out[0].recordedAt).toBe('2026-03-02T10:00:00.000Z');
    expect(out[1].relationship).toBeNull();
  });

  it('falls back to the legacy flat triple until the migration is verified', () => {
    expect(emergencyContactsOf({ emergencyContactName: 'Rae', emergencyContactPhone: '805', emergencyContactRelation: '' })).toEqual([
      { name: 'Rae', phone: '805', relationship: null, recordedAt: null, updatedAt: null },
    ]);
    expect(hasEmergencyContact({ firstName: 'Dana' })).toBe(false);
    expect(hasEmergencyContact({ emergencyContacts: [], emergencyContactPhone: '805' })).toBe(true);
  });
});

describe('drafts', () => {
  it('toDrafts always yields at least one slot, and blank detection ignores whitespace', () => {
    expect(toDrafts([])).toEqual([{ name: '', phone: '', relationship: '' }]);
    expect(isBlankDrafts([{ name: ' ', phone: '', relationship: '' }])).toBe(true);
    expect(draftsEqual([{ name: 'A', phone: '1', relationship: '' }], [{ name: 'A', phone: '1', relationship: '' }])).toBe(true);
  });
});

describe('validateEmergencyContactDrafts', () => {
  it('requires one', () => {
    expect(validateEmergencyContactDrafts([], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_REQUIRED);
    expect(validateEmergencyContactDrafts([{ name: '', phone: '', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_REQUIRED);
  });
  it('needs a name and a phone on every slot', () => {
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '', relationship: '' }], HOUSEHOLD)).toBe('Each Emergency Contact needs a phone number.');
    expect(validateEmergencyContactDrafts([{ name: '', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBe('Each Emergency Contact needs a name.');
  });
  it('refuses the same phone twice and a household member', () => {
    expect(
      validateEmergencyContactDrafts([{ name: 'Rae', phone: '8055550199', relationship: '' }, { name: 'Lee', phone: '(805) 555-0199', relationship: '' }], HOUSEHOLD),
    ).toBe('The two Emergency Contacts need different phone numbers.');
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '+1 805 555 0100', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_OUTSIDE);
    expect(validateEmergencyContactDrafts([{ name: ' dana  MERCER', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBe(EMERGENCY_CONTACT_OUTSIDE);
    expect(validateEmergencyContactDrafts([{ name: 'Rae', phone: '8055550199', relationship: '' }], HOUSEHOLD)).toBeNull();
  });
});

describe('callables', () => {
  it('list trims the id and decodes the answer', async () => {
    call.mockResolvedValue({ contacts: [{ name: 'Rae', phone: '+18055550199', relationship: null, recordedAt: null, updatedAt: null }], canEdit: true, legacy: false });
    const res = await listEmergencyContacts(' fam1 ');
    expect(call).toHaveBeenCalledWith('listEmergencyContacts', { kinfolkId: 'fam1' });
    expect(res.contacts[0].name).toBe('Rae');
  });

  it('save sends name, phone, relationship per slot in order, relationship cleared as null', async () => {
    call.mockResolvedValue({ contacts: [] });
    await saveEmergencyContacts('fam1', [
      { name: ' Rae ', phone: ' 8055550199 ', relationship: '' },
      { name: 'Lee', phone: '8055550177', relationship: ' Neighbour ' },
    ]);
    expect(call).toHaveBeenCalledWith('saveEmergencyContacts', {
      kinfolkId: 'fam1',
      contacts: [
        { name: 'Rae', phone: '8055550199', relationship: null },
        { name: 'Lee', phone: '8055550177', relationship: 'Neighbour' },
      ],
    });
  });

  it('an unreadable answer throws rather than reading as no contacts', async () => {
    call.mockResolvedValue({});
    await expect(listEmergencyContacts('fam1')).rejects.toThrow(/no contacts array/);
  });
});
```

`auntieos-admin/src/components/EmergencyContactsEditor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmergencyContactsEditor } from './EmergencyContactsEditor';
import type { EmergencyContactDraft } from '../api/emergencyContacts';

function Harness({ initial, spy }: { initial: EmergencyContactDraft[]; spy: (d: EmergencyContactDraft[]) => void }) {
  const [value, setValue] = useState(initial);
  return <EmergencyContactsEditor idPrefix="t" value={value} onChange={(d) => { setValue(d); spy(d); }} />;
}

describe('EmergencyContactsEditor', () => {
  it('edits slot one, adds a second, moves it first, and clears a relationship', async () => {
    const spy = vi.fn();
    render(<Harness initial={[{ name: 'Rae', phone: '8055550199', relationship: 'Sister' }]} spy={spy} />);

    expect(screen.queryByRole('button', { name: /remove emergency contact 1/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#t-ec-1-name' }), 'Lee');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#t-ec-1-phone' }), '8055550177');
    expect(screen.queryByRole('button', { name: 'Add a second Emergency Contact' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Call Lee first' }));
    expect((screen.getByLabelText('Name', { selector: '#t-ec-0-name' }) as HTMLInputElement).value).toBe('Lee');

    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#t-ec-1-relationship' }));
    expect(spy.mock.calls.at(-1)?.[0]).toEqual([
      { name: 'Lee', phone: '8055550177', relationship: '' },
      { name: 'Rae', phone: '8055550199', relationship: '' },
    ]);

    await userEvent.click(screen.getByRole('button', { name: /remove emergency contact 2/i }));
    expect(spy.mock.calls.at(-1)?.[0]).toHaveLength(1);
  });

  it('says who gets called, as a tooltip rather than a subtitle', () => {
    render(<EmergencyContactsEditor idPrefix="t" value={[{ name: '', phone: '', relationship: '' }]} onChange={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Emergency Contact 1' })).toHaveAttribute(
      'title',
      'Called only when no kinfolk can be reached. The first one is called first.',
    );
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd auntieos-admin && npx vitest run src/api/emergencyContacts.test.ts src/components/EmergencyContactsEditor.test.tsx
```

Expected: FAIL, imports do not resolve.

- [ ] **Step 3: Implement**

`auntieos-admin/src/api/emergencyContacts.ts`:

```ts
/**
 * Emergency Contacts (#829). Read from the kinfolk doc the admin already loads
 * (array first, the old flat triple as a fallback until the migration is
 * verified); written only through `saveEmergencyContacts`. Nothing here
 * catches: a refused save carries the server's message to the screen.
 */
import { call } from '../lib/fns';

export const EMERGENCY_CONTACTS_MAX = 2;
export const EMERGENCY_CONTACT_REQUIRED = 'A household needs at least one Emergency Contact';
export const EMERGENCY_CONTACT_OUTSIDE = 'An Emergency Contact has to be someone outside the household.';

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

export interface EmergencyContactDraft {
  name: string;
  phone: string;
  relationship: string;
}

export const EMPTY_EMERGENCY_CONTACT_DRAFT: EmergencyContactDraft = { name: '', phone: '', relationship: '' };

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function iso(v: unknown): string | null {
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return typeof v === 'string' && v !== '' ? v : null;
}

export function emergencyContactsOf(raw: Record<string, unknown> | null | undefined): EmergencyContact[] {
  const r = raw ?? {};
  const arr = r['emergencyContacts'];
  if (Array.isArray(arr) && arr.length > 0) {
    return arr
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((o) => ({ name: s(o['name']), phone: s(o['phone']), relationship: s(o['relationship']) || null, recordedAt: iso(o['recordedAt']), updatedAt: iso(o['updatedAt']) }))
      .filter((c) => c.name !== '' || c.phone !== '');
  }
  const name = s(r['emergencyContactName']);
  const phone = s(r['emergencyContactPhone']);
  if (name === '' && phone === '') return [];
  return [{ name, phone, relationship: s(r['emergencyContactRelation']) || null, recordedAt: null, updatedAt: null }];
}

export function hasEmergencyContact(raw: Record<string, unknown> | null | undefined): boolean {
  return emergencyContactsOf(raw).length > 0;
}

export function toDrafts(contacts: EmergencyContact[]): EmergencyContactDraft[] {
  const drafts = contacts.map((c) => ({ name: c.name, phone: c.phone, relationship: c.relationship ?? '' }));
  return drafts.length > 0 ? drafts : [{ ...EMPTY_EMERGENCY_CONTACT_DRAFT }];
}

export function isBlankDrafts(drafts: EmergencyContactDraft[]): boolean {
  return drafts.every((d) => d.name.trim() === '' && d.phone.trim() === '' && d.relationship.trim() === '');
}

export function draftsEqual(a: EmergencyContactDraft[], b: EmergencyContactDraft[]): boolean {
  return a.length === b.length && a.every((d, i) => d.name.trim() === b[i].name.trim() && d.phone.trim() === b[i].phone.trim() && d.relationship.trim() === b[i].relationship.trim());
}

/** Digits for comparison; a 10-digit number gets the US country code. */
export function comparablePhone(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
}

function comparableName(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The same checks the server makes, before the round trip. The server stays
 * authoritative: it also knows every member's phone and name, which a client
 * may not.
 */
export function validateEmergencyContactDrafts(
  drafts: EmergencyContactDraft[],
  household: { names: string[]; phones: string[] },
): string | null {
  if (drafts.length === 0 || isBlankDrafts(drafts)) return EMERGENCY_CONTACT_REQUIRED;
  if (drafts.length > EMERGENCY_CONTACTS_MAX) return 'A household can have at most two Emergency Contacts.';
  if (drafts.some((d) => d.name.trim() === '')) return 'Each Emergency Contact needs a name.';
  if (drafts.some((d) => d.phone.trim() === '')) return 'Each Emergency Contact needs a phone number.';
  if (drafts.length === 2 && comparablePhone(drafts[0].phone) === comparablePhone(drafts[1].phone)) {
    return 'The two Emergency Contacts need different phone numbers.';
  }
  const names = new Set(household.names.map(comparableName).filter((n) => n !== ''));
  const phones = new Set(household.phones.map(comparablePhone).filter((p) => p !== ''));
  if (drafts.some((d) => names.has(comparableName(d.name)) || phones.has(comparablePhone(d.phone)))) {
    return EMERGENCY_CONTACT_OUTSIDE;
  }
  return null;
}

function decode(rows: unknown): EmergencyContact[] {
  if (!Array.isArray(rows)) throw new Error('Emergency Contacts: the server returned no contacts array.');
  return rows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return { name: s(o['name']), phone: s(o['phone']), relationship: s(o['relationship']) || null, recordedAt: iso(o['recordedAt']), updatedAt: iso(o['updatedAt']) };
  });
}

export async function listEmergencyContacts(kinfolkId: string): Promise<{ contacts: EmergencyContact[]; canEdit: boolean; legacy: boolean }> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('listEmergencyContacts requires a household id');
  const res = await call<{ kinfolkId: string }, { contacts?: unknown; canEdit?: unknown; legacy?: unknown }>('listEmergencyContacts', { kinfolkId: id });
  if (!Array.isArray(res.contacts)) throw new Error('listEmergencyContacts returned no contacts array.');
  return { contacts: decode(res.contacts), canEdit: res.canEdit === true, legacy: res.legacy === true };
}

export async function saveEmergencyContacts(kinfolkId: string, drafts: EmergencyContactDraft[]): Promise<EmergencyContact[]> {
  const id = kinfolkId.trim();
  if (id === '') throw new Error('saveEmergencyContacts requires a household id');
  const contacts = drafts.map((d) => ({ name: d.name.trim(), phone: d.phone.trim(), relationship: d.relationship.trim() === '' ? null : d.relationship.trim() }));
  const res = await call<{ kinfolkId: string; contacts: typeof contacts }, { contacts?: unknown }>('saveEmergencyContacts', { kinfolkId: id, contacts });
  return decode(res.contacts);
}
```

`auntieos-admin/src/components/EmergencyContactsEditor.tsx`:

```tsx
import { EMERGENCY_CONTACTS_MAX, EMPTY_EMERGENCY_CONTACT_DRAFT, type EmergencyContactDraft } from '../api/emergencyContacts';
import { GhostButton } from './Buttons';
import './EmergencyContactsEditor.css';

interface Props {
  idPrefix: string;
  value: EmergencyContactDraft[];
  onChange: (next: EmergencyContactDraft[]) => void;
  disabled?: boolean;
}

const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

/** Up to two Emergency Contacts, index 0 called first. Every field clearable. */
export function EmergencyContactsEditor({ idPrefix, value, onChange, disabled = false }: Props) {
  const set = (i: number, patch: Partial<EmergencyContactDraft>) => onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const moveFirst = (i: number) => onChange([value[i], ...value.filter((_, j) => j !== i)]);

  return (
    <div className="ec-editor">
      {value.map((d, i) => {
        const id = `${idPrefix}-ec-${i}`;
        return (
          <fieldset key={i} className="ec-editor__slot" aria-label={`Emergency Contact ${i + 1}`} title={WHO_GETS_CALLED} disabled={disabled}>
            <legend className="ec-editor__legend">{i === 0 ? 'Called first' : 'Called second'}</legend>
            <label htmlFor={`${id}-name`}>Name</label>
            <input id={`${id}-name`} className="inp" value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
            <label htmlFor={`${id}-phone`}>Phone</label>
            <input id={`${id}-phone`} className="inp mono" type="tel" value={d.phone} onChange={(e) => set(i, { phone: e.target.value })} />
            <label htmlFor={`${id}-relationship`}>Relationship (optional)</label>
            <input id={`${id}-relationship`} className="inp" value={d.relationship} onChange={(e) => set(i, { relationship: e.target.value })} />
            <div className="ec-editor__actions">
              {i > 0 && (
                <GhostButton type="button" onClick={() => moveFirst(i)} aria-label={`Call ${d.name.trim() || 'this contact'} first`}>
                  Call first
                </GhostButton>
              )}
              {value.length > 1 && (
                <GhostButton type="button" onClick={() => remove(i)} aria-label={`Remove Emergency Contact ${i + 1}`}>
                  Remove
                </GhostButton>
              )}
            </div>
          </fieldset>
        );
      })}
      {value.length < EMERGENCY_CONTACTS_MAX && (
        <GhostButton type="button" disabled={disabled} onClick={() => onChange([...value, { ...EMPTY_EMERGENCY_CONTACT_DRAFT }])}>
          Add a second Emergency Contact
        </GhostButton>
      )}
    </div>
  );
}
```

`auntieos-admin/src/components/EmergencyContactsEditor.css`:

```css
.ec-editor { display: grid; gap: 12px; }
.ec-editor__slot { display: grid; gap: 6px; border: 1px solid var(--line); border-radius: 12px; padding: 12px; }
.ec-editor__legend { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; }
.ec-editor__actions { display: flex; gap: 8px; justify-content: flex-end; }
```

`auntieos-admin/src/components/NoEmergencyContactFlag.tsx`:

```tsx
import { StatusPill } from './DenScreenKit';

/** Shown wherever a household has no Emergency Contact. Blocks nothing. */
export function NoEmergencyContactFlag({ compact = false }: { compact?: boolean }) {
  return <StatusPill label="No Emergency Contact" tone="warning" size={compact ? 'compact' : undefined} />;
}
```

If `GhostButton` does not forward `aria-label`/`type`/`disabled`, check `src/components/Buttons.tsx` and pass them through its existing prop spread; if `--line` is not a token in `src/styles`, use the token `HouseholdMembers.css` uses for its card border.

- [ ] **Step 4: Run the tests**

```bash
cd auntieos-admin && npx vitest run src/api/emergencyContacts.test.ts src/components/EmergencyContactsEditor.test.tsx && npx tsc --noEmit -p .
```

Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add auntieos-admin/src/api/emergencyContacts.ts auntieos-admin/src/api/emergencyContacts.test.ts auntieos-admin/src/components/EmergencyContactsEditor.tsx auntieos-admin/src/components/EmergencyContactsEditor.css auntieos-admin/src/components/EmergencyContactsEditor.test.tsx auntieos-admin/src/components/NoEmergencyContactFlag.tsx
git commit -m "Admin web: Emergency Contact API module and two-slot editor (#829)"
```

## Task 6: Admin React, profile, edit, Add Kinfolk, directory flag, members copy, Cypress

**Files:**
- Modify: `auntieos-admin/src/api/kinfolkProfile.ts` (type ~line 43, `EMPTY` ~line 63, merge ~line 93)
- Modify: `auntieos-admin/src/api/kinfolkProfileWrite.ts` (+ `kinfolkProfileWrite.test.ts`): remove the three flat keys from `KinfolkEditPatch` (~87), `KINFOLK_EDIT_FIELDS` (~122), `TRIMMED` (~136)
- Modify: `auntieos-admin/src/screens/KinfolkEdit.tsx` (+ `KinfolkEdit.test.tsx`): drop `EMERGENCY_FIELDS` (~139) and the flat form keys (~112, ~252)
- Modify: `auntieos-admin/src/screens/KinfolkProfile.tsx` (+ `KinfolkProfile.test.tsx`): panel at ~459
- Modify: `auntieos-admin/src/components/AddKinfolkDialog.tsx` (+ test)
- Modify: `auntieos-admin/src/api/directory.ts` (`Kinfolk`, ~35), `auntieos-admin/src/screens/Directory.tsx` (`KinfolkCard`) (+ `Directory.test.tsx`)
- Modify: `auntieos-admin/src/api/members.ts` (~82)
- Modify: `auntieos-admin/cypress/e2e/kinfolk-profile.cy.ts` (~95-157)

**Interfaces:**
- Consumes: everything Task 5 produces; `createKinfolk(input): Promise<string>`; `updateKinfolkProfile(id, patch)`.
- Produces: `KinfolkProfile.emergencyContacts: EmergencyContact[]` (replaces the three flat string fields); `Kinfolk.emergencyContacts?: unknown`, `Kinfolk.emergencyContactName?: unknown`, `Kinfolk.emergencyContactPhone?: unknown`.

- [ ] **Step 1: Write the failing tests**

Add to `auntieos-admin/src/screens/KinfolkEdit.test.tsx` a hoisted mock next to the others, and three tests:

```tsx
const { saveEmergencyContacts } = vi.hoisted(() => ({ saveEmergencyContacts: vi.fn() }));
vi.mock('../api/emergencyContacts', async (orig) => ({
  ...(await orig<typeof import('../api/emergencyContacts')>()),
  saveEmergencyContacts,
}));
```

In the FILE-LEVEL `beforeEach` (every existing test in the file renders the screen, so the reset cannot live inside the new `describe`):

```tsx
saveEmergencyContacts.mockReset().mockResolvedValue([]);
```

The edit screen seeds its contacts from the profile it already loads (`getKinfolkProfile` returns `emergencyContacts` after the `mergeKinfolkProfile` change below), the same way Android seeds from `populateEditForm` and desktop from `existing`. The `household()` fixture carries the flat `emergencyContactName: 'Rae Halbrook'`, which the fallback reads as the one contact.

```tsx
describe('Emergency Contacts on the edit form (#829)', () => {
  it('the profile write no longer carries any flat emergencyContact key', () => {
    expect(KINFOLK_EDIT_FIELDS).not.toContain('emergencyContactName');
    expect(KINFOLK_EDIT_FIELDS).not.toContain('emergencyContactPhone');
    expect(KINFOLK_EDIT_FIELDS).not.toContain('emergencyContactRelation');
  });

  it('adds a second contact and saves both through the callable, in order', async () => {
    getKinfolkProfile.mockResolvedValue(household());
    updateKinfolkProfile.mockResolvedValue(undefined);
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('Rae Halbrook');
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#kfedit-ec-1-name' }), 'Lee Park');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#kfedit-ec-1-phone' }), '5125550177');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(saveEmergencyContacts).toHaveBeenCalledTimes(1));
    expect(saveEmergencyContacts).toHaveBeenCalledWith('kf1', [
      { name: 'Rae Halbrook', phone: '512-555-9090', relationship: '' },
      { name: 'Lee Park', phone: '5125550177', relationship: '' },
    ]);
    expect(updateKinfolkProfile.mock.calls[0][1]).not.toHaveProperty('emergencyContactName');
  });

  it("refuses the household's own phone before any write, with the spec message", async () => {
    getKinfolkProfile.mockResolvedValue(household());
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={vi.fn()} onCancel={vi.fn()} />);
    const phone = await screen.findByLabelText('Phone', { selector: '#kfedit-ec-0-phone' });
    await userEvent.clear(phone);
    await userEvent.type(phone, '(512) 555-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('An Emergency Contact has to be someone outside the household.')).toBeInTheDocument();
    expect(updateKinfolkProfile).not.toHaveBeenCalled();
    expect(saveEmergencyContacts).not.toHaveBeenCalled();
  });

  it('a household with none can still save unrelated edits, and shows the flag', async () => {
    getKinfolkProfile.mockResolvedValue(household({ emergencyContactName: '', emergencyContactPhone: '' }));
    updateKinfolkProfile.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<KinfolkEdit kinfolkId="kf1" kinfolkName="Jamie Halbrook" onDone={onDone} onCancel={vi.fn()} />);
    expect(await screen.findByText('No Emergency Contact')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateKinfolkProfile).toHaveBeenCalledTimes(1));
    expect(saveEmergencyContacts).not.toHaveBeenCalled();
  });
});
```

Add to `auntieos-admin/src/screens/KinfolkProfile.test.tsx`:

```tsx
describe('Emergency Contacts panel (#829)', () => {
  it('lists both contacts in call order under Emergency Contacts', async () => {
    getKinfolkProfile.mockResolvedValue(
      mergeKinfolkProfile('kf1', {
        firstName: 'Jamie',
        lastName: 'Halbrook',
        emergencyContacts: [
          { name: 'Rae Halbrook', phone: '+15125559090', relationship: 'Sister' },
          { name: 'Lee Park', phone: '+15125550177', relationship: null },
        ],
      }),
    );
    renderProfile();
    const panel = (await screen.findByText('Emergency Contacts')).closest('section') as HTMLElement;
    const names = within(panel).getAllByTestId('ec-name').map((n) => n.textContent);
    expect(names).toEqual(['Rae Halbrook', 'Lee Park']);
    expect(within(panel).queryByText('No Emergency Contact')).toBeNull();
  });

  it('flags a household with none, and still renders the panel', async () => {
    getKinfolkProfile.mockResolvedValue(mergeKinfolkProfile('kf1', { firstName: 'Jamie', lastName: 'Halbrook' }));
    renderProfile();
    const panel = (await screen.findByText('Emergency Contacts')).closest('section') as HTMLElement;
    expect(within(panel).getByText('No Emergency Contact')).toBeInTheDocument();
  });
});
```

(`renderProfile` is the file's existing render helper; if the file names it differently, use that helper, and import `mergeKinfolkProfile` from `../api/kinfolkProfile` if it is not already imported. If `DenPanel` does not render a `<section>`, use the panel's root selector that the existing `Contact` panel assertions in this file use.)

Add to `auntieos-admin/src/components/AddKinfolkDialog.test.tsx` (extend the hoisted block with `saveEmergencyContacts: vi.fn()` and mock `../api/emergencyContacts` the same way `../api/directoryWrite` is mocked; reset it in `beforeEach`):

```tsx
async function fillHousehold() {
  await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
  await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
  await userEvent.type(screen.getByLabelText('Phone'), '(512) 555-1234');
}

it('requires an Emergency Contact before anything is created', async () => {
  render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
  await fillHousehold();
  await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
  expect(await screen.findByText('A household needs at least one Emergency Contact')).toBeInTheDocument();
  expect(createKinfolk).not.toHaveBeenCalled();
});

it('creates the household, then saves its contact', async () => {
  createKinfolk.mockResolvedValue('new-kf-1');
  saveEmergencyContacts.mockResolvedValue([]);
  const onCreated = vi.fn();
  render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);
  await fillHousehold();
  await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
  await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
  await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kf-1'));
  expect(saveEmergencyContacts).toHaveBeenCalledWith('new-kf-1', [{ name: 'Rae Halbrook', phone: '5125559090', relationship: '' }]);
});

it('when the contact save fails, says so and retries only the contact, never a second household', async () => {
  createKinfolk.mockResolvedValue('new-kf-1');
  saveEmergencyContacts.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([]);
  const onCreated = vi.fn();
  render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);
  await fillHousehold();
  await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
  await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
  await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
  expect(await screen.findByText(/saveEmergencyContacts failed: network/)).toBeInTheDocument();
  expect(onCreated).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contact' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kf-1'));
  expect(createKinfolk).toHaveBeenCalledTimes(1);
});
```

Add to `auntieos-admin/src/screens/Directory.test.tsx` (inside the existing kinfolk-card `describe`, using its `kinfolkRow` and the `useCollection` stub the neighbouring card tests use):

```tsx
it('#829 flags a household card with no Emergency Contact, and only that one', () => {
  kinfolkAsync = {
    status: 'ready',
    data: [
      kinfolkRow({ _id: 'kf1', firstName: 'Jamie', lastName: 'Halbrook' }),
      kinfolkRow({ _id: 'kf2', firstName: 'Dana', lastName: 'Mercer', emergencyContacts: [{ name: 'Rae', phone: '+18055550199' }] }),
      kinfolkRow({ _id: 'kf3', firstName: 'Lee', lastName: 'Park', emergencyContactPhone: '805-555-0100' }),
    ],
  };
  kinAsync = { status: 'ready', data: [] };
  render(<Directory />);
  expect(screen.getAllByText('No Emergency Contact')).toHaveLength(1);
});
```

(`kinfolkAsync` and `kinAsync` are the file-level variables the `beforeEach` routes `useCollection` to.)

Existing test to update in `AddKinfolkDialog.test.tsx`: `'creates the household with the trimmed fields and reports success via onCreated'` fills no Emergency Contact, so after this task it stops at the required check. Before its Add click, add

```tsx
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
```

and `saveEmergencyContacts.mockResolvedValue([])` at its top. Do the same for any other test in that file that expects `createKinfolk` to be called.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd auntieos-admin && npx vitest run src/screens/KinfolkEdit.test.tsx src/screens/KinfolkProfile.test.tsx src/components/AddKinfolkDialog.test.tsx src/screens/Directory.test.tsx
```

Expected: FAIL on every new case (flat keys still in `KINFOLK_EDIT_FIELDS`, no editor ids, no flag).

- [ ] **Step 3: Implement**

`auntieos-admin/src/api/kinfolkProfile.ts`: remove the three `emergencyContact*: string` fields from `KinfolkProfile`, `EMPTY`, and `mergeKinfolkProfile`; add

```ts
import { emergencyContactsOf, type EmergencyContact } from './emergencyContacts';
// in KinfolkProfile:
  /** Array first, the old flat triple as a fallback until the #829 migration is verified. Index 0 is called first. */
  emergencyContacts: EmergencyContact[];
// in EMPTY:
  emergencyContacts: [],
// in mergeKinfolkProfile's returned object:
    emergencyContacts: emergencyContactsOf(r),
```

`auntieos-admin/src/api/kinfolkProfileWrite.ts`: delete the three keys from `KinfolkEditPatch`, `KINFOLK_EDIT_FIELDS` and `TRIMMED`, and add above `KINFOLK_EDIT_FIELDS`:

```ts
// NO EMERGENCY CONTACT FIELDS (#829). They are written only by the
// `saveEmergencyContacts` callable, which validates them against the household.
```

Update `kinfolkProfileWrite.test.ts`: remove the three keys from any expected field list or patch fixture there.

`auntieos-admin/src/screens/KinfolkEdit.tsx`:

```tsx
import { EmergencyContactsEditor } from '../components/EmergencyContactsEditor';
import { NoEmergencyContactFlag } from '../components/NoEmergencyContactFlag';
import {
  draftsEqual,
  isBlankDrafts,
  saveEmergencyContacts,
  toDrafts,
  validateEmergencyContactDrafts,
  type EmergencyContactDraft,
} from '../api/emergencyContacts';

// inside the component, beside the other state:
const [ecDrafts, setEcDrafts] = useState<EmergencyContactDraft[]>(toDrafts([]));
const [ecBaseline, setEcBaseline] = useState<EmergencyContactDraft[]>(toDrafts([]));

// Seeded from the profile this screen already loads, in the same place the
// form state is seeded from `loaded` (no second read, no callable).
useEffect(() => {
  if (loaded.status !== 'ready') return;
  setEcDrafts(toDrafts(loaded.data.emergencyContacts));
  setEcBaseline(toDrafts(loaded.data.emergencyContacts));
}, [loaded]);
```

(If `Async` names its success state differently from `status: 'ready'` / `data`, use the names the existing form-seeding effect in this file uses.)

Delete the three keys from the form state builder (~112) and the patch (~252). In the save handler, before `setSaving(true)`:

```tsx
const ecChanged = !draftsEqual(ecDrafts, ecBaseline);
// A household that has none and is not adding one right now is not blocked
// from saving anything else (#829). Everyone else must end with a valid list.
const ecSkipped = isBlankDrafts(ecBaseline) && isBlankDrafts(ecDrafts);
if (!ecSkipped && ecChanged) {
  const ecError = validateEmergencyContactDrafts(ecDrafts, {
    names: [`${form.firstName} ${form.lastName}`],
    phones: [form.phoneNumber, form.secondaryPhone],
  });
  if (ecError) {
    setError(ecError);
    return;
  }
}
```

After `await updateKinfolkProfile(kinfolkId, patch);`:

```tsx
if (!ecSkipped && ecChanged) {
  try {
    await saveEmergencyContacts(kinfolkId, ecDrafts);
    setEcBaseline(ecDrafts);
  } catch (err) {
    setSaving(false);
    setError(`saveEmergencyContacts failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    return;
  }
}
```

Replace the `EMERGENCY_FIELDS.map(...)` block (~465) with:

```tsx
{isBlankDrafts(ecBaseline) && <NoEmergencyContactFlag />}
<EmergencyContactsEditor idPrefix="kfedit" value={ecDrafts} onChange={setEcDrafts} disabled={saving} />
```

`auntieos-admin/src/screens/KinfolkProfile.tsx`, replace the conditional panel at ~459:

```tsx
<DenPanel title="Emergency Contacts">
  {p.emergencyContacts.length === 0 ? (
    <NoEmergencyContactFlag />
  ) : (
    <ol className="kprofile__ec-list">
      {p.emergencyContacts.map((c, i) => (
        <li key={`${c.phone}-${i}`}>
          <dl className="kprofile__facts">
            <Fact label={i === 0 ? 'Called first' : 'Called second'} value={c.name} testId="ec-name" />
            <Fact label="Phone" value={c.phone} mono />
            <Fact label="Relationship" value={c.relationship ?? ''} />
          </dl>
        </li>
      ))}
    </ol>
  )}
</DenPanel>
```

If `Fact` takes no `testId`, add `testId?: string` to it and put `data-testid={testId}` on its value element.

`auntieos-admin/src/components/AddKinfolkDialog.tsx`:

```tsx
import { EmergencyContactsEditor } from './EmergencyContactsEditor';
import { saveEmergencyContacts, toDrafts, validateEmergencyContactDrafts, type EmergencyContactDraft } from '../api/emergencyContacts';

const [ecDrafts, setEcDrafts] = useState<EmergencyContactDraft[]>(toDrafts([]));
/** Set once the household exists, so a failed contact save retries the contact alone. */
const [createdId, setCreatedId] = useState<string | null>(null);

async function saveContact(id: string) {
  try {
    await saveEmergencyContacts(id, ecDrafts);
    setSaving(false);
    onCreated(id);
  } catch (err) {
    setSaving(false);
    setSaveError(
      `saveEmergencyContacts failed: ${err instanceof Error ? err.message : 'Save failed'}. The household was created and shows No Emergency Contact until this is saved.`,
    );
  }
}

async function handleSave() {
  setTouched({ firstName: true, lastName: true });
  if (saving) return;
  if (createdId !== null) {
    setSaving(true);
    setSaveError(null);
    await saveContact(createdId);
    return;
  }
  if (firstName.trim() === '' || lastName.trim() === '') return;
  const ecError = validateEmergencyContactDrafts(ecDrafts, { names: [`${firstName} ${lastName}`], phones: [phoneNumber] });
  if (ecError) {
    setSaveError(ecError);
    return;
  }
  setSaving(true);
  setSaveError(null);
  let id: string;
  try {
    id = await createKinfolk({ firstName, lastName, phoneNumber, email, status, serviceAddress });
  } catch (err) {
    setSaving(false);
    setSaveError(`createKinfolk failed: ${err instanceof Error ? err.message : 'Create failed'}`);
    return;
  }
  setCreatedId(id);
  await saveContact(id);
}
```

In the form, after the address field:

```tsx
<div className="add-kinfolk__section">
  <h3 className="add-kinfolk__label">Emergency Contact</h3>
  <EmergencyContactsEditor idPrefix="add-kinfolk" value={ecDrafts} onChange={setEcDrafts} disabled={saving} />
</div>
```

The primary button label becomes `{createdId !== null ? 'Save Emergency Contact' : 'Add kinfolk'}`, and the household fields get `disabled={saving || createdId !== null}` so the retry cannot edit a household that already exists.

`auntieos-admin/src/api/directory.ts`, in `Kinfolk`:

```ts
  /** #829. Read through `hasEmergencyContact`; typed unknown like `tags`. */
  emergencyContacts?: unknown;
  /** Legacy flat fields, read only as a fallback until the migration is verified. */
  emergencyContactName?: unknown;
  emergencyContactPhone?: unknown;
```

`auntieos-admin/src/screens/Directory.tsx`, in `KinfolkCard` beside `<CardBadge ... />`:

```tsx
{!hasEmergencyContact(kf as unknown as Record<string, unknown>) && (
  <span className="directory__ec-flag">
    <NoEmergencyContactFlag compact />
  </span>
)}
```

with the imports `hasEmergencyContact` from `../api/emergencyContacts` and `NoEmergencyContactFlag` from `../components/NoEmergencyContactFlag`. Add to `Directory.css`: `.directory__ec-flag { display: inline-flex; margin-top: 6px; }`.

`auntieos-admin/src/api/members.ts` ~82:

```ts
    description: 'Sees and edits the household home details: entry notes and Emergency Contacts.',
```

`auntieos-admin/cypress/e2e/kinfolk-profile.cy.ts`: remove the three `emergencyContact*` entries from `WRITTEN_FIELDS`, replace the three `#kfedit-emergencyContact*` lines in `before()` with the block below, and add a `CALLABLE` helper at the top of the file (`const CALLABLE = (name: string) => \`**/us-central1/${name}\`;`) if it is not already declared there:

```ts
      cy.intercept('POST', CALLABLE('listEmergencyContacts'), {
        statusCode: 200,
        body: { result: { contacts: [], canEdit: true, legacy: false } },
      });
      cy.intercept('POST', CALLABLE('saveEmergencyContacts'), {
        statusCode: 200,
        body: { result: { contacts: [{ name: 'Priya Shah', phone: '+18055550199', relationship: 'Sister', recordedAt: null, updatedAt: null }] } },
      }).as('saveEmergencyContacts');
```

(the two intercepts go before `cy.visit`), and after the tag typing:

```ts
      cy.get('#kfedit-ec-0-name').clear().type('Priya Shah');
      cy.get('#kfedit-ec-0-phone').clear().type('8055550199');
      cy.get('#kfedit-ec-0-relationship').clear().type('Sister');
      cy.contains('button', 'Save changes').click();
      cy.wait('@saveEmergencyContacts')
        .its('request.body.data')
        .should('deep.equal', {
          kinfolkId: 'e2e-kf-1',
          contacts: [{ name: 'Priya Shah', phone: '8055550199', relationship: 'Sister' }],
        });
```

Keep the `#680` test as is: the panel title stays "Emergency Contacts".

- [ ] **Step 4: Run the tests**

```bash
cd auntieos-admin
npx vitest run src/screens/KinfolkEdit.test.tsx src/screens/KinfolkProfile.test.tsx src/components/AddKinfolkDialog.test.tsx src/screens/Directory.test.tsx src/api/kinfolkProfileWrite.test.ts src/api/emergencyContacts.test.ts
npm test
npm run e2e:cy:tsc
```

Expected: every listed file PASSES; the full admin suite PASSES (fix any remaining fixture that still reads `p.emergencyContactName`); the Cypress typecheck exits 0. The Cypress run itself goes through CI (`npm run e2e:cy:run` locally needs the emulator; check `lsof -i :9399 -i :8385` first).

- [ ] **Step 5: Commit**

```bash
git add auntieos-admin/src auntieos-admin/cypress/e2e/kinfolk-profile.cy.ts
git commit -m "Admin web: Emergency Contacts on profile, edit, Add Kinfolk and the directory (#829)"
```

## Task 7: Admin Android

Paths below are under `auntieos-admin/android/app/src/` with package dir `java/com/tribetails/auntieos/`.

**Files:**
- Create: `main/.../data/model/EmergencyContacts.kt`
- Modify: `main/.../data/model/Models.kt` (`Kinfolk`, ~line 217)
- Modify: `main/.../ui/directory/DirectoryFieldChanges.kt` (`KINFOLK_DIFF_FIELDS` ~89, `KINFOLK_SERVER_OWNED`)
- Modify: `main/.../data/repository/AuntieRepository.kt` (beside `inviteKinfolkToPortal`, ~line 428)
- Modify: `main/.../ui/directory/DirectoryViewModel.kt` (`AddKinfolkUiState` ~214, `EditKinfolkUiState` ~247, updaters ~733 and ~811, `saveKinfolk` ~737, `populateEditForm` ~1001, `saveKinfolkChanges` ~1053, `buildKinfolkFromEditState` ~1195)
- Create: `main/.../ui/directory/EmergencyContactsEditor.kt`
- Modify: `main/.../ui/directory/EditKinfolkScreen.kt` (~308-330, save enablement ~561), `AddKinfolkScreen.kt` (~195-230, ~276)
- Modify: `main/.../ui/directory/KinfolkProfileScreen.kt` (~164, `EmergencyContactsPanel` ~556), `DirectoryScreen.kt` (`KinfolkDirectoryCard` ~443)
- Modify: `main/.../ui/admin/KinCareDetailScreen.kt` (~436), `main/.../ui/kintales/KinTaleTemplateEngine.kt` (~145)
- Modify: `main/.../ui/members/HouseholdMembersScreen.kt` (~1092)
- Create: `test/.../data/model/EmergencyContactsTest.kt`, `test/.../ui/directory/DirectoryViewModelEmergencyContactsTest.kt`, `test/.../ui/directory/EmergencyContactsEditorUiTest.kt`

**Interfaces:**
- Consumes: `saveEmergencyContacts` / `listEmergencyContacts` wire shapes from Task 1; `FirebaseFunctions` via `AuntieRepository.functions`; `awaitCallable()`; `isValidPhone(raw)` in `util/FieldValidators.kt`.
- Produces:
  - `data class EmergencyContact(val name: String, val phone: String, val relationship: String?, val recordedAt: String?, val updatedAt: String?)`
  - `data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")`
  - `data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)`
  - `const val EMERGENCY_CONTACT_REQUIRED`, `const val EMERGENCY_CONTACT_OUTSIDE`
  - `fun emergencyContactsOf(kinfolk: Kinfolk): List<EmergencyContact>`
  - `fun List<EmergencyContact>.toDrafts(): List<EmergencyContactDraft>`, `fun List<EmergencyContactDraft>.isBlankDrafts(): Boolean`, `fun draftsEqual(a, b): Boolean`
  - `fun validateEmergencyContactDrafts(drafts: List<EmergencyContactDraft>, householdNames: List<String>, householdPhones: List<String>): String?`
  - `fun decodeEmergencyContacts(raw: Map<String, Any?>): List<EmergencyContact>`
  - `AuntieRepository.listEmergencyContacts(kinfolkId: String): Result<EmergencyContactsResult>`, `AuntieRepository.saveEmergencyContacts(kinfolkId: String, drafts: List<EmergencyContactDraft>): Result<List<EmergencyContact>>`
  - `DirectoryViewModel.updateAddEmergencyContact(index, draft)`, `addAddEmergencyContact()`, `removeAddEmergencyContact(index)`, `moveAddEmergencyContactFirst(index)`, and the same four with `Edit` in place of `Add`
  - `@Composable fun EmergencyContactsEditor(drafts: List<EmergencyContactDraft>, onChange: (Int, EmergencyContactDraft) -> Unit, onAdd: () -> Unit, onRemove: (Int) -> Unit, onMoveFirst: (Int) -> Unit, enabled: Boolean = true)`

- [ ] **Step 1: Write the failing tests**

`test/java/com/tribetails/auntieos/data/model/EmergencyContactsTest.kt`:

```kotlin
package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EmergencyContactsTest {

    private val household = listOf("Dana Mercer") to listOf("(805) 555-0100")

    @Test
    fun `reads the array in call order`() {
        val k = Kinfolk(
            emergencyContacts = listOf(
                mapOf("name" to "Rae Mercer", "phone" to "+18055550199", "relationship" to "Sister"),
                mapOf("name" to "Lee Park", "phone" to "+18055550177", "relationship" to null),
            ),
        )
        assertEquals(listOf("Rae Mercer", "Lee Park"), emergencyContactsOf(k).map { it.name })
        assertNull(emergencyContactsOf(k)[1].relationship)
    }

    @Test
    fun `falls back to the flat triple until the migration is verified`() {
        val k = Kinfolk(emergencyContactName = "Rae", emergencyContactPhone = "805", emergencyContactRelation = "")
        assertEquals(listOf(EmergencyContact("Rae", "805", null, null, null)), emergencyContactsOf(k))
        assertTrue(emergencyContactsOf(Kinfolk()).isEmpty())
    }

    @Test
    fun `a malformed stored value reads as none instead of crashing the profile`() {
        assertTrue(emergencyContactsOf(Kinfolk(emergencyContacts = "not a list")).isEmpty())
    }

    @Test
    fun `validation mirrors the server`() {
        val (names, phones) = household
        assertEquals(EMERGENCY_CONTACT_REQUIRED, validateEmergencyContactDrafts(listOf(EmergencyContactDraft()), names, phones))
        assertEquals("Each Emergency Contact needs a phone number.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft(name = "Rae")), names, phones))
        assertEquals(
            "The two Emergency Contacts need different phone numbers.",
            validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199"), EmergencyContactDraft("Lee", "(805) 555-0199")), names, phones),
        )
        assertEquals(EMERGENCY_CONTACT_OUTSIDE, validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "+1 805 555 0100")), names, phones))
        assertEquals(EMERGENCY_CONTACT_OUTSIDE, validateEmergencyContactDrafts(listOf(EmergencyContactDraft(" dana  MERCER", "8055550199")), names, phones))
        assertNull(validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199")), names, phones))
    }

    @Test
    fun `decode refuses a payload with no contacts array`() {
        val err = runCatching { decodeEmergencyContacts(emptyMap()) }.exceptionOrNull()
        assertTrue(err?.message.orEmpty().contains("no contacts array"))
    }
}
```

`test/java/com/tribetails/auntieos/ui/directory/DirectoryViewModelEmergencyContactsTest.kt`:

```kotlin
package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_REQUIRED
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelEmergencyContactsTest {

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk(relaxed = true), mockk(relaxed = true))
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `add refuses to create a household without an Emergency Contact`() {
        vm.updateFirstName("Jamie")
        vm.saveKinfolk()
        assertEquals(EMERGENCY_CONTACT_REQUIRED, vm.addKinfolkState.value.error)
        coVerify(exactly = 0) { repo.createKinfolkComplete(any()) }
    }

    @Test
    fun `add creates the household, then saves the contact against the new id`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returns Result.success(emptyList())
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        coVerify { repo.saveEmergencyContacts("kf-new", listOf(EmergencyContactDraft("Rae Halbrook", "5125559090"))) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    @Test
    fun `a failed contact save keeps the new id so a retry never creates a second household`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returnsMany listOf(Result.failure(Exception("offline")), Result.success(emptyList()))
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        assertEquals("kf-new", vm.addKinfolkState.value.createdKinfolkId)
        assertTrue(vm.addKinfolkState.value.error.orEmpty().startsWith("saveEmergencyContacts failed"))
        vm.saveKinfolk()
        coVerify(exactly = 1) { repo.createKinfolkComplete(any()) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    @Test
    fun `edit with no other change still saves a changed contact list, and never puts it in the diff`() {
        val stored = Kinfolk(id = "kf1", firstName = "Jamie", phoneNumber = "5125551234", emergencyContactName = "Rae", emergencyContactPhone = "5125559090")
        coEvery { repo.getKinfolkById("kf1") } returns Result.success(stored)
        coEvery { repo.saveEmergencyContacts("kf1", any()) } returns Result.success(emptyList())
        vm.loadKinfolkForEdit("kf1")
        vm.addEditEmergencyContact()
        vm.updateEditEmergencyContact(1, EmergencyContactDraft("Lee Park", "5125550177"))
        vm.saveKinfolkChanges()
        coVerify(exactly = 0) { repo.updateKinfolkFields(any(), any()) }
        coVerify { repo.saveEmergencyContacts("kf1", listOf(EmergencyContactDraft("Rae", "5125559090"), EmergencyContactDraft("Lee Park", "5125550177"))) }
    }

    @Test
    fun `a household with none saves unrelated edits without being asked for one`() {
        val stored = Kinfolk(id = "kf1", firstName = "Jamie", phoneNumber = "5125551234")
        coEvery { repo.getKinfolkById("kf1") } returns Result.success(stored)
        coEvery { repo.updateKinfolkFields("kf1", any()) } returns Result.success(Unit)
        vm.loadKinfolkForEdit("kf1")
        vm.updateEditFirstName("Jamey")
        vm.saveKinfolkChanges()
        coVerify { repo.updateKinfolkFields("kf1", mapOf("firstName" to "Jamey")) }
        coVerify(exactly = 0) { repo.saveEmergencyContacts(any(), any()) }
        assertFalse(vm.editKinfolkState.value.error != null)
    }
}
```

Existing add-path tests that expect `createKinfolkComplete` to succeed now stop at the required check. In `DirectoryViewModelExtTest.kt` (`saveKinfolk sets error when repository fails`, `saveKinfolk sets isSuccess on repository success`), `DirectoryViewModelArchiveTest.kt` (`saveKinfolk defaults blank status to prospect`, `saveKinfolk respects explicit status`) and `DirectoryViewModelAuditLogTest.kt` (`saveKinfolk fires CREATE_KINFOLK audit entry`, `failed save does NOT fire audit entry`), add before `saveKinfolk()`:

```kotlin
        coEvery { repository.saveEmergencyContacts(any(), any()) } returns Result.success(emptyList())
        viewModel.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
```

(using each file's own names for the mock and the view model: `mockRepo`/`vm` in `DirectoryViewModelExtTest.kt`). The two `requires non-blank first name` tests stay as they are: the first-name check still runs before the Emergency Contact check.

Before running, open `DirectoryViewModel.kt` around line 940 and use the real names of the edit loader (`loadKinfolkForEdit` above) and the add-form first-name updater (`updateFirstName` above) and the public state flows (`addKinfolkState`, `editKinfolkState`); if a name differs, change the test to the real name, not the view model.

`test/java/com/tribetails/auntieos/ui/directory/EmergencyContactsEditorUiTest.kt`:

```kotlin
package com.tribetails.auntieos.ui.directory

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class EmergencyContactsEditorUiTest {

    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun addsASecondSlotMovesItFirstAndRemovesIt() {
        val drafts = mutableStateListOf(EmergencyContactDraft("Rae", "8055550199"))
        composeRule.setContent {
            AuntieOSTheme {
                EmergencyContactsEditor(
                    drafts = drafts,
                    onChange = { i, d -> drafts[i] = d },
                    onAdd = { drafts.add(EmergencyContactDraft()) },
                    onRemove = { drafts.removeAt(it) },
                    onMoveFirst = { i -> val d = drafts.removeAt(i); drafts.add(0, d) },
                )
            }
        }
        composeRule.onNodeWithText("Add a second Emergency Contact").performClick()
        assertEquals(2, drafts.size)
        composeRule.onNodeWithText("Called second").assertExists()
        composeRule.onNodeWithText("Call first").performClick()
        assertEquals("", drafts[0].name)
        composeRule.onNodeWithText("Remove", useUnmergedTree = true).performClick()
        assertEquals(1, drafts.size)
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd auntieos-admin/android && ./gradlew testDebugUnitTest --tests 'com.tribetails.auntieos.data.model.EmergencyContactsTest' --tests 'com.tribetails.auntieos.ui.directory.DirectoryViewModelEmergencyContactsTest' --tests 'com.tribetails.auntieos.ui.directory.EmergencyContactsEditorUiTest'
```

Expected: compilation FAILS (`Unresolved reference: emergencyContactsOf`, `emergencyContacts`).

- [ ] **Step 3: Implement**

`main/java/com/tribetails/auntieos/data/model/EmergencyContacts.kt`:

```kotlin
package com.tribetails.auntieos.data.model

/**
 * Emergency Contacts (#829). Read from the kinfolk doc (array first, flat
 * triple as a fallback until the migration is verified), written only through
 * the `saveEmergencyContacts` callable. Index 0 is called first.
 */
const val EMERGENCY_CONTACTS_MAX = 2
const val EMERGENCY_CONTACT_REQUIRED = "A household needs at least one Emergency Contact"
const val EMERGENCY_CONTACT_OUTSIDE = "An Emergency Contact has to be someone outside the household."

data class EmergencyContact(
    val name: String,
    val phone: String,
    val relationship: String?,
    val recordedAt: String?,
    val updatedAt: String?,
)

data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")

data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)

private fun text(v: Any?): String = (v as? String)?.trim().orEmpty()

private fun isoOf(v: Any?): String? = when (v) {
    is com.google.firebase.Timestamp -> java.time.Instant.ofEpochSecond(v.seconds, v.nanoseconds.toLong()).toString()
    is String -> v.ifBlank { null }
    else -> null
}

private fun contactFrom(m: Map<*, *>) = EmergencyContact(
    name = text(m["name"]),
    phone = text(m["phone"]),
    relationship = text(m["relationship"]).ifBlank { null },
    recordedAt = isoOf(m["recordedAt"]),
    updatedAt = isoOf(m["updatedAt"]),
)

fun emergencyContactsOf(kinfolk: Kinfolk): List<EmergencyContact> {
    val arr = (kinfolk.emergencyContacts as? List<*>)
        ?.mapNotNull { (it as? Map<*, *>)?.let(::contactFrom) }
        ?.filter { it.name.isNotBlank() || it.phone.isNotBlank() }
        .orEmpty()
    if (arr.isNotEmpty()) return arr
    if (kinfolk.emergencyContactName.isBlank() && kinfolk.emergencyContactPhone.isBlank()) return emptyList()
    return listOf(
        EmergencyContact(
            kinfolk.emergencyContactName.trim(),
            kinfolk.emergencyContactPhone.trim(),
            kinfolk.emergencyContactRelation.trim().ifBlank { null },
            null,
            null,
        ),
    )
}

fun List<EmergencyContact>.toDrafts(): List<EmergencyContactDraft> =
    map { EmergencyContactDraft(it.name, it.phone, it.relationship.orEmpty()) }.ifEmpty { listOf(EmergencyContactDraft()) }

fun List<EmergencyContactDraft>.isBlankDrafts(): Boolean =
    all { it.name.isBlank() && it.phone.isBlank() && it.relationship.isBlank() }

fun draftsEqual(a: List<EmergencyContactDraft>, b: List<EmergencyContactDraft>): Boolean =
    a.size == b.size && a.zip(b).all { (x, y) ->
        x.name.trim() == y.name.trim() && x.phone.trim() == y.phone.trim() && x.relationship.trim() == y.relationship.trim()
    }

private fun comparablePhone(v: String): String = v.filter(Char::isDigit).let { if (it.length == 10) "1$it" else it }
private fun comparableName(v: String): String = v.trim().lowercase().replace(Regex("\\s+"), " ")

fun validateEmergencyContactDrafts(
    drafts: List<EmergencyContactDraft>,
    householdNames: List<String>,
    householdPhones: List<String>,
): String? {
    if (drafts.isEmpty() || drafts.isBlankDrafts()) return EMERGENCY_CONTACT_REQUIRED
    if (drafts.size > EMERGENCY_CONTACTS_MAX) return "A household can have at most two Emergency Contacts."
    if (drafts.any { it.name.isBlank() }) return "Each Emergency Contact needs a name."
    if (drafts.any { it.phone.isBlank() }) return "Each Emergency Contact needs a phone number."
    if (drafts.size == 2 && comparablePhone(drafts[0].phone) == comparablePhone(drafts[1].phone)) {
        return "The two Emergency Contacts need different phone numbers."
    }
    val names = householdNames.map(::comparableName).filter { it.isNotEmpty() }.toSet()
    val phones = householdPhones.map(::comparablePhone).filter { it.isNotEmpty() }.toSet()
    if (drafts.any { comparableName(it.name) in names || comparablePhone(it.phone) in phones }) return EMERGENCY_CONTACT_OUTSIDE
    return null
}

/** Decodes a callable answer. A missing array is an error, never "none on file". */
fun decodeEmergencyContacts(raw: Map<String, Any?>): List<EmergencyContact> {
    val rows = raw["contacts"] as? List<*> ?: error("Emergency Contacts: no contacts array in the answer")
    return rows.mapNotNull { (it as? Map<*, *>)?.let(::contactFrom) }
}
```

`Models.kt`, in `Kinfolk` directly after the three flat fields (kept, now read-only legacy):

```kotlin
    // #829. The ordered array written ONLY by the saveEmergencyContacts callable.
    // Held raw (Class A pattern, same as `tags`): a list of maps holding
    // Timestamps, absent on every doc until the migration. Read via
    // `emergencyContactsOf`. Never diffed (see KINFOLK_SERVER_OWNED).
    var emergencyContacts: Any? = null,
```

`DirectoryFieldChanges.kt`: delete the three `"emergencyContact*"` lines from `KINFOLK_DIFF_FIELDS`, and add to `KINFOLK_SERVER_OWNED` with a line in its KDoc:

```kotlin
 * - `emergencyContacts` and the legacy `emergencyContactName/Phone/Relation`
 *                    written only by the `saveEmergencyContacts` callable (#829)
```

```kotlin
    "emergencyContacts",
    "emergencyContactName",
    "emergencyContactPhone",
    "emergencyContactRelation",
```

`AuntieRepository.kt`:

```kotlin
    suspend fun listEmergencyContacts(kinfolkId: String): Result<EmergencyContactsResult> = runCatching {
        require(kinfolkId.isNotBlank()) { "listEmergencyContacts requires a household id" }
        authGate.ensureAuthenticated()
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("listEmergencyContacts")
            .call(mapOf("kinfolkId" to kinfolkId)).awaitCallable().data as? Map<String, Any?>
            ?: error("listEmergencyContacts: non-map payload")
        EmergencyContactsResult(decodeEmergencyContacts(raw), raw["canEdit"] == true, raw["legacy"] == true)
    }.onFailure { AuntieLog.e("AuntieRepository.listEmergencyContacts failed", it) }

    suspend fun saveEmergencyContacts(kinfolkId: String, drafts: List<EmergencyContactDraft>): Result<List<EmergencyContact>> = runCatching {
        require(kinfolkId.isNotBlank()) { "saveEmergencyContacts requires a household id" }
        authGate.ensureAuthenticated()
        val contacts = drafts.map {
            mapOf("name" to it.name.trim(), "phone" to it.phone.trim(), "relationship" to it.relationship.trim().ifBlank { null })
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("saveEmergencyContacts")
            .call(mapOf("kinfolkId" to kinfolkId, "contacts" to contacts)).awaitCallable().data as? Map<String, Any?>
            ?: error("saveEmergencyContacts: non-map payload")
        decodeEmergencyContacts(raw)
    }.onFailure { AuntieLog.e("AuntieRepository.saveEmergencyContacts failed", it) }
```

(import `com.tribetails.auntieos.data.model.*` names used above.)

`DirectoryViewModel.kt`:
- `AddKinfolkUiState`: replace `emergencyContactName`/`emergencyContactPhone` with `val emergencyContacts: List<EmergencyContactDraft> = listOf(EmergencyContactDraft())` and add `val createdKinfolkId: String? = null`.
- `EditKinfolkUiState`: replace the three flat fields with `val emergencyContacts: List<EmergencyContactDraft> = listOf(EmergencyContactDraft())` and `val emergencyContactsBaseline: List<EmergencyContactDraft> = listOf(EmergencyContactDraft())`.
- Replace the flat updaters (~733, ~811-813) with:

```kotlin
    private fun List<EmergencyContactDraft>.replaced(i: Int, d: EmergencyContactDraft) = mapIndexed { j, x -> if (j == i) d else x }
    private fun List<EmergencyContactDraft>.movedFirst(i: Int) = listOf(this[i]) + filterIndexed { j, _ -> j != i }

    fun updateAddEmergencyContact(i: Int, d: EmergencyContactDraft) { _addKinfolkState.value = _addKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.replaced(i, d)) } }
    fun addAddEmergencyContact() { _addKinfolkState.value = _addKinfolkState.value.let { if (it.emergencyContacts.size >= EMERGENCY_CONTACTS_MAX) it else it.copy(emergencyContacts = it.emergencyContacts + EmergencyContactDraft()) } }
    fun removeAddEmergencyContact(i: Int) { _addKinfolkState.value = _addKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.filterIndexed { j, _ -> j != i }.ifEmpty { listOf(EmergencyContactDraft()) }) } }
    fun moveAddEmergencyContactFirst(i: Int) { _addKinfolkState.value = _addKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.movedFirst(i)) } }

    fun updateEditEmergencyContact(i: Int, d: EmergencyContactDraft) { _editKinfolkState.value = _editKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.replaced(i, d)) } }
    fun addEditEmergencyContact() { _editKinfolkState.value = _editKinfolkState.value.let { if (it.emergencyContacts.size >= EMERGENCY_CONTACTS_MAX) it else it.copy(emergencyContacts = it.emergencyContacts + EmergencyContactDraft()) } }
    fun removeEditEmergencyContact(i: Int) { _editKinfolkState.value = _editKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.filterIndexed { j, _ -> j != i }.ifEmpty { listOf(EmergencyContactDraft()) }) } }
    fun moveEditEmergencyContactFirst(i: Int) { _editKinfolkState.value = _editKinfolkState.value.let { it.copy(emergencyContacts = it.emergencyContacts.movedFirst(i)) } }
```

- `saveKinfolk()`: at the top, add the retry branch and the validation; drop the flat args from `Kinfolk(...)`; after `onSuccess { saved -> ... }` run the contact save:

```kotlin
    fun saveKinfolk() {
        val state = _addKinfolkState.value
        state.createdKinfolkId?.let { id -> saveNewHouseholdContacts(id, state); return }
        if (state.firstName.isBlank()) {
            _addKinfolkState.value = state.copy(error = "First name is required.")
            return
        }
        validateEmergencyContactDrafts(
            state.emergencyContacts,
            listOf("${state.firstName} ${state.lastName}"),
            listOf(state.phoneNumber, state.secondaryPhone),
        )?.let { _addKinfolkState.value = state.copy(error = it); return }
        // ... existing body, with emergencyContactName/Phone removed from Kinfolk(...),
        // and inside onSuccess, replacing `_addKinfolkState.value = AddKinfolkUiState(isSuccess = true); loadDirectory()`:
        //     saveNewHouseholdContacts(saved.id, state.copy(isSaving = true, createdKinfolkId = saved.id))
    }

    private fun saveNewHouseholdContacts(id: String, state: AddKinfolkUiState) {
        viewModelScope.launch {
            _addKinfolkState.value = state.copy(isSaving = true, error = null, createdKinfolkId = id)
            repository.saveEmergencyContacts(id, state.emergencyContacts).onSuccess {
                _addKinfolkState.value = AddKinfolkUiState(isSuccess = true)
                loadDirectory()
            }.onFailure { e ->
                _addKinfolkState.value = state.copy(
                    isSaving = false,
                    createdKinfolkId = id,
                    error = "saveEmergencyContacts failed: ${e.message ?: "Save failed"}. The household was created and shows No Emergency Contact until this is saved.",
                )
                loadDirectory()
            }
        }
    }
```

- `populateEditForm`: replace the three flat assignments with

```kotlin
            emergencyContacts = emergencyContactsOf(kinfolk).toDrafts(),
            emergencyContactsBaseline = emergencyContactsOf(kinfolk).toDrafts(),
```

- `buildKinfolkFromEditState`: delete the three `emergencyContact* = state...` lines. The baseline copy carries the stored values through, and they are no longer diffed.
- `saveKinfolkChanges()`: replace the `if (changes.isEmpty()) { ... return }` block and the success path so both writes run:

```kotlin
        val ecChanged = !draftsEqual(state.emergencyContacts, state.emergencyContactsBaseline)
        val ecSkipped = state.emergencyContactsBaseline.isBlankDrafts() && state.emergencyContacts.isBlankDrafts()
        if (ecChanged && !ecSkipped) {
            validateEmergencyContactDrafts(
                state.emergencyContacts,
                listOf("${state.firstName} ${state.lastName}"),
                listOf(state.phoneNumber, state.secondaryPhone),
            )?.let { _editKinfolkState.value = state.copy(error = it); return }
        }
        if (changes.isEmpty() && (!ecChanged || ecSkipped)) {
            _editKinfolkState.value = state.copy(isSaving = false, isSuccess = true, error = null)
            return
        }
        viewModelScope.launch {
            _editKinfolkState.value = state.copy(isSaving = true, error = null)
            if (changes.isNotEmpty()) {
                val fieldsResult = repository.updateKinfolkFields(state.kinfolkId, changes)
                if (fieldsResult.isFailure) {
                    // existing onFailure body, unchanged
                    return@launch
                }
                loadedKinfolk = updatedKinfolk
                // existing AuditLog.fire(...) call, unchanged
            }
            if (ecChanged && !ecSkipped) {
                val ecResult = repository.saveEmergencyContacts(state.kinfolkId, state.emergencyContacts)
                if (ecResult.isFailure) {
                    _editKinfolkState.value = state.copy(
                        isSaving = false,
                        error = "saveEmergencyContacts failed: ${ecResult.exceptionOrNull()?.message ?: "Save failed"}",
                    )
                    return@launch
                }
            }
            _editKinfolkState.value = state.copy(isSaving = false, isSuccess = true, emergencyContactsBaseline = state.emergencyContacts)
            loadDirectory()
        }
```

`main/java/com/tribetails/auntieos/ui/directory/EmergencyContactsEditor.kt`:

```kotlin
package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.theme.AuntieTheme

/** Up to two Emergency Contacts, the first called first. Every field clearable (#829). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmergencyContactsEditor(
    drafts: List<EmergencyContactDraft>,
    onChange: (Int, EmergencyContactDraft) -> Unit,
    onAdd: () -> Unit,
    onRemove: (Int) -> Unit,
    onMoveFirst: (Int) -> Unit,
    enabled: Boolean = true,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        drafts.forEachIndexed { i, d ->
            // The explanation is a tooltip on the slot label, never a subtitle
            // (operator ruling 2026-09-11).
            TooltipBox(
                positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
                tooltip = { PlainTooltip { Text("Called only when no kinfolk can be reached. The first one is called first.") } },
                state = rememberTooltipState(),
            ) {
                Text(
                    if (i == 0) "Called first" else "Called second",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.kinfolkOrange,
                )
            }
            AuntieField(value = d.name, onValueChange = { onChange(i, d.copy(name = it)) }, label = "Name", modifier = Modifier.fillMaxWidth())
            AuntieField(value = d.phone, onValueChange = { onChange(i, d.copy(phone = it)) }, label = "Phone", modifier = Modifier.fillMaxWidth())
            AuntieField(value = d.relationship, onValueChange = { onChange(i, d.copy(relationship = it)) }, label = "Relationship (optional)", modifier = Modifier.fillMaxWidth())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (i > 0) TextButton(onClick = { onMoveFirst(i) }, enabled = enabled) { Text("Call first") }
                if (drafts.size > 1) TextButton(onClick = { onRemove(i) }, enabled = enabled) { Text("Remove") }
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            TextButton(onClick = onAdd, enabled = enabled) { Text("Add a second Emergency Contact") }
        }
    }
}
```

`EditKinfolkScreen.kt`: replace the three `AuntieField`s at ~308-326 with

```kotlin
                            EmergencyContactsEditor(
                                drafts = state.emergencyContacts,
                                onChange = viewModel::updateEditEmergencyContact,
                                onAdd = viewModel::addEditEmergencyContact,
                                onRemove = viewModel::removeEditEmergencyContact,
                                onMoveFirst = viewModel::moveEditEmergencyContactFirst,
                                enabled = !state.isSaving,
                            )
```

and in the button `enabled` (~561) delete `&& state.emergencyContactName.isNotBlank() && isValidPhone(state.emergencyContactPhone)` (the view model validates and names the problem). Show `state.error` as the screen already does.

`AddKinfolkScreen.kt`: replace the two `AuntieField`s at ~209-222 with the same editor bound to the `Add` functions; in `canSave` (~276) delete the flat emergency terms; the button label becomes `if (state.createdKinfolkId != null) "Save Emergency Contact" else "Save"`.

`KinfolkProfileScreen.kt`: replace the `if (listOf(...flat...).any { ... })` guard at ~164 with an unconditional `item { EmergencyContactsPanel(kinfolk) }`, and the panel with

```kotlin
@Composable
private fun EmergencyContactsPanel(kinfolk: Kinfolk) {
    val contacts = emergencyContactsOf(kinfolk)
    DenPanel(title = "Emergency Contacts") {
        if (contacts.isEmpty()) {
            AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)
        } else {
            contacts.forEachIndexed { i, c ->
                FieldRows(
                    Field(if (i == 0) "Called first" else "Called second", c.name),
                    Field("Phone", c.phone, mono = true),
                    Field("Relationship", c.relationship.orEmpty()),
                )
            }
        }
    }
}
```

`DirectoryScreen.kt` `KinfolkDirectoryCard`: under the name row add `if (emergencyContactsOf(kf).isEmpty()) AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)`. Use the pill composable `cardBadge` already renders; if it is not named `AuntieStatusPill`, use that one.

`KinCareDetailScreen.kt` ~436:

```kotlin
                val ec = emergencyContactsOf(kf)
                if (ec.isNotEmpty()) {
                    item {
                        DetailSection("Emergency contact") {
                            ec.forEach { c ->
                                FactRow(Lucide.Phone, "Name", c.name)
                                FactRow(Lucide.Phone, "Phone", c.phone)
                                FactRow(Lucide.Phone, "Relationship", c.relationship.orEmpty())
                            }
                        }
                    }
                }
```

`KinTaleTemplateEngine.kt` ~145 (token keys unchanged, so stored templates keep working):

```kotlin
        "emergencyContactName"  -> emergencyContactsOf(kinfolk).firstOrNull()?.name.orEmpty()
        "emergencyContactPhone" -> emergencyContactsOf(kinfolk).firstOrNull()?.phone.orEmpty()
```

`HouseholdMembersScreen.kt` ~1092: `"Sees and edits the household home details: entry notes and Emergency Contacts.",`

- [ ] **Step 4: Run the tests**

```bash
cd auntieos-admin/android
./gradlew testDebugUnitTest --tests 'com.tribetails.auntieos.data.model.EmergencyContactsTest' --tests 'com.tribetails.auntieos.ui.directory.DirectoryViewModelEmergencyContactsTest' --tests 'com.tribetails.auntieos.ui.directory.EmergencyContactsEditorUiTest' --tests 'com.tribetails.auntieos.ui.directory.DirectorySaveTest'
./gradlew testDebugUnitTest
```

Expected: the four named classes PASS, including the `DirectorySaveTest` drift guard; the full suite PASSES. Open the HTML report under `app/build/reports/tests/testDebugUnitTest/index.html` and confirm the new classes ran, rather than trusting the exit code. A manifest-merge `com.composeunstyled.internal` collision is #620 recurring, not this change.

- [ ] **Step 5: Commit**

```bash
git add auntieos-admin/android/app/src
git commit -m "Admin Android: Emergency Contacts through the callable, required on Add Kinfolk (#829)"
```

## Task 8: Admin desktop console (`composeApp`)

The trap on this surface: `platformUpdateKinfolk` calls `JvmFirestoreRest.setDoc`, a PATCH with no `updateMask`, which replaces the whole document. A field the desktop `Kinfolk` model does not carry is deleted on every save, so without this task a desktop edit would wipe `emergencyContacts`. Round-tripping the array through the model would not do either: REST decodes `timestampValue` to an ISO string and would write it back as a string. So the update becomes a merge write whose mask never names `emergencyContacts`, and the create body strips it.

Paths below are under `auntieos-admin/web/composeApp/src/`, package dir `kotlin/com/tribetails/auntieos/web/`.

**Files:**
- Create: `commonMain/.../web/data/EmergencyContacts.kt`
- Modify: `commonMain/.../web/data/FirestoreClient.kt` (`Kinfolk` ~2696; wrappers beside `listAudienceSegments` ~434)
- Modify: `jvmMain/.../web/data/FirestoreInterop.jvm.kt` (~325-328)
- Modify: `jvmMain/.../web/data/JvmFirestoreRest.kt` (`mergeDoc` ~389)
- Create: `commonMain/.../web/screens/directory/EmergencyContactsEditor.kt`
- Modify: `commonMain/.../web/screens/directory/KinfolkEditScreen.kt` (~189-191, ~228-230, validation ~260, dirty ~270, `onSave` ~300)
- Modify: `commonMain/.../web/screens/directory/KinfolkProfileScreen.kt` (~272), `DirectoryScreen.kt` (household card)
- Modify: `commonMain/.../web/screens/sessions/KinCareDetailScreen.kt` (~258), `commonMain/.../web/data/KinTaleConditionEngine.kt` (~158)
- Create: `commonTest/.../web/data/EmergencyContactsTest.kt`, `jvmTest/.../web/data/EmergencyContactsClientTest.kt`

Desktop has no household members screen, so the `home_access` description change does not apply here.

**Interfaces:**
- Consumes: `platformInvokeCallable(name, payloadJson): WriteResult<String>`; `JvmFirestoreRest.mergeDoc(collection, id, modelJson)`, `mergeFieldPaths(plain)`; `JvmFirestoreFixtures.callableResponses`, `lastCallableName`, `lastCallablePayloadJson`, `lastWrite`; `RestWrite(method, collection, id, fields?)`.
- Produces:
  - `@Serializable data class EmergencyContact(val name: String = "", val phone: String = "", val relationship: String? = null, val recordedAt: String? = null, val updatedAt: String? = null)`
  - `data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")`
  - `data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)`
  - `fun emergencyContactsOf(k: Kinfolk): List<EmergencyContact>`, `toDrafts()`, `isBlankDrafts()`, `draftsEqual(a, b)`, `validateEmergencyContactDrafts(drafts, names, phones): String?` (same messages as Android)
  - `fun kinfolkWriteJson(k: Kinfolk): String` (model JSON minus `emergencyContacts`)
  - `Kinfolk.emergencyContacts: JsonElement? = null`
  - `FirestoreClient.listEmergencyContacts(kinfolkId): WriteResult<EmergencyContactsResult>`, `FirestoreClient.saveEmergencyContacts(kinfolkId, drafts): WriteResult<List<EmergencyContact>>`
  - `@Composable fun EmergencyContactsEditor(drafts, onChange, onAdd, onRemove, onMoveFirst, enabled = true)`

- [ ] **Step 1: Write the failing tests**

`commonTest/kotlin/com/tribetails/auntieos/web/data/EmergencyContactsTest.kt`:

```kotlin
package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EmergencyContactsTest {

    @Test
    fun readsTheArrayInCallOrderThenTheFlatFallback() {
        val arr = buildJsonArray {
            add(buildJsonObject { put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", "Sister"); put("recordedAt", "2026-03-02T10:00:00Z") })
            add(buildJsonObject { put("name", "Lee Park"); put("phone", "+18055550177"); put("relationship", JsonNull) })
        }
        val withArray = Kinfolk(emergencyContacts = arr, emergencyContactName = "Old")
        assertEquals(listOf("Rae Mercer", "Lee Park"), emergencyContactsOf(withArray).map { it.name })
        assertNull(emergencyContactsOf(withArray)[1].relationship)

        val legacy = Kinfolk(emergencyContactName = "Rae", emergencyContactPhone = "805")
        assertEquals(listOf(EmergencyContact("Rae", "805", null, null, null)), emergencyContactsOf(legacy))
        assertTrue(emergencyContactsOf(Kinfolk()).isEmpty())
    }

    @Test
    fun theWriteBodyNeverCarriesTheArray() {
        val k = Kinfolk(_id = "kf1", firstName = "Dana", emergencyContacts = buildJsonArray { add(buildJsonObject { put("name", "Rae") }) })
        val body = Json.parseToJsonElement(kinfolkWriteJson(k)).jsonObject
        assertFalse("emergencyContacts" in body)
        assertEquals("Dana", body["firstName"].toString().trim('"'))
        assertFalse(JvmMaskProbe.paths(body).contains("`emergencyContacts`"))
    }

    @Test
    fun validationMirrorsTheServer() {
        val names = listOf("Dana Mercer")
        val phones = listOf("(805) 555-0100")
        assertEquals("A household needs at least one Emergency Contact", validateEmergencyContactDrafts(listOf(EmergencyContactDraft()), names, phones))
        assertEquals("An Emergency Contact has to be someone outside the household.", validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550100")), names, phones))
        assertNull(validateEmergencyContactDrafts(listOf(EmergencyContactDraft("Rae", "8055550199")), names, phones))
    }
}

/** The merge mask rule, restated in common code so the test does not need the jvm REST client. */
private object JvmMaskProbe {
    fun paths(body: kotlinx.serialization.json.JsonObject): List<String> = body.keys.filter { it != "_id" }.map { "`$it`" }
}
```

`jvmTest/kotlin/com/tribetails/auntieos/web/data/EmergencyContactsClientTest.kt`:

```kotlin
package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EmergencyContactsClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
        JvmFirestoreFixtures.lastWrite = null
    }

    @Test
    fun listDecodesContactsAndCanEdit() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listEmergencyContacts" to """{"contacts":[{"name":"Rae","phone":"+18055550199","relationship":null,"recordedAt":null,"updatedAt":null}],"canEdit":true,"legacy":false}""",
        )
        val r = FirestoreClient().listEmergencyContacts("kf1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("Rae", (r as WriteResult.Ok).value.contacts.single().name)
        assertTrue(r.value.canEdit)
    }

    @Test
    fun saveSendsSlotsInOrderWithRelationshipClearedAsNull() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("saveEmergencyContacts" to """{"contacts":[]}""")
        val r = FirestoreClient().saveEmergencyContacts("kf1", listOf(EmergencyContactDraft(" Rae ", "8055550199", ""), EmergencyContactDraft("Lee", "8055550177", "Neighbour")))
        assertTrue(r is WriteResult.Ok)
        assertEquals("saveEmergencyContacts", JvmFirestoreFixtures.lastCallableName)
        assertEquals(
            """{"kinfolkId":"kf1","contacts":[{"name":"Rae","phone":"8055550199","relationship":null},{"name":"Lee","phone":"8055550177","relationship":"Neighbour"}]}""",
            JvmFirestoreFixtures.lastCallablePayloadJson,
        )
    }

    @Test
    fun anUnreadableAnswerIsAnError() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listEmergencyContacts" to """{}""")
        assertTrue(FirestoreClient().listEmergencyContacts("kf1") is WriteResult.Err)
    }

    @Test
    fun aKinfolkUpdateIsAMergeWriteThatNeverNamesTheArray() = runBlocking {
        platformUpdateKinfolk(Kinfolk(_id = "kf1", firstName = "Dana"))
        val w = JvmFirestoreFixtures.lastWrite
        assertEquals("MERGE", w?.method)
        assertEquals("kinfolk", w?.collection)
        assertTrue(w?.fields.orEmpty().isNotEmpty())
        assertTrue("emergencyContacts" !in w?.fields.orEmpty())
    }
}
```

Check `RestWrite` at `FirestoreInterop.jvm.kt:106` for its real property names (`method`, `collection`, `id`, `fields` assumed here); if `lastCallablePayloadJson` records the payload with different key order, assert on the parsed `JsonObject` instead of the string.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd auntieos-admin/web && ./gradlew :composeApp:jvmTest --tests 'com.tribetails.auntieos.web.data.EmergencyContactsTest' --tests 'com.tribetails.auntieos.web.data.EmergencyContactsClientTest'
```

Expected: compilation FAILS (`Unresolved reference: emergencyContactsOf`, `kinfolkWriteJson`).

- [ ] **Step 3: Implement**

`commonMain/kotlin/com/tribetails/auntieos/web/data/EmergencyContacts.kt`:

```kotlin
package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Emergency Contacts (#829). Same rules and messages as the Android admin and the server. */
const val EMERGENCY_CONTACTS_MAX = 2
const val EMERGENCY_CONTACT_REQUIRED = "A household needs at least one Emergency Contact"
const val EMERGENCY_CONTACT_OUTSIDE = "An Emergency Contact has to be someone outside the household."

@Serializable
data class EmergencyContact(
    val name: String = "",
    val phone: String = "",
    val relationship: String? = null,
    val recordedAt: String? = null,
    val updatedAt: String? = null,
)

data class EmergencyContactDraft(val name: String = "", val phone: String = "", val relationship: String = "")

data class EmergencyContactsResult(val contacts: List<EmergencyContact>, val canEdit: Boolean, val legacy: Boolean)

private fun JsonObject.text(key: String): String =
    (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.trim().orEmpty()

fun contactFromJson(o: JsonObject) = EmergencyContact(
    name = o.text("name"),
    phone = o.text("phone"),
    relationship = o.text("relationship").ifBlank { null },
    recordedAt = o.text("recordedAt").ifBlank { null },
    updatedAt = o.text("updatedAt").ifBlank { null },
)

fun emergencyContactsOf(k: Kinfolk): List<EmergencyContact> {
    val arr = (k.emergencyContacts as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.let(::contactFromJson) }
        ?.filter { it.name.isNotBlank() || it.phone.isNotBlank() }
        .orEmpty()
    if (arr.isNotEmpty()) return arr
    if (k.emergencyContactName.isBlank() && k.emergencyContactPhone.isBlank()) return emptyList()
    return listOf(EmergencyContact(k.emergencyContactName.trim(), k.emergencyContactPhone.trim(), k.emergencyContactRelation.trim().ifBlank { null }, null, null))
}

fun List<EmergencyContact>.toDrafts(): List<EmergencyContactDraft> =
    map { EmergencyContactDraft(it.name, it.phone, it.relationship.orEmpty()) }.ifEmpty { listOf(EmergencyContactDraft()) }

fun List<EmergencyContactDraft>.isBlankDrafts(): Boolean = all { it.name.isBlank() && it.phone.isBlank() && it.relationship.isBlank() }

fun draftsEqual(a: List<EmergencyContactDraft>, b: List<EmergencyContactDraft>): Boolean =
    a.size == b.size && a.zip(b).all { (x, y) -> x.name.trim() == y.name.trim() && x.phone.trim() == y.phone.trim() && x.relationship.trim() == y.relationship.trim() }

private fun comparablePhone(v: String) = v.filter(Char::isDigit).let { if (it.length == 10) "1$it" else it }
private fun comparableName(v: String) = v.trim().lowercase().replace(Regex("\\s+"), " ")

fun validateEmergencyContactDrafts(drafts: List<EmergencyContactDraft>, names: List<String>, phones: List<String>): String? {
    if (drafts.isEmpty() || drafts.isBlankDrafts()) return EMERGENCY_CONTACT_REQUIRED
    if (drafts.size > EMERGENCY_CONTACTS_MAX) return "A household can have at most two Emergency Contacts."
    if (drafts.any { it.name.isBlank() }) return "Each Emergency Contact needs a name."
    if (drafts.any { it.phone.isBlank() }) return "Each Emergency Contact needs a phone number."
    if (drafts.size == 2 && comparablePhone(drafts[0].phone) == comparablePhone(drafts[1].phone)) return "The two Emergency Contacts need different phone numbers."
    val n = names.map(::comparableName).filter { it.isNotEmpty() }.toSet()
    val p = phones.map(::comparablePhone).filter { it.isNotEmpty() }.toSet()
    if (drafts.any { comparableName(it.name) in n || comparablePhone(it.phone) in p }) return EMERGENCY_CONTACT_OUTSIDE
    return null
}

private val writeJson = Json { encodeDefaults = true; explicitNulls = true }

/**
 * The kinfolk body a desktop write may send. `emergencyContacts` belongs to the
 * `saveEmergencyContacts` callable; it is removed here so neither the create
 * body nor the update mask can touch it.
 */
fun kinfolkWriteJson(k: Kinfolk): String {
    val obj = writeJson.encodeToJsonElement(Kinfolk.serializer(), k).jsonObject
    return JsonObject(obj - "emergencyContacts").toString()
}
```

If `jsonOut` in `FirestoreInterop.jvm.kt` is configured differently from `writeJson` above (for example `encodeDefaults`), copy its configuration into `writeJson` so the update body is byte-for-byte what it was apart from the removed key.

`FirestoreClient.kt`, in `Kinfolk` after the three flat fields:

```kotlin
    /**
     * #829. Read-only here: written ONLY by the saveEmergencyContacts callable.
     * Raw JSON because REST decodes its Timestamps to strings; `kinfolkWriteJson`
     * removes it from every kinfolk write so a desktop save cannot rewrite or
     * delete it. Read through `emergencyContactsOf`.
     */
    val emergencyContacts: kotlinx.serialization.json.JsonElement? = null,
```

Wrappers, beside `listAudienceSegments`:

```kotlin
    suspend fun listEmergencyContacts(kinfolkId: String): WriteResult<EmergencyContactsResult> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("listEmergencyContacts", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val o = callableJson.parseToJsonElement(r.value).jsonObject
                val rows = o["contacts"] as? kotlinx.serialization.json.JsonArray ?: error("listEmergencyContacts: no contacts array")
                WriteResult.Ok(
                    EmergencyContactsResult(
                        contacts = rows.mapNotNull { (it as? JsonObject)?.let(::contactFromJson) },
                        canEdit = o["canEdit"]?.jsonPrimitive?.booleanOrNull == true,
                        legacy = o["legacy"]?.jsonPrimitive?.booleanOrNull == true,
                    ),
                )
            }.getOrElse { WriteResult.Err(it.message ?: "listEmergencyContacts decode failed") }
        }
    }

    suspend fun saveEmergencyContacts(kinfolkId: String, drafts: List<EmergencyContactDraft>): WriteResult<List<EmergencyContact>> {
        val payload = buildJsonObject {
            put("kinfolkId", JsonPrimitive(kinfolkId))
            put("contacts", kotlinx.serialization.json.buildJsonArray {
                drafts.forEach { d ->
                    add(buildJsonObject {
                        put("name", JsonPrimitive(d.name.trim()))
                        put("phone", JsonPrimitive(d.phone.trim()))
                        put("relationship", d.relationship.trim().ifBlank { null }?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
                    })
                }
            })
        }
        return when (val r = platformInvokeCallable("saveEmergencyContacts", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val rows = callableJson.parseToJsonElement(r.value).jsonObject["contacts"] as? kotlinx.serialization.json.JsonArray
                    ?: error("saveEmergencyContacts: no contacts array")
                WriteResult.Ok(rows.mapNotNull { (it as? JsonObject)?.let(::contactFromJson) })
            }.getOrElse { WriteResult.Err(it.message ?: "saveEmergencyContacts decode failed") }
        }
    }
```

`FirestoreInterop.jvm.kt` ~325-328:

```kotlin
internal actual suspend fun platformCreateKinfolk(k: Kinfolk): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kinfolk", kinfolkWriteJson(k))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
// #829: a MERGE write, not setDoc. setDoc replaces the whole document, which
// deleted any field the model does not send; emergencyContacts is deliberately
// not sent, so only a masked write leaves it alone.
internal actual suspend fun platformUpdateKinfolk(k: Kinfolk): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.mergeDoc("kinfolk", k._id, kinfolkWriteJson(k)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
```

`JvmFirestoreRest.mergeDoc`: record the attempt before the token fetch, the way `setDoc` does:

```kotlin
    suspend fun mergeDoc(collection: String, id: String, modelJson: String): String {
        val plain = codec.parseToJsonElement(modelJson).jsonObject
        JvmFirestoreFixtures.lastWrite = RestWrite("MERGE", collection, id, plain.keys.filter { it != "_id" }.toSet())
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val paths = mergeFieldPaths(plain)
        // ... rest unchanged
```

Search `jvmTest` for any test asserting `RestWrite("PATCH", "kinfolk", ...)` (`grep -rn '"kinfolk"' src/jvmTest`) and change it to `"MERGE"` with a comment naming #829; `BusinessSettingsMergeTest.kt` also calls `mergeDoc` and must still pass.

`commonMain/kotlin/com/tribetails/auntieos/web/screens/directory/EmergencyContactsEditor.kt`:

```kotlin
package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.EMERGENCY_CONTACTS_MAX
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.ui.components.GhostButton

/**
 * Up to two Emergency Contacts, the first called first (#829). Built from the
 * same `BottomBorderField` and `AuntieFieldLabel` the rest of KinfolkEditScreen
 * uses. commonMain has no tooltip primitive, so the "called only when no kinfolk
 * can be reached" sentence is not shown on this surface.
 */
@Composable
fun EmergencyContactsEditor(
    drafts: List<EmergencyContactDraft>,
    onChange: (Int, EmergencyContactDraft) -> Unit,
    onAdd: () -> Unit,
    onRemove: (Int) -> Unit,
    onMoveFirst: (Int) -> Unit,
    enabled: Boolean = true,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        drafts.forEachIndexed { i, d ->
            AuntieFieldLabel(text = if (i == 0) "Called first" else "Called second")
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(d.name, { onChange(i, d.copy(name = it)) }, label = "Name", modifier = Modifier.weight(1f))
                BottomBorderField(
                    d.phone, { onChange(i, d.copy(phone = it)) },
                    label = "Phone",
                    modifier = Modifier.weight(1f),
                    keyboardType = KeyboardType.Phone,
                )
                BottomBorderField(d.relationship, { onChange(i, d.copy(relationship = it)) }, label = "Relationship (optional)", modifier = Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (i > 0) GhostButton(label = "Call first", onClick = { onMoveFirst(i) }, enabled = enabled)
                if (drafts.size > 1) GhostButton(label = "Remove", onClick = { onRemove(i) }, enabled = enabled)
            }
        }
        if (drafts.size < EMERGENCY_CONTACTS_MAX) {
            GhostButton(label = "Add a second Emergency Contact", onClick = onAdd, enabled = enabled)
        }
    }
}
```

`BottomBorderField` and `AuntieFieldLabel` are called unqualified in `KinfolkEditScreen.kt`; import them from the same package that file imports them from (or none, if they live in `screens/directory`). `GhostButton(label, onClick, enabled, modifier)` is `ui/components/GhostButton.kt`.

In `KinfolkEditScreen.kt`, replace the emergency `Row` at ~482-494 (inside `SubsectionPanel(index = "02", title = "Other Contacts")`, keeping the `AuntieFieldLabel(text = "Emergency contact")` above it) with:

```kotlin
            if (!isNew && ecBaseline.isBlankDrafts()) {
                AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)
                Spacer(Modifier.height(8.dp))
            }
            EmergencyContactsEditor(
                drafts = ecDrafts,
                onChange = { i, d -> ecDrafts = ecDrafts.mapIndexed { j, x -> if (j == i) d else x } },
                onAdd = { ecDrafts = ecDrafts + EmergencyContactDraft() },
                onRemove = { i -> ecDrafts = ecDrafts.filterIndexed { j, _ -> j != i }.ifEmpty { listOf(EmergencyContactDraft()) } },
                onMoveFirst = { i -> ecDrafts = listOf(ecDrafts[i]) + ecDrafts.filterIndexed { j, _ -> j != i } },
                enabled = !saving,
            )
```

`KinfolkEditScreen.kt`:
- Delete `emName`, `emPhone`, `emRel` state, their prefill (~189-191), their `build()` lines (~228-230), `emNameError`/`emPhoneError` and their terms in `canSave`, and the three entries in both `dirty` lists.
- Add:

```kotlin
    var ecDrafts by remember(kinfolkId) { mutableStateOf(listOf(EmergencyContactDraft())) }
    var ecBaseline by remember(kinfolkId) { mutableStateOf(listOf(EmergencyContactDraft())) }
    LaunchedEffect(existing, isNew) {
        if (!isNew && existing != null && !initialized) {
            ecDrafts = emergencyContactsOf(existing).toDrafts()
            ecBaseline = ecDrafts
        }
    }
```

(place it before the existing prefill effect so `initialized` is still false when it runs, or fold the two lines into that effect.)
- In `onSave()`, after the `canSave` check:

```kotlin
        val ecChanged = !draftsEqual(ecDrafts, ecBaseline)
        val ecSkipped = !isNew && ecBaseline.isBlankDrafts() && ecDrafts.isBlankDrafts()
        if (isNew || (ecChanged && !ecSkipped)) {
            validateEmergencyContactDrafts(ecDrafts, listOf("$firstName $lastName"), listOf(phoneNumber, secondaryPhone))?.let {
                showToast(it, ToastKind.Error)
                return
            }
        }
```

- In the `WriteResult.Ok` branch, before `AuditLog.fire`:

```kotlin
                    if (isNew || (ecChanged && !ecSkipped)) {
                        when (val ec = client.saveEmergencyContacts(result.value, ecDrafts)) {
                            is WriteResult.Err -> {
                                showToast("saveEmergencyContacts failed: ${ec.message}. The household is saved and shows No Emergency Contact until this is saved.", ToastKind.Error)
                                if (isNew) onSaved(result.value)
                                return@launch
                            }
                            is WriteResult.Ok -> ecBaseline = ecDrafts
                        }
                    }
```

(after a failed contact save on a new household the screen moves to that household's profile, where the flag shows and Edit retries; it never re-runs `createKinfolk`.)
- Render the editor in place of the three emergency fields, with a `NoEmergencyContact` pill above it when `ecBaseline.isBlankDrafts()` and `!isNew`.

`KinfolkProfileScreen.kt` ~272: replace the flat block with a panel that always renders:

```kotlin
            Spacer(Modifier.height(18.dp))
            Panel(title = "Emergency Contacts", icon = Lucide.ShieldAlert, tone = AuntieStatusTone.Orange) {
                val ec = emergencyContactsOf(kinfolk)
                if (ec.isEmpty()) {
                    AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)
                } else {
                    ec.forEachIndexed { i, c ->
                        FactRow(label = if (i == 0) "Called first" else "Called second", value = c.name)
                        FactRow(label = "Phone", value = c.phone, mono = true)
                        FactRow(label = "Relationship", value = c.relationship.orEmpty(), last = i == ec.lastIndex)
                    }
                }
            }
```

`DirectoryScreen.kt`: in the household card composable, `if (emergencyContactsOf(kinfolk).isEmpty()) AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)`.

In the two snippets above, the pill is `AuntieStatusPill(label = "No Emergency Contact", tone = AuntieStatusTone.Orange)` from `ui/components/AuntieStatusPill.kt`; `DirectoryScreen.kt` has its own private `StatusPill(status)` for the status word, which is not this one.

`commonMain/.../web/screens/sessions/KinCareDetailScreen.kt` ~258, replace the flat `if (kinfolk != null && (...))` block with:

```kotlin
        val ec = kinfolk?.let { emergencyContactsOf(it) }.orEmpty()
        if (ec.isNotEmpty()) {
            // keep the existing section wrapper the flat block used, unchanged
                ec.forEach { c ->
                    FactRow(Lucide.ShieldAlert, label = "Name",         value = c.name)
                    FactRow(Lucide.ShieldAlert, label = "Phone",        value = c.phone)
                    FactRow(Lucide.ShieldAlert, label = "Relationship", value = c.relationship.orEmpty())
                }
        }
```

`commonMain/.../web/data/KinTaleConditionEngine.kt` ~158 (the attribute keys stay the same, so saved conditions keep working):

```kotlin
        "emergencyContactName"  -> emergencyContactsOf(kinfolk).firstOrNull()?.name.orEmpty()
        "emergencyContactPhone" -> emergencyContactsOf(kinfolk).firstOrNull()?.phone.orEmpty()
```

Add `import com.tribetails.auntieos.web.data.emergencyContactsOf` to `KinCareDetailScreen.kt` (the engine is already in that package).

- [ ] **Step 4: Run the tests**

```bash
cd auntieos-admin/web && ./gradlew :composeApp:jvmTest
```

Expected: PASS, including `EmergencyContactsTest`, `EmergencyContactsClientTest`, `BusinessSettingsMergeTest` and `KinTaleConditionEngineTest`. Open `composeApp/build/reports/tests/jvmTest/index.html` and confirm the two new classes are listed.

- [ ] **Step 5: Commit**

```bash
git add auntieos-admin/web/composeApp/src
git commit -m "Desktop console: Emergency Contacts, and stop kinfolk saves replacing the whole document (#829)"
```

## Task 9: Portal web

**Files:**
- Modify: `mytribe/web/src/api/tribeApi.ts` (wrappers beside `saveHomeAccess`; `PROFILE_RESERVED_KEYS` ~528)
- Create: `mytribe/web/src/components/EmergencyContactsCard.tsx`, `mytribe/web/src/components/EmergencyContactsCard.test.tsx`
- Modify: `mytribe/web/src/screens/TribeProfile.tsx` (state ~150, seed ~170-172, save ~284-301, card ~615-640, toggles ~846 and ~942)
- Modify: `mytribe/web/src/screens/TribeProfile.test.tsx`, `mytribe/web/src/screens/TribeProfile.contacts.test.tsx` (mock lists)

**Interfaces:**
- Consumes: `call<Req, Res>` from `src/lib/fns.ts`; TanStack Query `useQuery`, `useQueryClient`.
- Produces:
  - `interface EmergencyContactDto { name: string; phone: string; relationship: string | null; recordedAt: string | null; updatedAt: string | null }`
  - `interface ListEmergencyContactsResult { contacts: EmergencyContactDto[]; canEdit: boolean; legacy: boolean }`
  - `listEmergencyContacts(kinfolkId?: string): Promise<ListEmergencyContactsResult>`
  - `saveEmergencyContacts(req: { kinfolkId?: string; contacts: Array<{ name: string; phone: string; relationship: string | null }> }): Promise<{ contacts: EmergencyContactDto[] }>`
  - `<EmergencyContactsCard kinfolkId={string | undefined} />`

Portal pre-check scope: the card checks required fields, the two-contact limit and duplicate phones. The household-member check stays on the server, because the portal has no member phones to compare against (`listMembers` is PRIMARY-only) and the callable returns the spec message, which the card shows as-is.

- [ ] **Step 1: Write the failing tests**

`mytribe/web/src/components/EmergencyContactsCard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmergencyContactsCard } from './EmergencyContactsCard';

const mocks = vi.hoisted(() => ({ listEmergencyContacts: vi.fn(), saveEmergencyContacts: vi.fn() }));
vi.mock('../api/tribeApi', async () => {
  const actual = await vi.importActual<typeof import('../api/tribeApi')>('../api/tribeApi');
  return {
    ...actual,
    listEmergencyContacts: (...a: unknown[]) => mocks.listEmergencyContacts(...a),
    saveEmergencyContacts: (...a: unknown[]) => mocks.saveEmergencyContacts(...a),
  };
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmergencyContactsCard kinfolkId="kin-fam-1" />
    </QueryClientProvider>,
  );
}

const RAE = { name: 'Rae Mercer', phone: '+18055550199', relationship: 'Sister', recordedAt: null, updatedAt: null };

beforeEach(() => {
  mocks.listEmergencyContacts.mockReset();
  mocks.saveEmergencyContacts.mockReset().mockResolvedValue({ contacts: [RAE] });
});

describe('EmergencyContactsCard', () => {
  it('prompts a household with none, and saves the first contact through the callable', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
    mount();
    expect(await screen.findByText('A household needs at least one Emergency Contact')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-0-name' }), 'Rae Mercer');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-0-phone' }), '805 555 0199');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    await waitFor(() =>
      expect(mocks.saveEmergencyContacts).toHaveBeenCalledWith({
        kinfolkId: 'kin-fam-1',
        contacts: [{ name: 'Rae Mercer', phone: '805 555 0199', relationship: null }],
      }),
    );
  });

  it('adds a second contact, moves it first, and clears a relationship', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Add a second Emergency Contact' }));
    await userEvent.type(screen.getByLabelText('Name', { selector: '#ec-1-name' }), 'Lee Park');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#ec-1-phone' }), '8055550177');
    await userEvent.click(screen.getByRole('button', { name: 'Call Lee Park first' }));
    await userEvent.clear(screen.getByLabelText('Relationship (optional)', { selector: '#ec-1-relationship' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    await waitFor(() => expect(mocks.saveEmergencyContacts).toHaveBeenCalledTimes(1));
    expect(mocks.saveEmergencyContacts.mock.calls[0][0].contacts).toEqual([
      { name: 'Lee Park', phone: '8055550177', relationship: null },
      { name: 'Rae Mercer', phone: '+18055550199', relationship: null },
    ]);
  });

  it('shows the server refusal verbatim', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: true, legacy: false });
    mocks.saveEmergencyContacts.mockRejectedValue(new Error('An Emergency Contact has to be someone outside the household.'));
    mount();
    await screen.findByDisplayValue('Rae Mercer');
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contacts' }));
    expect(await screen.findByText('An Emergency Contact has to be someone outside the household.')).toBeInTheDocument();
  });

  it('is read-only without home_access: no inputs, no save', async () => {
    mocks.listEmergencyContacts.mockResolvedValue({ contacts: [RAE], canEdit: false, legacy: false });
    mount();
    expect(await screen.findByText('Rae Mercer')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Emergency Contacts' })).toBeNull();
  });

  it('a load failure says so instead of drawing an empty household', async () => {
    mocks.listEmergencyContacts.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText(/Couldn.t load your Emergency Contacts/)).toBeInTheDocument();
    expect(screen.queryByText('A household needs at least one Emergency Contact')).toBeNull();
  });
});
```

In `mytribe/web/src/screens/TribeProfile.test.tsx`, add to the `vi.mock('../api/tribeApi', ...)` object:

```tsx
    listEmergencyContacts: vi.fn(),
    saveEmergencyContacts: vi.fn(),
```

in its `beforeEach`:

```tsx
  vi.mocked(tribeApi.listEmergencyContacts).mockResolvedValue({ contacts: [], canEdit: true, legacy: false });
```

and a new test:

```tsx
it('#829: the profile save carries no emergencyContact key at all', async () => {
  vi.mocked(tribeApi.getMyTribeProfile).mockResolvedValue({
    ...PROFILE,
    profile: {
      ...PROFILE.profile,
      customFields: [{ key: 'emergencyContactName', label: 'Emergency Contact', value: 'Stale' }],
    },
  });
  renderTribeProfile();
  await userEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
  const { saveTribeProfile } = await import('../api/tribeApi');
  await waitFor(() => expect(saveTribeProfile).toHaveBeenCalledTimes(1));
  const keys = (vi.mocked(saveTribeProfile).mock.calls[0][0].customFields ?? []).map((f) => f.key);
  expect(keys.filter((k) => k.startsWith('emergencyContact'))).toEqual([]);
});
```

(`renderTribeProfile` is the file's existing render helper around line 100; use its real name, and `import { screen } from '@testing-library/react'` if only `render` is imported.) In `TribeProfile.contacts.test.tsx`, add `listEmergencyContacts: vi.fn()` and `saveEmergencyContacts: vi.fn()` to `mocks`, route them in the `vi.mock` object the same way as the others, and resolve `listEmergencyContacts` to `{ contacts: [], canEdit: true, legacy: false }` in its `beforeEach`.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd mytribe/web && npx vitest run src/components/EmergencyContactsCard.test.tsx src/screens/TribeProfile.test.tsx src/screens/TribeProfile.contacts.test.tsx
```

Expected: FAIL (no card module; the payload test finds `emergencyContactName`).

- [ ] **Step 3: Implement**

`mytribe/web/src/api/tribeApi.ts`, after `saveHomeAccess`:

```ts
// ── Emergency Contacts (functions/src/portal/emergencyContacts.ts, #829) ────

export interface EmergencyContactDto {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: string | null;
  updatedAt: string | null;
}

export interface ListEmergencyContactsResult {
  contacts: EmergencyContactDto[];
  /** True when the caller holds home_access (staff and the primary always do). */
  canEdit: boolean;
  legacy: boolean;
}

export function listEmergencyContacts(kinfolkId?: string): Promise<ListEmergencyContactsResult> {
  return call<{ kinfolkId?: string }, ListEmergencyContactsResult>('listEmergencyContacts', kinfolkId !== undefined ? { kinfolkId } : {});
}

export interface SaveEmergencyContactsRequest {
  kinfolkId?: string;
  contacts: Array<{ name: string; phone: string; relationship: string | null }>;
}

/** Replaces the household's list whole, index 0 called first. Needs home_access. */
export function saveEmergencyContacts(req: SaveEmergencyContactsRequest): Promise<{ contacts: EmergencyContactDto[] }> {
  return call<SaveEmergencyContactsRequest, { contacts: EmergencyContactDto[] }>('saveEmergencyContacts', req);
}
```

Keep the three `emergencyContact*` names in `PROFILE_RESERVED_KEYS` with a comment, so any stale key is stripped from `customFields` on the next save and never re-sent:

```ts
  // #829: no longer written here. Kept reserved so a stale copy is dropped from
  // customFields on the next save instead of riding along forever.
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
```

`mytribe/web/src/components/EmergencyContactsCard.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listEmergencyContacts, saveEmergencyContacts, type EmergencyContactDto } from '../api/tribeApi';

interface Draft {
  name: string;
  phone: string;
  relationship: string;
}

const REQUIRED = 'A household needs at least one Emergency Contact';
const WHO_GETS_CALLED = 'Called only when no kinfolk can be reached. The first one is called first.';

const toDrafts = (c: EmergencyContactDto[]): Draft[] =>
  c.length > 0 ? c.map((x) => ({ name: x.name, phone: x.phone, relationship: x.relationship ?? '' })) : [{ name: '', phone: '', relationship: '' }];
const digits = (p: string) => p.replace(/\D/g, '').replace(/^(\d{10})$/, '1$1');

function precheck(drafts: Draft[]): string | null {
  if (drafts.every((d) => d.name.trim() === '' && d.phone.trim() === '')) return REQUIRED;
  if (drafts.some((d) => d.name.trim() === '')) return 'Each Emergency Contact needs a name.';
  if (drafts.some((d) => d.phone.trim() === '')) return 'Each Emergency Contact needs a phone number.';
  if (drafts.length === 2 && digits(drafts[0].phone) === digits(drafts[1].phone)) return 'The two Emergency Contacts need different phone numbers.';
  return null;
}

/**
 * The household's Emergency Contacts (#829): up to two, the first called first,
 * never messaged. Edited only by someone holding home_access; everyone else in
 * the household sees them read-only.
 */
export function EmergencyContactsCard({ kinfolkId }: { kinfolkId: string | undefined }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['emergencyContacts', kinfolkId], queryFn: () => listEmergencyContacts(kinfolkId) });
  const [drafts, setDrafts] = useState<Draft[]>(toDrafts([]));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setDrafts(toDrafts(q.data.contacts));
  }, [q.data]);

  const set = (i: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function save() {
    const problem = precheck(drafts);
    if (problem) {
      setMessage(problem);
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await saveEmergencyContacts({
        ...(kinfolkId !== undefined ? { kinfolkId } : {}),
        contacts: drafts.map((d) => ({ name: d.name.trim(), phone: d.phone.trim(), relationship: d.relationship.trim() === '' ? null : d.relationship.trim() })),
      });
      setMessage('Saved.');
      void queryClient.invalidateQueries({ queryKey: ['emergencyContacts', kinfolkId] });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="glass card d4" aria-labelledby="ec-title">
      <div className="cardhead">
        <div className="ic coral">{'\u{1F4DE}'}</div>
        <div className="htxt">
          <h3 className="title" id="ec-title" title={WHO_GETS_CALLED}>
            Emergency Contacts
          </h3>
        </div>
      </div>
      {q.isError ? (
        <p className="sub" role="alert">Couldn&rsquo;t load your Emergency Contacts right now.</p>
      ) : !q.data ? (
        <p className="sub">Loading Emergency Contacts…</p>
      ) : !q.data.canEdit ? (
        q.data.contacts.length === 0 ? (
          <p className="sub">{REQUIRED}</p>
        ) : (
          <ol className="ec-list">
            {q.data.contacts.map((c, i) => (
              <li key={`${c.phone}-${i}`}>
                <span>{c.name}</span> <span className="mono">{c.phone}</span>
                {c.relationship ? <span> ({c.relationship})</span> : null}
              </li>
            ))}
          </ol>
        )
      ) : (
        <>
          {q.data.contacts.length === 0 && <p className="sub" role="status">{REQUIRED}</p>}
          {drafts.map((d, i) => (
            <fieldset key={i} className="grid2" aria-label={`Emergency Contact ${i + 1}`} disabled={saving}>
              <legend className="tlabel">{i === 0 ? 'Called first' : 'Called second'}</legend>
              <div className="field">
                <label htmlFor={`ec-${i}-name`}>Name</label>
                <input id={`ec-${i}-name`} className="inp" type="text" value={d.name} onChange={(e) => set(i, { name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`ec-${i}-phone`}>Phone</label>
                <input id={`ec-${i}-phone`} className="inp mono" type="tel" value={d.phone} onChange={(e) => set(i, { phone: e.target.value })} />
              </div>
              <div className="field full">
                <label htmlFor={`ec-${i}-relationship`}>Relationship (optional)</label>
                <input id={`ec-${i}-relationship`} className="inp" type="text" value={d.relationship} onChange={(e) => set(i, { relationship: e.target.value })} />
              </div>
              <div className="field full">
                {i > 0 && (
                  <button type="button" className="btn ghost" aria-label={`Call ${d.name.trim() || 'this contact'} first`} onClick={() => setDrafts((ds) => [ds[i], ...ds.filter((_, j) => j !== i)])}>
                    Call first
                  </button>
                )}
                {drafts.length > 1 && (
                  <button type="button" className="btn ghost" onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </div>
            </fieldset>
          ))}
          {drafts.length < 2 && (
            <button type="button" className="btn ghost" disabled={saving} onClick={() => setDrafts((ds) => [...ds, { name: '', phone: '', relationship: '' }])}>
              Add a second Emergency Contact
            </button>
          )}
          <button type="button" className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save Emergency Contacts'}
          </button>
          {message && <p className="sub" role="status">{message}</p>}
        </>
      )}
    </section>
  );
}
```

(Use the portal's real button class names from the Tribe Profile's existing Save and "Add a contact" buttons if `btn`/`btn ghost` are not them.)

`mytribe/web/src/screens/TribeProfile.tsx`:
- Delete the `emergencyName`/`emergencyPhone`/`emergencyRelation` state (~150), their seeding (~170-172), and the whole old EMERGENCY CONTACT CARD section (~622-640); render `<EmergencyContactsCard kinfolkId={kinfolkId} />` in its place.
- In `handleSave`, rename `vetFields` to `vetClinicFields` everywhere, and delete the three `emergency*` pushes, so the array holds only `vetClinicId`.
- Both "Home access (gate code, Wi-Fi)" toggle labels (~846, ~942) become `Home access (gate code, Wi-Fi, Emergency Contacts)`, with `title="Sees and edits the household home details: entry notes and Emergency Contacts."` on the `<label className="togglerow">`.
- Update the file header comment that says Emergency Contact is stored in customFields: it is stored on the kinfolk record through `saveEmergencyContacts`.

- [ ] **Step 4: Run the tests**

```bash
cd mytribe/web && npx vitest run src/components/EmergencyContactsCard.test.tsx src/screens/TribeProfile.test.tsx src/screens/TribeProfile.contacts.test.tsx && npm test && npx tsc --noEmit -p .
```

Expected: the three files PASS, the full portal suite PASSES, tsc exits 0.

- [ ] **Step 5: Commit**

```bash
git add mytribe/web/src
git commit -m "Portal web: Emergency Contacts card over the callable, off the profile customFields (#829)"
```

## Task 10: Portal Android (`mytribe/src`)

**Files:**
- Modify: `mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/TribeDtos.kt` (beside `HouseholdContact`, ~line 88)
- Modify: `mytribe/src/commonMain/kotlin/com/kinfolk/portal/portal/PortalApi.kt` (after `removeHouseholdContact`, ~line 1240)
- Create: `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/tribe/EmergencyContactsCard.kt`
- Modify: `mytribe/src/commonMain/kotlin/com/kinfolk/portal/screens/tribe/TribeScreen.kt` (state ~127-130, seed ~169-171, card ~348-370, save ~411-441, `mergeVetFields` ~862, toggles ~1013 and ~1108)
- Create: `mytribe/src/commonTest/kotlin/com/kinfolk/portal/portal/EmergencyContactsPortalApiTest.kt`
- Create: `mytribe/src/composeUiTest/kotlin/com/kinfolk/portal/screens/tribe/EmergencyContactsCardTest.kt`
- Modify: `mytribe/src/composeUiTest/kotlin/com/kinfolk/portal/screens/tribe/TribeScreenTest.kt`, `HouseholdContactsCardTest.kt` (stub `listEmergencyContacts`)

**Interfaces:**
- Consumes: `FunctionsClient.call(name, payload: JsonObject?): JsonObject`; `FakeFunctionsClient.stub/stubError/calls`; `setThemedContent`; `GlassCard`, `CardHead`, `KinField`, `KinButton`.
- Produces:
  - `data class EmergencyContactDto(val name: String, val phone: String, val relationship: String?, val recordedAt: String?, val updatedAt: String?)`
  - `data class EmergencyContactsResult(val contacts: List<EmergencyContactDto>, val canEdit: Boolean, val legacy: Boolean)`
  - `data class EmergencyContactInput(val name: String, val phone: String, val relationship: String)`
  - `suspend fun PortalApi.listEmergencyContacts(kinfolkId: String? = null): EmergencyContactsResult`
  - `suspend fun PortalApi.saveEmergencyContacts(kinfolkId: String? = null, contacts: List<EmergencyContactInput>): List<EmergencyContactDto>`
  - `@Composable fun EmergencyContactsCard(kinfolkId: String?, portalApi: PortalApi)`

- [ ] **Step 1: Write the failing tests**

`mytribe/src/commonTest/kotlin/com/kinfolk/portal/portal/EmergencyContactsPortalApiTest.kt`:

```kotlin
package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EmergencyContactsPortalApiTest {

    private fun rae() = buildJsonObject {
        put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", JsonNull); put("recordedAt", JsonNull); put("updatedAt", JsonNull)
    }

    @Test
    fun `list decodes contacts and canEdit`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(rae()) }); put("canEdit", false); put("legacy", true)
        })
        val r = PortalApi(fake).listEmergencyContacts("fam1")
        assertEquals("Rae Mercer", r.contacts.single().name)
        assertFalse(r.canEdit)
        assertTrue(r.legacy)
        assertEquals("fam1", fake.calls.single().second!!["kinfolkId"]!!.jsonPrimitive.content)
    }

    @Test
    fun `save sends exactly the three fields per slot, in order, relationship cleared as null`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray { add(rae()) }) })
        PortalApi(fake).saveEmergencyContacts(
            kinfolkId = "fam1",
            contacts = listOf(EmergencyContactInput(" Lee Park ", "8055550177", "  "), EmergencyContactInput("Rae Mercer", "8055550199", "Sister")),
        )
        val payload = fake.calls.single().second!!
        assertEquals(setOf("kinfolkId", "contacts"), payload.keys)
        val slots = payload["contacts"]!!.jsonArray.map { it.jsonObject }
        assertEquals(setOf("name", "phone", "relationship"), slots[0].keys)
        assertEquals("Lee Park", slots[0]["name"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, slots[0]["relationship"])
        assertEquals("Sister", slots[1]["relationship"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an answer with no contacts array throws instead of reading as none`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("listEmergencyContacts", JsonObject(emptyMap()))
        assertFailsWith<IllegalStateException> { PortalApi(fake).listEmergencyContacts() }
    }
}
```

`mytribe/src/composeUiTest/kotlin/com/kinfolk/portal/screens/tribe/EmergencyContactsCardTest.kt`:

```kotlin
@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EmergencyContactsCardTest {

    private fun FakeFunctionsClient.list(canEdit: Boolean, withRae: Boolean) = stub("listEmergencyContacts", buildJsonObject {
        put("contacts", buildJsonArray {
            if (withRae) add(buildJsonObject { put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", "Sister"); put("recordedAt", JsonNull); put("updatedAt", JsonNull) })
        })
        put("canEdit", canEdit); put("legacy", false)
    })

    @Test
    fun promptsAHouseholdWithNoneAndSavesTheFirstContact() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = false)
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        setThemedContent { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("A household needs at least one Emergency Contact").assertIsDisplayed()
        onNodeWithTag("ec-0-name").performTextInput("Rae Mercer")
        onNodeWithTag("ec-0-phone").performTextInput("8055550199")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        val payload = fake.calls.last { it.first == "saveEmergencyContacts" }.second!!
        val slot = payload["contacts"]!!.jsonArray.single().jsonObject
        assertEquals("Rae Mercer", slot["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun addsASecondAndMovesItFirst() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        setThemedContent { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Add a second Emergency Contact").performScrollTo().performClick()
        onNodeWithTag("ec-1-name").performTextInput("Lee Park")
        onNodeWithTag("ec-1-phone").performTextInput("8055550177")
        onNodeWithText("Call first").performScrollTo().performClick()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        val slots = fake.calls.last { it.first == "saveEmergencyContacts" }.second!!["contacts"]!!.jsonArray
        assertEquals(listOf("Lee Park", "Rae Mercer"), slots.map { it.jsonObject["name"]!!.jsonPrimitive.content })
    }

    @Test
    fun readOnlyWithoutHomeAccess() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = false, withRae = true)
        setThemedContent { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Rae Mercer", substring = true).assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save Emergency Contacts").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun showsTheServerRefusalVerbatim() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        fake.stubError("saveEmergencyContacts", IllegalStateException("An Emergency Contact has to be someone outside the household."))
        setThemedContent { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("An Emergency Contact has to be someone outside the household.").assertIsDisplayed()
    }
}
```

In `TribeScreenTest.kt` and `HouseholdContactsCardTest.kt`, add to every stubbed screen (`stubScreen()` and each test's `getMyTribeProfile` stub group):

```kotlin
        stub("listEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray {}); put("canEdit", true); put("legacy", false) })
```

and add to `TribeScreenTest.kt`:

```kotlin
    @Test
    fun theProfileSaveCarriesNoEmergencyContactKey() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubProfileWithSavedField(fake)
        fake.stub("listEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray {}); put("canEdit", true); put("legacy", false) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        setThemedContent { TribeScreen("X", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val keys = fake.calls.last { it.first == "saveTribeProfile" }.second!!["customFields"]!!.jsonArray.map { it.jsonObject["key"]!!.jsonPrimitive.content }
        assertTrue(keys.none { it.startsWith("emergencyContact") })
    }
```

(`stubProfileWithSavedField` is an extension on `FakeFunctionsClient` in that file; call it as `fake.stubProfileWithSavedField()` and add any other stubs the existing save test in the file registers, such as `getVetClinics` and `listMembers`.)

- [ ] **Step 2: Run them and watch them fail**

```bash
cd mytribe && ./gradlew :jvmTest --tests 'com.kinfolk.portal.portal.EmergencyContactsPortalApiTest' --tests 'com.kinfolk.portal.screens.tribe.EmergencyContactsCardTest' --tests 'com.kinfolk.portal.screens.tribe.TribeScreenTest'
```

Expected: compilation FAILS (`Unresolved reference: listEmergencyContacts`, `EmergencyContactsCard`).

- [ ] **Step 3: Implement**

`TribeDtos.kt`:

```kotlin
/** #829. An Emergency Contact: called only when no kinfolk can be reached, never messaged. */
data class EmergencyContactDto(
    val name: String,
    val phone: String,
    val relationship: String?,
    val recordedAt: String?,
    val updatedAt: String?,
)

data class EmergencyContactsResult(val contacts: List<EmergencyContactDto>, val canEdit: Boolean, val legacy: Boolean)

data class EmergencyContactInput(val name: String, val phone: String, val relationship: String)
```

`PortalApi.kt`:

```kotlin
    /** #829. Any ACTIVE member reads; `canEdit` is true only with home_access. Fail-loud on an unreadable answer. */
    suspend fun listEmergencyContacts(kinfolkId: String? = null): EmergencyContactsResult {
        val raw = fns.call("listEmergencyContacts", kinfolkId?.let { buildJsonObject { put("kinfolkId", it) } } ?: buildJsonObject {})
        val rows = raw["contacts"] as? JsonArray ?: error("listEmergencyContacts: missing contacts array")
        return EmergencyContactsResult(
            contacts = rows.map { decodeEmergencyContact(it.jsonObject) },
            canEdit = raw["canEdit"]?.jsonPrimitive?.booleanOrNull ?: false,
            legacy = raw["legacy"]?.jsonPrimitive?.booleanOrNull ?: false,
        )
    }

    /** #829. Replaces the list whole, index 0 called first. An empty relationship is sent as null so it clears. */
    suspend fun saveEmergencyContacts(kinfolkId: String? = null, contacts: List<EmergencyContactInput>): List<EmergencyContactDto> {
        val raw = fns.call("saveEmergencyContacts", buildJsonObject {
            kinfolkId?.let { put("kinfolkId", it) }
            put("contacts", buildJsonArray {
                contacts.forEach { c ->
                    add(buildJsonObject {
                        put("name", c.name.trim())
                        put("phone", c.phone.trim())
                        val rel = c.relationship.trim()
                        if (rel.isEmpty()) put("relationship", kotlinx.serialization.json.JsonNull) else put("relationship", rel)
                    })
                }
            })
        })
        val rows = raw["contacts"] as? JsonArray ?: error("saveEmergencyContacts: missing contacts array")
        return rows.map { decodeEmergencyContact(it.jsonObject) }
    }

    private fun decodeEmergencyContact(o: JsonObject): EmergencyContactDto {
        fun text(key: String): String? = o[key]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
        return EmergencyContactDto(text("name").orEmpty(), text("phone").orEmpty(), text("relationship"), text("recordedAt"), text("updatedAt"))
    }
```

(add `import kotlinx.serialization.json.add` if `buildJsonArray { add(...) }` does not resolve.)

`EmergencyContactsCard.kt`:

```kotlin
package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.kinfolk.portal.portal.EmergencyContactInput
import com.kinfolk.portal.portal.EmergencyContactsResult
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.launch

private const val REQUIRED = "A household needs at least one Emergency Contact"

private fun comparable(p: String) = p.filter(Char::isDigit).let { if (it.length == 10) "1$it" else it }

private fun precheck(drafts: List<EmergencyContactInput>): String? = when {
    drafts.all { it.name.isBlank() && it.phone.isBlank() } -> REQUIRED
    drafts.any { it.name.isBlank() } -> "Each Emergency Contact needs a name."
    drafts.any { it.phone.isBlank() } -> "Each Emergency Contact needs a phone number."
    drafts.size == 2 && comparable(drafts[0].phone) == comparable(drafts[1].phone) -> "The two Emergency Contacts need different phone numbers."
    else -> null
}

/** #829. Up to two, the first called first. Edited only with home_access; read-only for everyone else. */
@Composable
fun EmergencyContactsCard(kinfolkId: String?, portalApi: PortalApi) {
    val scope = rememberCoroutineScope()
    var loaded by remember(kinfolkId) { mutableStateOf<EmergencyContactsResult?>(null) }
    var loadError by remember(kinfolkId) { mutableStateOf<String?>(null) }
    var drafts by remember(kinfolkId) { mutableStateOf(listOf(EmergencyContactInput("", "", ""))) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(kinfolkId) {
        try {
            val r = portalApi.listEmergencyContacts(kinfolkId)
            loaded = r
            drafts = r.contacts.map { EmergencyContactInput(it.name, it.phone, it.relationship.orEmpty()) }.ifEmpty { listOf(EmergencyContactInput("", "", "")) }
        } catch (t: Throwable) {
            loadError = "Couldn't load your Emergency Contacts right now."
        }
    }

    fun set(i: Int, d: EmergencyContactInput) { drafts = drafts.mapIndexed { j, x -> if (j == i) d else x } }

    GlassCard(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l), contentPadding = PaddingValues(KinfolkSpacing.l)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CardHead(icon = Icons.Filled.Phone, tint = KinfolkBrand.SnuggleCoral, title = "Emergency Contacts", sub = null)
            val r = loaded
            when {
                loadError != null -> Text(loadError!!)
                r == null -> Text("Loading Emergency Contacts…")
                !r.canEdit -> if (r.contacts.isEmpty()) Text(REQUIRED) else r.contacts.forEach { c ->
                    Text(listOfNotNull(c.name, c.phone, c.relationship).joinToString("  ·  "))
                }
                else -> {
                    if (r.contacts.isEmpty()) Text(REQUIRED)
                    drafts.forEachIndexed { i, d ->
                        Text(if (i == 0) "Called first" else "Called second")
                        KinField(value = d.name, onValueChange = { set(i, d.copy(name = it)) }, label = "Name", modifier = Modifier.fillMaxWidth().testTag("ec-$i-name"))
                        KinField(value = d.phone, onValueChange = { set(i, d.copy(phone = it)) }, label = "Phone", modifier = Modifier.fillMaxWidth().testTag("ec-$i-phone"))
                        KinField(value = d.relationship, onValueChange = { set(i, d.copy(relationship = it)) }, label = "Relationship (optional)", modifier = Modifier.fillMaxWidth().testTag("ec-$i-relationship"))
                        if (i > 0) KinButton(label = "Call first", onClick = { drafts = listOf(drafts[i]) + drafts.filterIndexed { j, _ -> j != i } })
                        if (drafts.size > 1) KinButton(label = "Remove", onClick = { drafts = drafts.filterIndexed { j, _ -> j != i } })
                    }
                    if (drafts.size < 2) KinButton(label = "Add a second Emergency Contact", onClick = { drafts = drafts + EmergencyContactInput("", "", "") })
                    KinButton(
                        label = if (saving) "Saving…" else "Save Emergency Contacts",
                        onClick = {
                            val problem = precheck(drafts)
                            if (problem != null) { message = problem; return@KinButton }
                            saving = true
                            message = null
                            scope.launch {
                                message = try {
                                    portalApi.saveEmergencyContacts(kinfolkId, drafts)
                                    "Saved."
                                } catch (t: Throwable) {
                                    t.message ?: "Save failed."
                                } finally {
                                    saving = false
                                }
                            }
                        },
                    )
                    message?.let { Text(it) }
                }
            }
        }
    }
}
```

Match the real signatures in this tree: if `CardHead`'s `sub` is non-null `String`, overload is not needed, pass `sub = ""` only if the component hides an empty subtitle, otherwise add a `sub: String? = null` default to `CardHead` (the operator ruling puts explanatory copy in a tooltip, not under the title); if `KinButton`'s `onClick` lambda does not allow `return@KinButton`, restructure the precheck as an `if/else`. The `"Called only when no kinfolk can be reached."` explanation goes on the card title as a tooltip where this tree has a tooltip modifier; if none exists on the Compose portal, leave it out on this surface and say so in the PR description.

`TribeScreen.kt`:
- Delete `emergencyName`, `emergencyPhone`, `emergencyRelation` (~127-130) and their seeding (~169-171), and replace the "Emergency contact" `GlassCard` (~348-370) with `EmergencyContactsCard(kinfolkId = kinfolkId, portalApi = portalApi)`.
- In the save, rename `vetFields` to `vetClinicFields` and delete the three emergency `add(...)` lines (~415-417).
- Rename `mergeVetFields` to `mergeVetClinicFields`; keep the three `emergencyContact*` keys in its reserved set with the comment `// #829: kept reserved so a stale copy is dropped, never re-sent.`
- Both "Home access (gate code, Wi-Fi)" labels (~1013, ~1108) become `"Home access (gate code, Wi-Fi, Emergency Contacts)"`.

- [ ] **Step 4: Run the tests**

```bash
cd mytribe && ./gradlew :jvmTest && ./gradlew testDebugUnitTest
```

Expected: `:jvmTest` PASSES including the three new or changed classes (`ComposeUiTestSourceSetTest` included, which confirms the card test sits in `composeUiTest`); `testDebugUnitTest` PASSES. Confirm in `build/reports/tests/jvmTest/index.html` that `EmergencyContactsCardTest` ran.

- [ ] **Step 5: Commit**

```bash
git add mytribe/src
git commit -m "Portal Android: Emergency Contacts card over the callable (#829)"
```

---

## Task 11: Whole-branch verification and PR

- [ ] **Step 1: Run every gate**

```bash
cd mytribe/functions && npm test && npm run typecheck && npm run lint && npm run test:rules
cd ../web && npm test
cd ../../auntieos-admin && npm test && npm run e2e:cy:tsc
cd android && ./gradlew testDebugUnitTest
cd ../web && ./gradlew :composeApp:jvmTest
cd ../web/functions && npm test
cd ../../../mytribe && ./gradlew :jvmTest
```

Expected: every command exits 0. Open each HTML report or vitest summary and check the new suites are counted; a green exit with the new tests missing is a failure.

- [ ] **Step 2: Dry-run the migration against the emulator seed**

```bash
cd mytribe/functions && firebase emulators:exec --only firestore --project mytribe-rules-test "npx vitest run ../scripts/test/backfillKinfolkEmergencyContacts.emulator.test.ts"
```

Expected: `1 passed`.

- [ ] **Step 3: Push and open the PR (separate calls)**

```bash
git push -u origin feat/829-emergency-contact
```

```bash
gh pr create --base main --title "Emergency Contact: one store, one write path, all five clients (#829 PR 1)" --body-file /tmp/pr-829-ec.md
```

The body lists: what changed per client; that the migration is a dry run in the PR and the write is the operator's post-release step (`npm run backfill:emergency-contacts`, then `-- --allow-prod`); that the flat fields stay until the operator verifies; and the two decisions in the self-review below that need a ruling. End with the attribution line. Let CI settle before merging with `gh pr merge --merge`.

---

## Self-review against the spec

| Spec requirement | Where |
|---|---|
| Storage: `kinfolk/{id}.emergencyContacts`, 0..2, index 0 first, `{name, phone, relationship \| null, recordedAt, updatedAt}` | Task 1 (lib, callable), Task 4 (migration writes the same shape) |
| Name and phone required; relationship optional and clearable | Task 1 schema; Tasks 5-10 editors send `null` for an emptied relationship, with a test on each client |
| One write path `saveEmergencyContacts`, strict schema, max 2, replaces whole | Task 1; all five clients call it (Tasks 5-10); rules refuse the kinfolk claim (Task 2) |
| Reorder is one write | Task 1 merge test (reorder keeps dates); editors' "Call first" tests on every client |
| `listEmergencyContacts`, same gate plus any ACTIVE member reads | Task 1 list handler and tests |
| Gate on `home_access` via `requireKinfolkPerm` (staff, PRIMARY, SECONDARY with the flag) | Task 1 gate tests |
| Required: refuse empty with "A household needs at least one Emergency Contact" | Task 1 test REQUIRED; client pre-checks Tasks 5, 7, 8, 9, 10 |
| Required on admin Add Kinfolk, all three admin clients | Task 6 (React `AddKinfolkDialog`), Task 7 (Android `saveKinfolk`), Task 8 (desktop `KinfolkEditScreen` `isNew`) |
| Households with none not blocked from unrelated edits | Task 6 test, Task 7 test, Task 8 `ecSkipped` branch |
| "No Emergency Contact" flag on the household and in the directory (admin) | Task 6 (profile, edit, directory card), Task 7 (profile, directory card), Task 8 (profile, directory card) |
| Portal Tribe-screen prompt until one is added | Task 9 and Task 10 card tests |
| Not a household member: phone vs primary and secondaries (libphonenumber), name vs members, spec message; clients check first | Task 1 lib and callable tests; client pre-checks against what each client holds (Tasks 5-8 primary name and phones; portal server-only, see below) |
| Never messaged: no audience reads it, a test per builder | Task 3 (static scan, broadcast, marketing audience, recipient resolver, SMS sender) |
| Migration: flat triple into `[0]`, `recordedAt` = doc `updatedAt`, dry run with per-household diff, operator runs the write | Task 4; runbook line at the end of Task 4 |
| Old flat fields readable until verified, then stop being read and written | Readers fall back in Tasks 1, 5, 7, 8; no client writes them after this PR (Tasks 2, 6, 7, 8, 9, 10). Removing the fallback is a follow-up after verification |
| Portal cleanup: no `emergencyContact*` in `families/{id}.customFields`, no `vetFields` name | Task 9 and Task 10 (payload tests, rename) |
| Section 3: widened description on all five clients | Admin React and Android: exact sentence (Tasks 6, 7). Portal web and Android have a label, not a description: label widened, sentence as tooltip on web (Tasks 9, 10). Desktop has no members screen: not applicable |
| Section 4: two-slot ordered editor on each client; copy says contacts are called only when no kinfolk can be reached | Editors in Tasks 5-10. The sentence is a tooltip (2026-09-11 subtitles ruling) on admin web (Task 5), admin Android (Task 7 `TooltipBox`) and portal web (Task 9). Desktop (Task 8) and portal Android (Task 10) have no tooltip primitive in commonMain, so the sentence is not shown there, and the PR says so |
| Delivery: full vertical, not stacked | One branch, Tasks 1-11 |

Open points the operator should rule on (in the PR body):
1. **`home_access` reads vs. edits.** Section 1 lets any ACTIVE member read Emergency Contacts; section 3's copy says `home_access` "Sees and edits" them. The plan implements section 1 (read open, edit gated) and returns `canEdit`.
2. **A legacy record with no date.** Where a kinfolk doc has neither `updatedAt` nor `joinDate`, `recordedAt` is written as `null` and the dry run prints `NO DATE`. The spec types it as a Timestamp.
3. **Portal member check.** The portal cannot pre-check against secondary members' phones and names (it has no read of them); the server refusal carries the spec message instead.
4. **Kinfolk-claim allowlist.** The three flat keys were removed from `onlyAllowedKinfolkFields()` (Task 2). Nothing in the portal wrote them, but it is a rules change.
5. **Desktop kinfolk updates became merge writes** (Task 8). Fields the desktop model does not carry now survive a desktop save instead of being deleted.

