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

/**
 * The emulators' project id. `auntieos-ttpc` for the PR-time suite, which runs
 * auth and Firestore only. The real-services run (#1194) starts all three
 * emulators under a `demo-` id so the functions emulator cannot resolve a
 * production secret, and names it in `E2E_PROJECT_ID`; anything else there is
 * refused, because seeding wipes the project it is pointed at. Same rule as
 * `auntieos-admin/e2e/seed.ts`.
 */
const PROJECT = (() => {
  const id = process.env.E2E_PROJECT_ID ?? '';
  if (id === '') return 'auntieos-ttpc';
  if (!id.startsWith('demo-')) throw new Error(`E2E_PROJECT_ID must be a demo- project id, got "${id}"`);
  return id;
})();
const AUTH = 'http://127.0.0.1:9499';
const FIRESTORE = 'http://127.0.0.1:8485';
const OWNER = { Authorization: 'Bearer owner' };
/**
 * How long one seed call may take. 10s by default, which bare emulators beat by
 * orders of magnitude. The real-services run raises it (`E2E_SEED_TIMEOUT_MS`
 * in `scripts/e2e-real/run.sh`) because every `signUp` there runs the real
 * `beforeSignIn` and `onAuthUserCreate`, and their cold starts take seconds.
 * A malformed value is fatal rather than quietly reverting to the default.
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

/**
 * Every call goes through this. A seeder that swallows a failure hands the
 * specs an empty database and lets them fail somewhere else entirely, with a
 * message about a missing row instead of about the write that never happened.
 *
 * It also carries the deadline, so an emulator that accepts the connection and
 * never answers fails here, naming the call, instead of parking the run.
 */
async function must(url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  const budget = seedTimeoutMs();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(budget) });
  } catch (cause) {
    const failed =
      (cause as { name?: string } | undefined)?.name === 'TimeoutError'
        ? `timed out after ${budget}ms at ${what}. Raise E2E_SEED_TIMEOUT_MS if this machine is genuinely that slow`
        : `could not reach the emulator at ${what}. Are the emulators up?`;
    throw new Error(`portal e2e seed ${failed}`, { cause });
  }
  if (!res.ok) {
    throw new Error(`portal e2e seed failed at ${what}: ${res.status} ${await res.text()}`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function wipe(): Promise<void> {
  await must(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE', headers: OWNER }, 'wipe auth');
  await must(
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
  const signUp = await must(
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
  // claims at all, and here that would deny every rules-gated Firestore read
  // with no error anywhere near the cause.
  await must(
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

function fieldsOf(doc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, enc(v)]));
}

/** `path` is a full document path, so subcollections are written the same way. */
async function put(path: string, id: string, doc: Record<string, unknown>): Promise<void> {
  await must(
    `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}?documentId=${id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ fields: fieldsOf(doc) }),
    },
    `${path}/${id}`,
  );
}

/**
 * Merges the given fields into one document, creating it when absent.
 *
 * `updateMask` is what makes it a merge: only the named fields are written, so
 * a field another writer put there survives. That matters for `clients/{uid}`
 * in the real-services run, where `onAuthUserCreate` writes the same document
 * (email, displayName, timestamps, never `kinfolkIds`) at a moment the seed
 * does not control. A plain `put` there answers 409 when the trigger got in
 * first. Exported for the real-services config's `upsertDoc` task.
 */
export async function upsert(path: string, id: string, doc: Record<string, unknown>): Promise<void> {
  const mask = Object.keys(doc)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  await must(
    `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}/${id}?${mask}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...OWNER },
      body: JSON.stringify({ fields: fieldsOf(doc) }),
    },
    `${path}/${id} (upsert)`,
  );
}

/** Deletes one document, for a spec's own `after`. */
export async function remove(path: string, id: string): Promise<void> {
  await must(
    `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}/${id}`,
    { method: 'DELETE', headers: OWNER },
    `delete ${path}/${id}`,
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
  //
  // An UPSERT, not a put: under the real-services run `onAuthUserCreate` writes
  // this same document after the signUp above, and may land first.
  await upsert('clients', uid, {
    email: KINFOLK.email,
    kinfolkIds: [KINFOLK.kinfolkId],
    createdAt: new Date('2026-07-01T10:00:00Z'),
  });
  // The household's PRIMARY member row, the shape `acceptInvite` writes. The
  // billing gates (`requireBillingAccess`, `requireBillingActor`) let a missing
  // row through as a legacy primary, with a `portal.member.missing` warning on
  // every call; this row is the production shape instead of that fallback.
  await put(`families/${KINFOLK.kinfolkId}/members`, uid, {
    uid,
    displayName: KINFOLK.displayName,
    email: KINFOLK.email,
    role: 'PRIMARY',
    status: 'ACTIVE',
    permissions: {
      billing_full: true,
      messaging_direct: true,
      messaging_group: true,
      kin_edit: true,
      kintales_only: true,
      home_access: true,
    },
    updatedAt: new Date('2026-07-01T10:00:00Z'),
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
