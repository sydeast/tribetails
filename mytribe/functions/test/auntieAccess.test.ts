import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

/**
 * `lib/firestoreAdmin` is stubbed for the same reason the other 280 test files
 * in this tree stub it, and this file learned it the hard way. Two tests below
 * call `updateKinCareSessionHandler` for real, and the one that gets PAST the
 * caretaker guard goes on to read a document. Unstubbed, that initialises the
 * Firebase Admin SDK, which needs a project id: ambient on a developer machine,
 * absent on the CI runner. So this file passed locally and failed in CI with
 * "Unable to detect a Project Id" where a `not-found` was expected.
 *
 * The fix is the stub, not an env var. A unit test asserting an authorization
 * boundary has no business reaching a real client in either environment, and
 * papering over it with configuration would leave the test passing for a reason
 * that has nothing to do with what it claims to check.
 */
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn().mockReturnValue('s1'), initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  process.env.AUNTIE_OPERATOR_UIDS = '';
  // An EMPTY Firestore. Nothing here wants a document to be found: the two
  // handler tests are about WHICH ERROR comes back, and `not-found` is only
  // reachable by getting past the gate into a real lookup.
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
});

/**
 * Every name `src/index.ts` re-exports, which is every callable this codebase
 * deploys. Parsed rather than imported, because importing index.ts pulls in the
 * whole function tree and its side effects.
 */
