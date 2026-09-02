import { ADMIN, KINFOLK, SEEDED_BOOKINGS } from './fixtures/accounts';
import { seedDenseRows } from './seed.rows';

/**
 * Emulator seed, run once per `playwright test` invocation (globalSetup).
 *
 * PLAIN REST, no `firebase-admin`. The emulators expose the same
 * identitytoolkit and Firestore REST surfaces the SDKs speak, and
 * `Authorization: Bearer owner` bypasses security rules on both, so the admin
 * SDK would buy nothing but a 60 MB dependency and a service-account code path
 * that does not exist here. The older wasm harness's seed script established
 * this pattern in this repo; this file follows it rather than inventing a
 * second one.
 *
 * IT WIPES BEFORE IT WRITES. Emulator state survives a crashed run, and a
 * half-seeded database that then gets seeded again produces duplicate rows,
 * which reads as a broken assertion rather than as leftover state. Wiping is
 * safe here and nowhere else: these URLs are hardcoded to localhost ports that
 * only `e2e/firebase.json` opens.
 */

const PROJECT = 'auntieos-ttpc';
const AUTH = 'http://127.0.0.1:9399';
const FIRESTORE = 'http://127.0.0.1:8385';
const OWNER = { Authorization: 'Bearer owner' };

/**
 * How long any one seed call may take before it is called a failure.
 *
 * Nothing here is waiting on a boot: `npm run e2e` wraps this whole run in
 * `firebase emulators:exec`, so both emulators are already listening by the
 * time globalSetup starts. A healthy local emulator answers each of these
 * calls in single-digit milliseconds, and the heaviest of them, the Firestore
 * wipe against a fully seeded database, stays well under a second. Ten seconds
 * is orders of magnitude past that, which leaves room for a loaded CI box
 * while still failing in seconds rather than burning the whole step budget.
 *
 * `E2E_SEED_TIMEOUT_MS` raises it for a machine that genuinely needs more. A
 * malformed value is fatal rather than silently falling back, for the same
 * reason `E2E_SEED_NOW`'s is: a deadline that quietly reverts to its default
 * fails later for no nameable reason.
 */
function seedTimeoutMs(): number {
  const raw = process.env.E2E_SEED_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 10_000;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`E2E_SEED_TIMEOUT_MS is not a positive number of ms: "${raw}"`);
  }
  return ms;
}
/** `127.0.0.1:8385`, for a message that says which emulator went quiet. */
function hostPort(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
/**
 * Every call goes through this. A seeder that swallows a failure hands the
 * specs an empty database and lets them fail somewhere else entirely, with a
 * message about a missing row instead of about the write that never happened.
 *
 * IT ALSO CARRIES THE DEADLINE, and that is the point of the helper. Playwright
 * puts no timeout on globalSetup and `fetch` has none of its own, so an
 * emulator that accepts the connection and then never answers parks the whole
 * run with no error at all -- the same shape as the apt stall that sat on three
 * CI jobs for hours (#456). The E2E step now carries a 7-minute cap, so the
 * cost is bounded, but a cap only ever reports "the operation was canceled".
 * The deadline is what makes the failure legible: it names the seed call and
 * the emulator that owed the answer.
 *
 * The signal covers reading the body too, not just the headers, so a response
 * that starts and never finishes is caught the same way.
 */
async function seedFetch(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Record<string, unknown>> {
  const budget = seedTimeoutMs();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(budget) });
  } catch (cause) {
    // `AbortSignal.timeout` aborts with a `TimeoutError`; anything else here is
    // the connection itself failing, which is a different thing to go and look
    // at, so the two do not share a message.
    const failed =
      (cause as { name?: string } | undefined)?.name === 'TimeoutError'
        ? `timed out after ${budget}ms at ${what}: ${hostPort(url)} accepted the connection and never answered. Raise E2E_SEED_TIMEOUT_MS if this machine is genuinely that slow`
        : `could not reach ${hostPort(url)} at ${what}. Are the emulators up? (npm run e2e starts them)`;
    throw new Error(`e2e seed ${failed}`, { cause });
  }
  if (!res.ok) {
    throw new Error(`e2e seed failed at ${what}: ${res.status} ${await res.text()}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function wipe(): Promise<void> {
  await seedFetch(
    `${AUTH}/emulator/v1/projects/${PROJECT}/accounts`,
    { method: 'DELETE', headers: OWNER },
    'wipe auth',
  );
  await seedFetch(
    `${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: 'DELETE', headers: OWNER },
    'wipe firestore',
  );
}

