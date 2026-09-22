import { KINFOLK, RESET_KINFOLK, STAFF } from './fixtures/accounts';

/**
 * Emulator seed for the portal's Cypress harness, run once per run (see
 * `cypress.config.ts`).
 *
 * PLAIN REST, no `firebase-admin`. The emulators expose the same
 * identitytoolkit and Firestore REST surfaces the SDKs speak, and
 * `Authorization: Bearer owner` bypasses security rules on both, so the admin
 * SDK would buy nothing but a 60 MB dependency and a service-account code path
 * that does not exist here. `auntieos-admin/e2e/seed.ts` established this
 * pattern in this repo; this follows it rather than inventing a second one.
 *
 * IT SEEDS LESS THAN THE ADMIN HARNESS DOES, and that is a property of the app
 * rather than an omission. The portal reads almost everything through callables
 * (58 call sites), and those are pinned to an unserved port and answered by
 * `cypress/support/callables.ts` instead. Only four modules touch Firestore
 * directly (`lib/breadcrumbs.ts`, `lib/messagesListener.ts`, `lib/activeTribe.ts`
 * and `screens/Messages.tsx`), so those are the paths worth writing rows for.
 *
 * IT WIPES BEFORE IT WRITES. Emulator state survives a crashed run, and a
 * half-seeded database that then gets seeded again produces duplicate rows,
 * which reads as a broken assertion rather than as leftover state. Wiping is
 * safe here and nowhere else: these URLs are hardcoded to localhost ports that
 * only `mytribe/e2e.firebase.json` opens.
 */

const PROJECT = 'auntieos-ttpc';
const AUTH = 'http://127.0.0.1:9499';
const FIRESTORE = 'http://127.0.0.1:8485';
const OWNER = { Authorization: 'Bearer owner' };

/**
 * Every call goes through this. A seeder that swallows a failure hands the
 * specs an empty database and lets them fail somewhere else entirely, with a
 * message about a missing row instead of about the write that never happened.
 */
async function must(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    throw new Error(`portal e2e seed failed at ${what}: ${res.status} ${await res.text()}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function wipe(): Promise<void> {
  await must(
    await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE', headers: OWNER }),
    'wipe auth',
  );
  await must(
    await fetch(`${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
      method: 'DELETE',
      headers: OWNER,
    }),
    'wipe firestore',
  );
}

/** Creates the account, then stamps its custom claims. Returns the uid. */
async function createUser(
  email: string,
  password: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const signUp = await must(
    await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }),
    `signUp ${email}`,
  );
  const localId = signUp.localId as string;
  // Claims are a JSON STRING in this API, not an object. Passing an object is
  // accepted and then silently stored as "[object Object]", which decodes to no
  // claims at all, and here that would deny every rules-gated Firestore read
  // with no error anywhere near the cause.
  await must(
    await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ localId, customAttributes: JSON.stringify(claims) }),
    }),
    `claims ${email}`,
  );
  return localId;
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
  throw new Error(`portal e2e seed cannot encode ${typeof v}`);
}

/** `path` is a full document path, so subcollections are written the same way. */
async function put(path: string, id: string, doc: Record<string, unknown>): Promise<void> {
  const url = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}?documentId=${id}`;
  const fields = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, enc(v)]));
  await must(
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ fields }),
    }),
    `${path}/${id}`,
  );
}

export default async function seed(): Promise<void> {
  await wipe();

  // `kinfolkId` is the claim `firestore.rules` reads for the direct reads this
  // app still makes (live breadcrumbs, the messages listener). `setActiveTribe`
  // is what re-mints it in production, after a pick; here the seed writes it
  // once because the seeded kinfolk has exactly one household and can never
  // pick another.
  const uid = await createUser(KINFOLK.email, KINFOLK.password, { kinfolkId: KINFOLK.kinfolkId });

  // The row `getMyAccess` reads in production. The callable itself is stubbed in
  // this harness, so nothing in a spec depends on this document. It is written
  // so the emulator database is a shape the real callable could have produced,
  // rather than one that only makes sense next to the stub.
  await put('clients', uid, {
    email: KINFOLK.email,
    kinfolkIds: [KINFOLK.kinfolkId],
    createdAt: new Date('2026-07-01T10:00:00Z'),
  });

  await put('kinfolk', KINFOLK.kinfolkId, {
    displayName: KINFOLK.displayName,
    email: KINFOLK.email,
    phoneNumber: '+15555550143',
    createdAt: new Date('2026-07-01T10:00:00Z'),
  });

  // One inbound message so the Messages screen has a thread to render. Its
  // listener is `lib/messagesListener.ts`, one of the four modules that read
  // Firestore directly, so this row is exercised rather than decorative.
  await put(`conversations/${KINFOLK.kinfolkId}/messages`, 'e2e-msg-1', {
    body: 'Wren is settled in for the night.',
    direction: 'inbound',
    authorName: 'Auntie',
    createdAt: new Date('2026-07-02T18:30:00Z'),
  });

  // #892: the password-reset spec's own accounts, so resetting them never
  // touches the KINFOLK login every other spec signs in with.
  await createUser(RESET_KINFOLK.email, RESET_KINFOLK.password, { kinfolkId: RESET_KINFOLK.kinfolkId });
  await createUser(STAFF.email, STAFF.password, { admin: true });
}