function deployedCallableNames(): Set<string> {
  const text = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');
  const names = new Set<string>();
  for (const m of text.matchAll(/export \{([^}]*)\} from/gs)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim().split(' as ').pop()!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const ownerAuth = { uid: 'owner-1', token: { admin: true } };
const auntieAuth = { uid: 'auntie-1', token: { staffRole: 'auntie' } };

/**
 * The server half of the #944 boundary. Firestore rules are enforced only on
 * direct client access; a callable runs on the Admin SDK and is not subject to
 * them at all, so a money callable has to refuse an Auntie here even where the
 * rules would already have refused her the read.
 *
 * EVERY REFUSAL BELOW WAS PROVED TO DISCRIMINATE by adding the callable to
 * AUNTIE_ALLOWED_CALLABLES, running the suite, reading the red, and reverting.
 * The PR body records the output.
 */
describe('#944 the allowlist is a real list of real callables', () => {
  /**
   * Without this, the table could rot into a set of strings that gate nothing:
   * a renamed callable would quietly become owner-only, and nobody would learn
   * that from a green suite.
   */
  it('every allowlisted name is a callable this codebase deploys', () => {
    const deployed = deployedCallableNames();
    expect(deployed.size).toBeGreaterThan(200); // the parse found something real
    const missing = [...AUNTIE_ALLOWED_CALLABLES].filter((name) => !deployed.has(name));
    expect(missing).toEqual([]);
  });

  it('nothing on the allowlist is a money callable', () => {
    const money = [
      'createInvoice', 'updateInvoice', 'markInvoicePaid', 'archiveInvoice', 'unarchiveInvoice',
      'generateInvoicePdf', 'generateReceipt', 'postInvoiceEvent', 'repairInvoicePayments',
      'sendInvoiceReminder', 'reviewAndSendDraftInvoice', 'createQuote', 'resendQuote',
      'listUninvoicedSessions', 'setSessionDoNotInvoice', 'logExpense', 'listExpenses',
      'payInvoice', 'redeemCredit',
    ];
    const leaked = money.filter((n) => AUNTIE_ALLOWED_CALLABLES.has(n));
    expect(leaked).toEqual([]);
  });

  it('nothing on the allowlist mints or revokes a claim', () => {
    const claims = [
      'setKinfolkClaim', 'revokeKinfolkClaim', 'provisionBusinessAdmins', 'setBusinessAdmins',
      'removeBusinessAdmins', 'listBusinessAdmins', 'checkBusinessAdmins', 'executePrimaryRecovery',
      'setMemberPermissions', 'removeMember', 'setFeatureFlags',
    ];
    const leaked = claims.filter((n) => AUNTIE_ALLOWED_CALLABLES.has(n));
    expect(leaked).toEqual([]);
  });

  it('nothing on the allowlist reads a dossier or the household bank', () => {
    const banks = ['getDossier', 'saveDossier', 'upsertHouseholdBank'];
    const leaked = banks.filter((n) => AUNTIE_ALLOWED_CALLABLES.has(n));
    expect(leaked).toEqual([]);
  });
});

describe('#944 wrapAdminCallable enforces the table', () => {
  it('admits the owner to a money callable', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('markInvoicePaid', async () => ({ ok: true }));
    await expect(wrapped({ auth: ownerAuth } as never)).resolves.toMatchObject({ ok: true });
  });

  it('REFUSES an Auntie a money callable', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    for (const name of ['markInvoicePaid', 'createInvoice', 'updateInvoice', 'logExpense', 'generateReceipt']) {
      const wrapped = wrapAdminCallable(name, async () => ({ ok: true }));
      await expect(wrapped({ auth: auntieAuth } as never)).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('REFUSES an Auntie a claim-minting callable', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    for (const name of ['setKinfolkClaim', 'revokeKinfolkClaim', 'setBusinessAdmins', 'setMemberPermissions']) {
      const wrapped = wrapAdminCallable(name, async () => ({ ok: true }));
      await expect(wrapped({ auth: auntieAuth } as never)).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('REFUSES an Auntie the marketing and business-phone callables', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    for (const name of ['broadcastMessage', 'scheduleMarketingBlast', 'sendExternalMessage', 'screenCallAction']) {
      const wrapped = wrapAdminCallable(name, async () => ({ ok: true }));
      await expect(wrapped({ auth: auntieAuth } as never)).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('admits an Auntie to the callables her job needs', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    for (const name of [
      'createKinCareSession', 'updateKinCareSession', 'setVisitLifecycle', 'verifyVisitArrival',
      'listPendingBookingRequests', 'dispatchVisitNotification', 'triageOrphanReport',
      'saveMediaTags', 'listConversations', 'replyToConversation', 'listStaff',
    ]) {
      const wrapped = wrapAdminCallable(name, async () => ({ ok: true }));
      await expect(wrapped({ auth: auntieAuth } as never)).resolves.toMatchObject({ ok: true });
    }
  });

  it('still refuses a caller with neither role, and an unauthenticated one', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const wrapped = wrapAdminCallable('listStaff', async () => ({ ok: true }));
    await expect(wrapped({ auth: { uid: 'stranger', token: {} } } as never))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(wrapped({ auth: undefined } as never))
      .rejects.toMatchObject({ code: 'unauthenticated' });
  });

  /**
   * A double-claimed account should not exist. If one is minted by hand it must
   * get the caretaker boundary, matching firestore.rules:isOwner().
   */
  it('a double-claimed account gets the Auntie boundary on a money callable', async () => {
    const { wrapAdminCallable } = await import('../src/lib/wrapAdminCallable');
    const both = { uid: 'confused-1', token: { admin: true, staffRole: 'auntie' } };
    const money = wrapAdminCallable('markInvoicePaid', async () => ({ ok: true }));
    await expect(money({ auth: both } as never)).rejects.toMatchObject({ code: 'permission-denied' });
    const allowed = wrapAdminCallable('listStaff', async () => ({ ok: true }));
    await expect(allowed({ auth: both } as never)).resolves.toMatchObject({ ok: true });
  });
});

/**
 * The money callables in the PORTAL tree, which `wrapAdminCallable` does not
 * wrap. Each passes `req.auth?.token?.admin === true` into
 * `requireKinfolkPrimary` / `resolveKinfolkAccess`, so an Auntie is refused by
 * construction: she carries no `admin` claim, falls through to the non-staff
 * branch, has no `clients/{uid}.kinfolkIds`, and is denied.
 *
 * "Refused by construction" is exactly the kind of guarantee that evaporates
 * when somebody later threads the new bypass through for consistency. This
 * pins the source: a money callable must NOT call staffBypass, because being
 * on that gate at all is the bug.
 */
/**
 * The allowlist admits by NAME. That is not the end of the question for a
 * callable that writes: `wrapAdminCallable` lets an Auntie in, and from there
 * the handler runs on the Admin SDK, where the rules' `caretakerMoneyUnchanged()`
 * pin never evaluates. So each allowlisted WRITE has to be checked for a money
 * field of its own.
 */
describe('#944 allowlisted write callables cannot reach money on their own', () => {
  const SESSION_WRITERS = ['admin/updateKinCareSession.ts', 'admin/createKinCareSession.ts'];
  it('neither session writer accepts a money field in its schema', () => {
    // `invoiceId` is the money link on kin_care_sessions. Neither callable may
    // take it as an argument, whoever is calling.
    const offenders = SESSION_WRITERS.filter((rel) => {
      const src = readFileSync(resolve(__dirname, '../src', rel), 'utf8');
      const args = src.slice(src.indexOf('z\n  .object(') >= 0 ? src.indexOf('z\n  .object(') : src.indexOf('z.object('));
      const schema = args.slice(0, args.indexOf('});') + 3);
      return /invoiceId|priceCents|amountMinor|sitterRate|sitterPayout|passthrough|catchall/.test(schema);
    });
    expect(offenders).toEqual([]);
  });
  /**
   * serviceType carries no money, but it is the join key the money is computed
   * FROM: listUninvoicedSessions matches it against business_settings.
   * serviceRates, which is owner-only because it is the price book. A caretaker
   * changing the service on a finished visit would move what the household is
   * billed without ever seeing a rate, and no Firestore rule can catch it,
   * because the callable runs on the Admin SDK.
   */
  it('updateKinCareSession refuses a caretaker who tries to re-price a visit', async () => {
    const { updateKinCareSessionHandler } = await import('../src/admin/updateKinCareSession');
    await expect(
      updateKinCareSessionHandler({
        auth: auntieAuth,
        data: { sessionId: 's1', serviceType: 'Overnight' },
      } as never),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('but still lets her fix the notes on a visit she worked', async () => {
    const { updateKinCareSessionHandler } = await import('../src/admin/updateKinCareSession');
    // `not-found` IS THE ASSERTION, not an accident of the fixture. It can only
    // be reached by getting past the caretaker guard and into the document
    // lookup, so it is what proves a legitimate edit still goes through.
    // `permission-denied` here would mean the guard had grown over-broad and
    // taken the Auntie's own job with it, which is what this test exists to
    // catch. The Firestore stub is empty precisely so the lookup misses.
    await expect(
      updateKinCareSessionHandler({
        auth: auntieAuth,
        data: { sessionId: 'no-such-session', notes: 'gate sticks, lift and push' },
      } as never),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
describe('#944 money callables in the portal keep the owner-only bypass', () => {
  const MONEY_PORTAL_FILES = [
    'portal/payInvoice.ts',
    'portal/redeemCredit.ts',
    'portal/billing.ts',
    'portal/quoteDecision.ts',
    'portal/getMyInvoices.ts',
    'portal/getMyInvoicePdf.ts',
  ];
  it('none of them routes its staff check through staffBypass', () => {
    const offenders = MONEY_PORTAL_FILES.filter((rel) =>
      readFileSync(resolve(__dirname, '../src', rel), 'utf8').includes('staffBypass'),
    );
    expect(offenders).toEqual([]);
  });
  it('and each still has a staff check to speak of', () => {
    // Guards the test above from passing because a file was renamed away.
    const withoutGate = MONEY_PORTAL_FILES.filter((rel) => {
      const src = readFileSync(resolve(__dirname, '../src', rel), 'utf8');
      return !src.includes("req.auth?.token?.admin === true");
    });
    expect(withoutGate).toEqual([]);
  });
});
describe('#944 the ADR-0002 invoice-write gate refuses an Auntie', () => {
  /**
   * resolveInvoiceWriteActor is the gate every invoice-write callable goes
   * through so the Invoice State Classifier stamp cannot be skipped. An Auntie
   * fails it twice over: no `admin` claim, and no `testTribeId` sandbox scope.
   * That is fail-closed by construction rather than by a decision anyone made,
   * which is exactly why it is pinned here.
   */
  it('refuses an Auntie, and still admits the owner', async () => {
    const { resolveInvoiceWriteActor } = await import('../src/lib/testMode');
    expect(() => resolveInvoiceWriteActor({ auth: auntieAuth } as never, 'createInvoice'))
      .toThrowError(/permission-denied|Admin claim required/);
    expect(resolveInvoiceWriteActor({ auth: ownerAuth } as never, 'createInvoice'))
      .toMatchObject({ uid: 'owner-1' });
  });

  it('still admits a Stage-0I sandbox test admin, scoped', async () => {
    const { resolveInvoiceWriteActor } = await import('../src/lib/testMode');
    const actor = resolveInvoiceWriteActor(
      { auth: { uid: 'test-admin', token: { testTribeId: 'test-kinfolk-001' } } } as never,
      'createInvoice',
    );
    expect(actor.testMode.active).toBe(true);
  });
});