/** Creates the account, then stamps its custom claims. Returns the uid. */
async function createUser(
  email: string,
  password: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const signUp = await seedFetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
    `signUp ${email}`,
  );
  const localId = signUp.localId as string;
  // Claims are a JSON STRING in this API, not an object. Passing an object is
  // accepted and then silently stored as "[object Object]", which decodes to no
  // claims at all and denies the admin at the gate with no error anywhere.
  await seedFetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ localId, customAttributes: JSON.stringify(claims) }),
    },
    `claims ${email}`,
  );
  return localId;
}

/**
 * Resets one seeded account's password, by email, without touching its uid or
 * its claims.
 *
 * FOR THE CYPRESS ACCOUNT SPEC, which changes the admin's password through the
 * real Security panel and must hand every later spec file the fixture password
 * back. Restoring through the form again would leave a mid-spec failure holding
 * a password nobody knows; a REST reset from an `after()` task survives that.
 * Same owner-bearer surface `createUser` already uses, so no new plumbing.
 *
 * `accounts:lookup` rather than remembering the uid from the seed: the seed ran
 * in this process at most once and may not have run at all (`cypress open`
 * against a database a crashed run left behind), so the email is the only
 * stable handle.
 */
export async function setPassword(email: string, password: string): Promise<void> {
  const lookup = await seedFetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:lookup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ email: [email] }),
    },
    `lookup ${email}`,
  );
  const users = lookup.users as Array<{ localId?: string }> | undefined;
  const localId = users?.[0]?.localId;
  if (!localId) throw new Error(`setPassword: no auth-emulator account for ${email}`);
  await seedFetch(
    `${AUTH}/identitytoolkit.googleapis.com/v1/accounts:update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ localId, password }),
    },
    `password ${email}`,
  );
}
/** JS value -> Firestore REST `Value`. Only the shapes this seed writes. */
function enc(v: unknown): Record<string, unknown> {
  if (v === null) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, enc(x)]);
    return { mapValue: { fields: Object.fromEntries(entries) } };
  }
  throw new Error(`e2e seed cannot encode ${typeof v}`);
}

export async function put(
  collection: string,
  id: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const url = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}?documentId=${id}`;
  const fields = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, enc(v)]));
  await seedFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ fields }),
    },
    `${collection}/${id}`,
  );
}

/**
 * `startTime` is an ISO STRING and `createdAt` is a real Timestamp, and that
 * asymmetry is the collection's, not this seeder's: `approveBookingSeriesCore`
 * writes exactly that pair (see `src/api/bookings.ts`). Seeding both as
 * Timestamps would make `BOOKINGS_QUERY` look correct here and fail on real
 * data, which is the whole failure mode an e2e harness exists to catch.
 */
function isoDaysFromNow(days: number): string {
  return new Date(seedNow() + days * 86_400_000).toISOString();
}

/**
 * The instant "now" means for this seed, in ms.
 *
 * Real wall clock by default, so `npm run e2e` behaves exactly as it always
 * has. `E2E_SEED_NOW` overrides it with a fixed ISO instant, for a run that has
 * to be reproducible: a row that says "in 3 days" only means the same thing
 * twice if the seed and the browser's clock agree on the same origin. A
 * malformed value is fatal rather than silently falling back, because a seed
 * that quietly reverts to the wall clock fails tomorrow for no nameable
 * reason.
 */
export function seedNow(): number {
  const pinned = process.env.E2E_SEED_NOW;
  if (pinned === undefined || pinned === '') return Date.now();
  const ms = Date.parse(pinned);
  if (Number.isNaN(ms)) throw new Error(`E2E_SEED_NOW is not a date: "${pinned}"`);
  return ms;
}

export default async function seed(): Promise<void> {
  await wipe();

  const adminUid = await createUser(ADMIN.email, ADMIN.password, { admin: true });
  // No `admin`, no `testTribeId`. `accessFromClaims` must return `denied`.
  await createUser(KINFOLK.email, KINFOLK.password, { role: 'kinfolk', kinfolkId: 'e2e-kf-1' });
  // THE OPERATOR'S HOME BOARD, seeded rather than assumed.
  //
  // `no-production-egress.spec.ts` needs a callable-backed card on Home: its
  // whole subject is what an unstubbed callable does on screen, and the shipped
  // default board (stats + Today's Pack + KinTales) is fed entirely by Firestore
  // streams, so it would fire no callable at all. This layout is the seven cards
  // this admin drew before the D2 port, which is the board those specs were
  // written against, now stored as an ordinary customized layout instead of
  // arriving as a display fallback the screen no longer has.
  //
  // Token strings, not objects: `users/{uid}.dashboardWidgets` is an ordered
  // list of "key:size" (see `src/lib/dashboardLayout.ts`), read identically by
  // this admin and by android.
  await put('users', adminUid, {
    dashboardWidgets: [
      'safebox:compact',
      'unreadMessages:compact',
      'careFlags:compact',
      'expirations:compact',
      'routeOptimizer:compact',
      'expenseLog:compact',
      'supplies:compact',
    ],
  });

  await put('kinfolk', 'e2e-kf-1', {
    firstName: 'Wanda',
    lastName: 'Thorne',
    email: 'wanda@example.test',
    createdAt: new Date('2026-01-04T09:00:00Z'),
  });
  await put('kinfolk', 'e2e-kf-2', {
    firstName: 'Nora',
    lastName: 'Halbrook',
    email: 'nora@example.test',
    createdAt: new Date('2026-01-05T09:00:00Z'),
  });

  const { today, scheduled, completed, cancelled } = SEEDED_BOOKINGS;
  // Midday, so it lands on the same calendar day in every timezone a run might
  // use. `isoDaysFromNow(0)` alone is "now", which near midnight is yesterday
  // or tomorrow depending on the machine, and Schedule groups by LOCAL day.
  await put('kin_care_sessions', today.id, {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: today.kinfolkName,
    serviceType: today.serviceType,
    status: 'SCHEDULED',
    startTime: new Date(seedNow()).toISOString().slice(0, 10) + 'T12:00:00.000Z',
    createdAt: new Date('2026-07-21T10:00:00Z'),
  });
  await put('kin_care_sessions', scheduled.id, {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: scheduled.kinfolkName,
    serviceType: scheduled.serviceType,
    status: 'SCHEDULED',
    startTime: isoDaysFromNow(3),
    kinfolkNotes: 'Side gate code is 4417.',
    createdAt: new Date('2026-07-20T10:00:00Z'),
  });
  await put('kin_care_sessions', completed.id, {
    kinfolkId: 'e2e-kf-2',
    kinfolkName: completed.kinfolkName,
    serviceType: completed.serviceType,
    // Lowercase ON PURPOSE. Status casing is unenforced across this collection,
    // and a seed that only ever writes SCREAMING CASE would let a server-side
    // equality filter pass here and drop real visits in production.
    status: 'completed',
    startTime: isoDaysFromNow(-4),
    completedAt: isoDaysFromNow(-4),
    // THE OTHER HALF OF A LINK. `vis-invoice-001.sessionIds` has named this
    // visit since the rows were written, and the visit named nothing back, which
    // is exactly the half-written link `getInvoiceLedger` reports as
    // `linkedBack: false` and the detail panel calls out as a visit that can be
    // billed a second time. That is a real shape and it deserves a test; it does
    // not deserve to be the fixture behind the invoice detail panel, where it
    // would put a warning banner on a screen the specs read. `linkInvoiceSessions`
    // writes
    // both directions in one transaction, so this is what a correctly linked
    // visit looks like.
    invoiceId: 'vis-invoice-001',
    createdAt: new Date('2026-07-19T10:00:00Z'),
  });
  await put('kin_care_sessions', cancelled.id, {
    kinfolkId: 'e2e-kf-1',
    kinfolkName: cancelled.kinfolkName,
    serviceType: cancelled.serviceType,
    status: 'CANCELLED',
    startTime: isoDaysFromNow(-1),
    createdAt: new Date('2026-07-18T10:00:00Z'),
  });

  // Invoices, activity, notifications, KinTales and the Inbox channel lists.
  // They live in their own module because they are long, and they add NO
  // `kin_care_sessions` row, because `bookings.spec.ts` asserts an exact count
  // on that collection. See `seed.rows.ts` for why they are no longer
  // capture-only: without them every list screen in this suite renders its
  // empty state, and an empty list cannot be measured for overflow.
  await seedDenseRows(put, seedNow());
}
