/**
 * purgeFakeRecords.ts
 *
 * Issue #1082. Finds, and on request deletes, the test records that carry an
 * invented or reserved email address (`@tribetails.test` and the like). Every
 * send to one of those addresses bounces, and the bounces hurt the sender rating.
 * Operator ruling 2026-09-30: delete them from production.
 *
 * It finds them BY ADDRESS SHAPE (lib/reservedEmailDomain.ts), never from a list
 * of known ids. The 2026-09-30 trace expects the sandbox household
 * `test-kinfolk-001`, the July invite-test accounts (`e2e-claim-*@`,
 * `e2e-o35@tribetails.test`) and the demo households `demo-family-001`/`-002`,
 * but the run reports what the data holds, not what this comment expects.
 *
 * ── MODES ─────────────────────────────────────────────────────────────────
 *
 *   default        READ ONLY. Prints the plan and writes nothing.
 *   --apply        deletes the plan this same run just printed. Needs
 *                  --confirm <fingerprint>: the read-only run ends with a
 *                  "Plan fingerprint" (a hash of every path and uid it listed),
 *                  and --apply refuses, before any delete, when its own scan's
 *                  fingerprint differs. So the delete run removes exactly what
 *                  the operator read, or nothing.
 *   --dry-run      forces read only, and BEATS --apply in either flag order.
 *   --allow-prod   the target is PRODUCTION. Required to reach production at
 *                  all. Refused when an emulator host is set. --allow-prod says
 *                  WHERE, --apply says WHETHER TO DELETE. They are separate on
 *                  purpose (same model as repairDuplicateVetClinicId.ts), so the
 *                  read-only production run and the deleting production run are
 *                  two different commands:
 *
 *   npm --prefix mytribe/functions run purge:fake-records -- --project auntieos-ttpc --allow-prod
 *   npm --prefix mytribe/functions run purge:fake-records -- --project auntieos-ttpc --allow-prod --apply --confirm <fingerprint>
 *
 * EMULATOR OR PRODUCTION. This script touches Firestore AND Auth. The run is an
 * emulator run only when BOTH FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST are set. Exactly one set is refused: the Firestore
 * deletes would go to the emulator and the Auth deletes to production. Neither
 * set means production, and needs --allow-prod.
 *
 * ── WHAT IS A TARGET ──────────────────────────────────────────────────────
 *
 * A record is fake when ITS OWN contact address is on a reserved domain:
 *
 *   Auth users          `email`                         (listUsers, every page,
 *                                                        disabled users included)
 *   clients/{uid}       `email`, `backupEmail`          F/triggers/onAuthUserCreate.ts:14-16,
 *                                                        F/portal/account.ts:129,150,160
 *   staff/{uid}         `email`                         F/admin/listStaff.ts:30,
 *                                                        F/notifications/senders/emailChannel.ts:86-89
 *   users/{uid}         `email`                         rules users/{uid}; admin
 *                                                        src/api/accountWrite.ts:54,78
 *   kinfolk/{id}        `email`, `secondaryEmail`       F/admin/createKinfolk.ts:99,
 *                       (THE HOUSEHOLD)                 F/admin/broadcastMessage.ts:488
 *   families/{id}/secondaryKinfolk/{p}  `email`         F/portal/secondaryKinfolk.ts:98,229
 *   families/{id}/members/{uid}  `email`, or a
 *                       `displayName` that is an address F/membership/acceptInvite.ts:213-215,
 *                                                        F/portal/listMembers.ts:102
 *   inviteRequests/{id} `invitedEmail`                  F/admin/mintInvite.ts:57-60,
 *                                                        F/portal/addSecondaryContact.ts:180-183
 *   payments/{id}       `email`                         F/admin/recordPayment.ts:151,646
 *   passwordResetRequests/{id}  `email`                 F/auth/requestPasswordReset.ts:158-160
 *
 * A household is fake only when the kinfolk doc's own address is reserved. A fake
 * person being a member of a REAL household never makes that household a
 * target, and a real `clients/{uid}` whose `kinfolkIds` names a fake household
 * (seedDemoKinfolk.ts's --link-uid does exactly this) is never deleted: it is
 * listed under "left in place" so the operator can see the dangling id.
 *
 * ── WHAT ELSE GOES WITH THEM ──────────────────────────────────────────────
 *
 * For each fake household H:
 *   kinfolk/H, families/H and EVERY subcollection under it, found with
 *     listCollections, not a fixed list (members, secondaryKinfolk, kin,
 *     bookings/{b}/kinCares/{v}/notes, invoices, homeAccess, creditLedger,
 *     messages/{t}/items, kinTales, legacyEcServed, ... rules :811-1087)
 *   conversations/H (+ messages)                        rules :1522-1525
 *   household_bank/H                                    rules :1343
 *   `kinfolkId == H` in kin, invoices, payments, kin_care_sessions,
 *     kin_care_reports, enhanced_bookings, household_data, visit_logs,
 *     visit_routes, location_sharing_preferences, sms_messages, emails,
 *     calls_log, voicemails, media_files, dossiers
 *     (rules :541,556,571,656,1397; Android AuntieRepository.kt:2016,2278,1928,
 *     1959; reconcile_comms.py:53-58,480)
 *   `familyId == H` in stripePayments, stripeDisputes   F/billing/stripeWebhook.ts:471
 *   `tribeId == H` in inviteRequests, recoveryRequests, sharedKinTales
 *     (F/admin/provisionTribe.ts:41-44, F/recovery/requestPrimaryRecovery.ts:56,
 *     F/share/createShareLink.ts:61)
 *   `kinfolk_id == H` in generated_drafts; `targetKinfolkId == H` in
 *     training_documents; `entityId == H` in dynamic_field_values and media_files
 *   the_411/{id} whose `kinId` is one of H's flat kin  (reconcile_comms.py:588-594)
 *   kinTaleNotifications/{reportId} for H's kin_care_reports
 *   notifications and notificationDispatch whose `data.kinfolkId` or
 *     `data.familyId` is H, and notifications with targetType 'kinfolk' and
 *     targetId H                                        F/notifications/dispatcher.ts:697-731
 * For each fake uid U (an Auth user with a reserved address, or the uid of a fake
 * clients/staff/users doc):
 *   clients/U (+ security/loginAttempts), staff/U, users/U, admins/U
 *   families/{any}/members/U and families/{any}/legacyEcServed/U
 *   notifications, notificationDispatch, scheduledNotifications with recipientUid U
 *   pendingNotifications/U_*, notificationBatch/U/**, fcm_tokens with uid U
 *   the Auth user U itself, through the Admin SDK
 * Every document found is then expanded with all of its own subcollections
 * (invoices/{id}/payments, kin_care_sessions/{id}/breadcrumbs,
 * kin_care_reports/{id}/comments and /reactions, ...).
 *
 * NEVER TOUCHED: activity_log (the audit trail, and where this script writes),
 * message_suppressions (deleting a suppression would re-allow sends to the very
 * address), securityIncidents, formSchemas (global, live, though both seed
 * scripts write them), business_settings, and anything not listed above.
 *
 * ── REFUSALS ──────────────────────────────────────────────────────────────
 *
 * Before the first delete, every document and Auth user in the plan is checked:
 * each contact address it carries (the fields above, plus the addresses a
 * notification carries in `data.invitedEmail`/`kinfolkEmail`/`staffEmail`/
 * `email` and an `emails` log row's `toAddresses`/`ccAddresses`) must be on a
 * reserved domain. One that is not, or that is one of the protected real
 * accounts (`e2e-admin@tribetails.com`, `catch@hanasamku.com`,
 * `pawsome@hanasamku.com`, any `@tribetails.com`), stops the whole run with the
 * path, the field and the address's domain. Nothing is deleted. A business
 * sender address (`fromAddress`) is not a contact address and is not checked.
 *
 * ── APPLY ─────────────────────────────────────────────────────────────────
 *
 * The apply run scans, prints, checks the addresses and the fingerprint, and
 * then deletes THAT plan, never a fresh query. Deepest paths first, households last, Auth users after Firestore. Each
 * delete is committed in the same batch as its audit row: one `activity_log` row
 * per deleted document or user (`actionType: PURGE_FAKE_RECORD`, `actorId:
 * system:purgeFakeRecords`, unchained like every other operator script, see
 * backfillInvoiceStateStamp.ts), and one console line per deletion.
 *
 * TRIGGERS. Deleting `clients/{uid}` fires onClientsWrite
 * (F/triggers/onClientsWrite.ts:26-41), which clears that uid's claims and
 * merge-writes `kinfolk/{kinfolkIds[0]}.uid = ''`. When that household is also
 * being deleted the merge can recreate it as a stub. So after the deletes the
 * run waits (--settle-seconds, default 10 in production, 0 on the emulator, which
 * runs no functions) and re-reads every planned path, deleting again any that
 * came back, with its own audit row. Only planned paths are ever re-deleted. A
 * fake client whose kinfolkIds[0] is a REAL household makes the trigger write
 * `uid: ''` there; the plan lists those under "trigger side effects", and when
 * that household's `uid` names a different account the run refuses, because the
 * trigger never checks whose uid it clears.
 * Deleting a kin_care_sessions doc makes onKinCareSessionCalendarSync remove its
 * Google Calendar event when a calendar is connected, which is wanted.
 *
 * Also prints the household send gate (`householdNotificationsLive` on
 * business_settings/business_settings, legacy `singleton` fallback), read the
 * same way F/notifications/householdSendGate.ts reads it.
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login) with
 * Firestore and Firebase Auth admin rights, or both emulator hosts for a local run.
 * The operator runs the production forms; an agent session does not.
 */
// The single firebase-admin import point (#846).
import {
  getApps,
  initializeApp,
  getFirestore,
  getAuth,
  FieldValue,
  type Firestore,
  type Auth,
  type QueryDocumentSnapshot,
} from './lib/firebaseAdmin';
import { createHash } from 'crypto';
import { emailDomain, isProtectedEmail, isReservedEmail } from './lib/reservedEmailDomain';
import { HOUSEHOLD_SEND_GATE_FIELD, resolveHouseholdSendGate } from '../functions/src/notifications/householdSendGate';
import { BUSINESS_SETTINGS_DOC, BUSINESS_SETTINGS_DOC_LEGACY } from '../functions/src/lib/businessHours';

export const ACTOR_ID = 'system:purgeFakeRecords';
export const ACTION_TYPE = 'PURGE_FAKE_RECORD';
/** Each delete rides in a batch with its audit row, so 2 ops per delete, under Firestore's 500. */
const DELETES_PER_BATCH = 200;
const IN_LIMIT = 30;
const PAGE = 500;

type DocumentReference = ReturnType<Firestore['doc']>;

// ── Args and target ─────────────────────────────────────────────────────────

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  apply: boolean;
  settleSeconds: number | null;
  /** The plan fingerprint the read-only run printed. --apply requires it and refuses a plan that differs. */
  confirm: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, apply: false, settleSeconds: null, confirm: null };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--project') args.projectId = value();
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--confirm') {
      const v = value().toLowerCase();
      if (!/^[0-9a-f]{12}$/.test(v)) throw new Error(`--confirm takes the 12-character plan fingerprint the read-only run printed, got '${v}'`);
      args.confirm = v;
    } else if (a === '--settle-seconds') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--settle-seconds must be a whole number, got '${v}'`);
      args.settleSeconds = Number(v);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'purgeFakeRecords.ts: finds, and with --apply deletes, records on reserved email domains (#1082)',
          '',
          '  read only : npm --prefix mytribe/functions run purge:fake-records -- --project <id> --allow-prod',
          '  delete    : npm --prefix mytribe/functions run purge:fake-records -- --project <id> --allow-prod --apply --confirm <fingerprint>',
          '',
          'Read only unless --apply. --dry-run forces read only and wins in either flag order.',
          '--apply needs --confirm with the plan fingerprint the read-only run printed, and refuses a plan that differs.',
          '--allow-prod says the target is production; it is refused when an emulator host is set.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (explicitDryRun) args.apply = false;
  if (args.apply && args.confirm === null) {
    throw new Error('--apply needs --confirm <fingerprint>: run without --apply first and copy the "Plan fingerprint" it prints.');
  }
  return args;
}

export type Target =
  | { kind: 'emulator'; firestoreHost: string; authHost: string; projectId: string | null }
  | { kind: 'production'; projectId: string | null };

/** Where this run reads and deletes, or a refusal. Decided before firebase-admin is initialised. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const projectId = args.projectId ?? env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'] ?? null;
  const fsHost = env['FIRESTORE_EMULATOR_HOST'] || undefined;
  const authHost = env['FIREBASE_AUTH_EMULATOR_HOST'] || undefined;
  if (Boolean(fsHost) !== Boolean(authHost)) {
    throw new Error(
      `refusing: only one emulator host is set (FIRESTORE_EMULATOR_HOST=${fsHost ?? '(unset)'}, ` +
        `FIREBASE_AUTH_EMULATOR_HOST=${authHost ?? '(unset)'}). Firestore and Auth would go to different places. ` +
        'Set both for an emulator run, or neither (with --allow-prod) for production.',
    );
  }
  if (fsHost && authHost) {
    if (args.allowProd) {
      throw new Error(
        `refusing --allow-prod: the emulator hosts are set (${fsHost}, ${authHost}), so this run would touch the emulators, not production. Unset them, or drop --allow-prod.`,
      );
    }
    return { kind: 'emulator', firestoreHost: fsHost, authHost, projectId };
  }
  if (!args.allowProd) {
    throw new Error('No emulator host is set, so this run would reach PRODUCTION. Pass --allow-prod to confirm.');
  }
  return { kind: 'production', projectId };
}

export function describeTarget(t: Target, apply: boolean): string {
  const project = t.projectId ?? '(from credentials)';
  const mode = apply ? 'APPLY (DELETES)' : 'READ ONLY (writes nothing)';
  return t.kind === 'emulator'
    ? `Target: EMULATOR firestore ${t.firestoreHost} auth ${t.authHost}, project ${project} - ${mode}`
    : `Target: PRODUCTION, project ${project} - ${mode}`;
}

// ── Contact addresses ───────────────────────────────────────────────────────

/** Keys whose string (or string-array) values are a person's contact address, at any depth. */
export const CONTACT_KEYS: readonly string[] = [
  'email',
  'secondaryEmail',
  'backupEmail',
  'invitedEmail',
  'kinfolkEmail',
  'staffEmail',
  'toAddresses',
  'ccAddresses',
];

export interface Contact {
  field: string;
  address: string;
}

/** Every contact address a document carries, by field path. A members doc's address-shaped displayName counts. */
export function contactsOf(path: string, data: Record<string, unknown> | undefined): Contact[] {
  const out: Contact[] = [];
  if (!data) return out;
  const walk = (v: unknown, prefix: string, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${prefix}[${i}]`, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const field = prefix ? `${prefix}.${k}` : k;
      if (CONTACT_KEYS.includes(k)) {
        const values = Array.isArray(val) ? val : [val];
        values.forEach((s, i) => {
          if (typeof s === 'string' && s.includes('@')) out.push({ field: Array.isArray(val) ? `${field}[${i}]` : field, address: s.trim() });
        });
      } else {
        walk(val, field, depth + 1);
      }
    }
  };
  walk(data, '', 0);
  if (/^families\/[^/]+\/members\/[^/]+$/.test(path)) {
    const dn = data['displayName'];
    if (typeof dn === 'string' && dn.includes('@')) out.push({ field: 'displayName', address: dn.trim() });
  }
  return out;
}

function hasReservedContact(path: string, data: Record<string, unknown> | undefined, fields: readonly string[]): boolean {
  if (!data) return false;
  if (fields.some((f) => isReservedEmail(data[f]))) return true;
  if (/^families\/[^/]+\/members\/[^/]+$/.test(path)) return isReservedEmail(data['displayName']);
  return false;
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface PlannedDoc {
  path: string;
  /** Why it is in the plan, for the printout and the audit row. */
  reason: string;
  contacts: Contact[];
}

export interface PlannedUser {
  uid: string;
  email: string | null;
  disabled: boolean;
  reason: string;
}

export interface Plan {
  households: string[];
  uids: string[];
  docs: PlannedDoc[];
  users: PlannedUser[];
  /** Real clients docs that name a fake household. Left in place. */
  danglingClients: Array<{ path: string; kinfolkIds: string[] }>;
  /** Writes onClientsWrite will make outside the plan when a planned clients doc is deleted. */
  triggerSideEffects: string[];
  /**
   * Those writes that would clear a REAL back-link: onClientsWrite sets
   * kinfolk/{kinfolkIds[0]}.uid = '' without checking whose uid it held. Each one
   * refuses the run.
   */
  triggerConflicts: string[];
  sendGate: { line: string; raw: unknown; source: string };
}

class PlanBuilder {
  readonly docs: Record<string, PlannedDoc> = {};
  constructor(private readonly db: Firestore) {}

  addDoc(path: string, reason: string, data: Record<string, unknown> | undefined): void {
    if (this.docs[path]) return;
    this.docs[path] = { path, reason, contacts: contactsOf(path, data) };
  }

  async addRef(ref: DocumentReference, reason: string): Promise<void> {
    if (this.docs[ref.path]) return;
    const snap = await ref.get();
    // A path with no document (a missing parent of a subcollection) has nothing to delete.
    if (snap.exists) this.addDoc(ref.path, reason, snap.data() as Record<string, unknown>);
  }

  /** Every document under `ref`'s subcollections, at every depth, including ones whose parent doc is missing. */
  async addSubtree(ref: DocumentReference, reason: string): Promise<void> {
    for (const col of await ref.listCollections()) {
      for (const child of await col.listDocuments()) {
        await this.addRef(child, reason);
        await this.addSubtree(child, reason);
      }
    }
  }

  async addWhereIn(collection: string, field: string, values: readonly string[], reason: string): Promise<void> {
    for (let i = 0; i < values.length; i += IN_LIMIT) {
      const chunk = values.slice(i, i + IN_LIMIT);
      if (chunk.length === 0) continue;
      const snap = await this.db.collection(collection).where(field, 'in', chunk).get();
      for (const d of snap.docs) this.addDoc(d.ref.path, `${reason} (${field})`, d.data() as Record<string, unknown>);
    }
  }
}

async function scanCollection(db: Firestore, name: string, visit: (path: string, id: string, data: Record<string, unknown>) => void): Promise<void> {
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(name).orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const d of snap.docs) visit(d.ref.path, d.id, d.data() as Record<string, unknown>);
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
}

async function scanGroup(db: Firestore, name: string, visit: (path: string, data: Record<string, unknown>) => void): Promise<void> {
  const snap = await db.collectionGroup(name).get();
  for (const d of snap.docs) visit(d.ref.path, d.data() as Record<string, unknown>);
}

/** The household send gate, read the way F/notifications/householdSendGate.ts reads it. A failed read throws. */
export async function readSendGate(db: Firestore): Promise<Plan['sendGate']> {
  let source = BUSINESS_SETTINGS_DOC;
  let snap = await db.doc(BUSINESS_SETTINGS_DOC).get();
  if (!snap.exists) {
    const legacy = await db.doc(BUSINESS_SETTINGS_DOC_LEGACY).get();
    if (legacy.exists) {
      snap = legacy;
      source = BUSINESS_SETTINGS_DOC_LEGACY;
    }
  }
  const data = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  const state = resolveHouseholdSendGate(data);
  const raw = data ? data[HOUSEHOLD_SEND_GATE_FIELD] : undefined;
  const meaning =
    state === 'live'
      ? 'ON: household notifications ARE being sent'
      : state === 'absent'
        ? 'OFF (field not set): household notifications are NOT sent'
        : `OFF (value ${JSON.stringify(raw)} is not the boolean true): household notifications are NOT sent`;
  return { line: `Household send gate (${source}.${HOUSEHOLD_SEND_GATE_FIELD}): ${meaning}`, raw, source };
}

/** READS ONLY. Everything the apply run would delete. */
export async function buildPlan(db: Firestore, auth: Auth): Promise<Plan> {
  const b = new PlanBuilder(db);
  const uids: Record<string, string> = {};
  const users: Record<string, PlannedUser> = {};
  const households: string[] = [];

  // 1. Auth users on a reserved domain.
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      if (isReservedEmail(u.email)) {
        users[u.uid] = { uid: u.uid, email: u.email ?? null, disabled: u.disabled, reason: 'Auth email on a reserved domain' };
        uids[u.uid] = 'Auth email on a reserved domain';
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // 2. uid-keyed profile docs on a reserved domain.
  const clientKinfolkIds: Record<string, string[]> = {};
  await scanCollection(db, 'clients', (path, id, data) => {
    const ids = Array.isArray(data['kinfolkIds']) ? (data['kinfolkIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    clientKinfolkIds[path] = ids;
    if (hasReservedContact(path, data, ['email', 'backupEmail'])) uids[id] = uids[id] ?? 'clients doc email on a reserved domain';
  });
  for (const col of ['staff', 'users']) {
    await scanCollection(db, col, (path, id, data) => {
      if (hasReservedContact(path, data, ['email'])) uids[id] = uids[id] ?? `${col} doc email on a reserved domain`;
    });
  }

  // 3. Households whose own address is reserved.
  await scanCollection(db, 'kinfolk', (path, id, data) => {
    if (hasReservedContact(path, data, ['email', 'secondaryEmail'])) {
      households.push(id);
      b.addDoc(path, 'household email on a reserved domain', data);
    }
  });

  // 4. Standalone contact docs on a reserved domain.
  for (const [col, field] of [
    ['inviteRequests', 'invitedEmail'],
    ['payments', 'email'],
    ['passwordResetRequests', 'email'],
  ] as const) {
    await scanCollection(db, col, (path, _id, data) => {
      if (isReservedEmail(data[field])) b.addDoc(path, `${field} on a reserved domain`, data);
    });
  }
  await scanGroup(db, 'secondaryKinfolk', (path, data) => {
    if (/^families\/[^/]+\/secondaryKinfolk\/[^/]+$/.test(path) && isReservedEmail(data['email'])) b.addDoc(path, 'secondary contact email on a reserved domain', data);
  });
  const uidList = Object.keys(uids).sort();
  await scanGroup(db, 'members', (path, data) => {
    const m = /^families\/[^/]+\/members\/([^/]+)$/.exec(path);
    if (!m) return;
    if (hasReservedContact(path, data, ['email'])) b.addDoc(path, 'member address on a reserved domain', data);
    else if (uids[m[1]]) b.addDoc(path, 'member row of a fake uid', data);
  });
  await scanGroup(db, 'legacyEcServed', (path, data) => {
    const m = /^families\/[^/]+\/legacyEcServed\/([^/]+)$/.exec(path);
    if (m && uids[m[1]]) b.addDoc(path, 'row of a fake uid', data);
  });

  // 5. Everything tied to a fake household.
  households.sort();
  for (const h of households) {
    const why = `tied to household ${h}`;
    await b.addRef(db.doc(`families/${h}`), why);
    await b.addSubtree(db.doc(`families/${h}`), why);
    await b.addSubtree(db.doc(`kinfolk/${h}`), why);
    await b.addRef(db.doc(`conversations/${h}`), why);
    await b.addSubtree(db.doc(`conversations/${h}`), why);
    await b.addRef(db.doc(`household_bank/${h}`), why);
  }
  for (const col of [
    'kin',
    'invoices',
    'payments',
    'kin_care_sessions',
    'kin_care_reports',
    'enhanced_bookings',
    'household_data',
    'visit_logs',
    'visit_routes',
    'location_sharing_preferences',
    'sms_messages',
    'emails',
    'calls_log',
    'voicemails',
    'media_files',
    'dossiers',
  ]) {
    await b.addWhereIn(col, 'kinfolkId', households, 'tied to a fake household');
  }
  for (const col of ['stripePayments', 'stripeDisputes']) await b.addWhereIn(col, 'familyId', households, 'tied to a fake household');
  for (const col of ['inviteRequests', 'recoveryRequests', 'sharedKinTales']) await b.addWhereIn(col, 'tribeId', households, 'tied to a fake household');
  await b.addWhereIn('generated_drafts', 'kinfolk_id', households, 'tied to a fake household');
  await b.addWhereIn('training_documents', 'targetKinfolkId', households, 'tied to a fake household');
  await b.addWhereIn('dynamic_field_values', 'entityId', households, 'tied to a fake household');
  await b.addWhereIn('media_files', 'entityId', households, 'tied to a fake household');
  for (const h of households) {
    const r = await db.collection('dossiers').doc(h).get();
    if (r.exists) b.addDoc(r.ref.path, `tied to household ${h}`, r.data() as Record<string, unknown>);
  }
  const flatKin = Object.keys(b.docs).filter((p) => /^kin\/[^/]+$/.test(p)).map((p) => p.slice('kin/'.length));
  await b.addWhereIn('the_411', 'kinId', flatKin, 'tied to a fake household kin');
  await b.addWhereIn('the_411', 'kinfolkId', households, 'tied to a fake household');
  const reports = Object.keys(b.docs).filter((p) => /^kin_care_reports\/[^/]+$/.test(p)).map((p) => p.slice('kin_care_reports/'.length));
  for (const id of reports) {
    const r = await db.doc(`kinTaleNotifications/${id}`).get();
    if (r.exists) b.addDoc(r.ref.path, 'tied to a fake household kin tale', r.data() as Record<string, unknown>);
  }
  for (const col of ['notifications', 'notificationDispatch']) {
    await b.addWhereIn(col, 'data.kinfolkId', households, 'tied to a fake household');
    await b.addWhereIn(col, 'data.familyId', households, 'tied to a fake household');
  }
  for (const h of households) {
    const snap = await db.collection('notifications').where('targetType', '==', 'kinfolk').where('targetId', '==', h).get();
    for (const d of snap.docs) b.addDoc(d.ref.path, `tied to household ${h} (targetId)`, d.data() as Record<string, unknown>);
  }

  // 6. Everything tied to a fake uid.
  for (const u of uidList) {
    const why = `tied to fake uid ${u}`;
    for (const col of ['clients', 'staff', 'users', 'admins']) {
      const ref = db.doc(`${col}/${u}`);
      const snap = await ref.get();
      if (snap.exists) b.addDoc(ref.path, why, snap.data() as Record<string, unknown>);
      await b.addSubtree(ref, why);
    }
    await b.addSubtree(db.doc(`notificationBatch/${u}`), why);
    const pending = await db
      .collection('pendingNotifications')
      .orderBy('__name__')
      .startAt(`${u}_`)
      .endAt(`${u}_`)
      .get();
    for (const d of pending.docs) b.addDoc(d.ref.path, why, d.data() as Record<string, unknown>);
  }
  for (const col of ['notifications', 'notificationDispatch', 'scheduledNotifications']) await b.addWhereIn(col, 'recipientUid', uidList, 'sent to a fake uid');
  await b.addWhereIn('fcm_tokens', 'uid', uidList, 'token of a fake uid');

  // 7. Expand every planned doc with its own subcollections.
  for (const path of Object.keys(b.docs).sort()) await b.addSubtree(db.doc(path), `under ${path}`);

  // 8. The Auth user of every fake uid, whatever its own address says (the refusal reads it).
  for (const u of uidList) {
    if (users[u]) continue;
    try {
      const rec = await auth.getUser(u);
      users[u] = { uid: u, email: rec.email ?? null, disabled: rec.disabled, reason: uids[u] };
    } catch (err) {
      if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    }
  }

  // 9. What stays: real clients naming a fake household, and trigger side effects.
  const householdSet = new Set(households);
  const danglingClients: Plan['danglingClients'] = [];
  const triggerSideEffects: string[] = [];
  const triggerConflicts: string[] = [];
  for (const [path, ids] of Object.entries(clientKinfolkIds)) {
    const planned = Boolean(b.docs[path]);
    if (!planned && ids.some((id) => householdSet.has(id))) danglingClients.push({ path, kinfolkIds: ids.filter((id) => householdSet.has(id)) });
    if (planned && ids[0] && !householdSet.has(ids[0])) {
      const uid = path.slice('clients/'.length);
      const target = await db.doc(`kinfolk/${ids[0]}`).get();
      const stored = target.exists ? (target.data() as Record<string, unknown>)['uid'] : undefined;
      if (typeof stored === 'string' && stored !== '' && stored !== uid) {
        triggerConflicts.push(
          `deleting ${path} makes onClientsWrite clear kinfolk/${ids[0]}.uid, which holds another account (${stored}), not ${uid}`,
        );
      } else {
        triggerSideEffects.push(`deleting ${path} makes onClientsWrite set kinfolk/${ids[0]}.uid = '' (a household this run does not delete; its uid is ${stored ? 'this one' : 'empty'})`);
      }
    }
  }

  return {
    households,
    uids: uidList,
    docs: Object.values(b.docs).sort((a, z) => a.path.localeCompare(z.path)),
    users: Object.values(users).sort((a, z) => a.uid.localeCompare(z.uid)),
    danglingClients: danglingClients.sort((a, z) => a.path.localeCompare(z.path)),
    triggerSideEffects: triggerSideEffects.sort(),
    triggerConflicts: triggerConflicts.sort(),
    sendGate: await readSendGate(db),
  };
}

/**
 * A short hash of exactly what the plan would delete: every document path and
 * every Auth uid, sorted. The read-only run prints it; --apply --confirm must
 * match it, so the delete run deletes what the operator read and nothing else.
 */
export function planFingerprint(plan: Plan): string {
  const items = [...plan.docs.map((d) => `doc:${d.path}`), ...plan.users.map((u) => `auth:${u.uid}`)].sort();
  return createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 12);
}
// ── Refusal ─────────────────────────────────────────────────────────────────

/** Every address in the plan that is not on a reserved domain, or is a protected real account. Empty means safe. */
export function planProblems(plan: Plan): string[] {
  const problems: string[] = [];
  const check = (where: string, field: string, address: string): void => {
    if (isProtectedEmail(address)) problems.push(`${where} ${field}: PROTECTED real account at ${emailDomain(address) ?? '?'}`);
    else if (!isReservedEmail(address)) problems.push(`${where} ${field}: real-looking domain ${emailDomain(address) ?? '(unreadable)'}`);
  };
  for (const d of plan.docs) for (const c of d.contacts) check(d.path, c.field, c.address);
  for (const u of plan.users) if (u.email) check(`auth/${u.uid}`, 'email', u.email);
  for (const t of plan.triggerConflicts) problems.push(`TRIGGER: ${t}`);
  return problems;
}

export function assertPlanSafe(plan: Plan): void {
  const problems = planProblems(plan);
  if (problems.length > 0) {
    throw new Error(
      [
        `REFUSED: ${problems.length} target(s) carry an address that is not on a reserved domain. Nothing was deleted.`,
        ...problems.map((p) => `  ${p}`),
      ].join('\n'),
    );
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────

function depth(path: string): number {
  return path.split('/').length;
}

/** Deepest first; households (kinfolk/H, families/H) last of all. */
export function deleteOrder(paths: readonly string[]): string[] {
  const isHousehold = (p: string): boolean => /^(kinfolk|families)\/[^/]+$/.test(p);
  return [...paths].sort((a, z) => Number(isHousehold(a)) - Number(isHousehold(z)) || depth(z) - depth(a) || a.localeCompare(z));
}

function auditRow(runId: string, targetCollection: string, targetId: string, description: string): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    actionType: ACTION_TYPE,
    description,
    status: 'SUCCESS',
    actorId: ACTOR_ID,
    targetId,
    targetCollection,
    severity: 'info',
    actorRole: 'SYSTEM',
    payload: { runId, issue: 1082 },
    createdAt: FieldValue.serverTimestamp(),
  };
}

export interface ApplyResult {
  docsDeleted: number;
  docsRedeleted: number;
  usersDeleted: number;
}

async function deleteDocs(db: Firestore, runId: string, paths: readonly string[], note: string, log: (s: string) => void): Promise<number> {
  let n = 0;
  for (let i = 0; i < paths.length; i += DELETES_PER_BATCH) {
    const chunk = paths.slice(i, i + DELETES_PER_BATCH);
    const batch = db.batch();
    for (const p of chunk) {
      batch.delete(db.doc(p));
      const parts = p.split('/');
      batch.set(db.collection('activity_log').doc(), auditRow(runId, parts.slice(0, -1).join('/'), parts[parts.length - 1], `${note} ${p} (#1082 reserved-domain purge)`));
    }
    await batch.commit();
    for (const p of chunk) log(`DELETED ${p}  ${note}`);
    n += chunk.length;
  }
  return n;
}

/**
 * Deletes exactly `plan`. Never re-queries for new targets. Refuses, before the
 * first delete, a plan with a real-looking address or one whose fingerprint is
 * not `opts.confirm` (the one the read-only run printed).
 */
export async function applyPlan(
  db: Firestore,
  auth: Auth,
  plan: Plan,
  opts: { settleMs: number; confirm: string; log?: (s: string) => void; runId?: string },
): Promise<ApplyResult> {
  assertPlanSafe(plan);
  const fingerprint = planFingerprint(plan);
  if (fingerprint !== opts.confirm) {
    throw new Error(
      `REFUSED: this scan's plan fingerprint is ${fingerprint}, not ${opts.confirm || '(none given)'}. The data changed since the read-only run, or the wrong fingerprint was pasted. Nothing was deleted. Re-run read only and read the list again.`,
    );
  }
  const log = opts.log ?? ((s: string) => console.log(s));
  const runId = opts.runId ?? `purgeFakeRecords-${new Date().toISOString()}`;
  const ordered = deleteOrder(plan.docs.map((d) => d.path));
  const docsDeleted = await deleteDocs(db, runId, ordered, 'deleted', log);

  // Triggers can recreate a planned path (onClientsWrite merge-writes kinfolk/{id}.uid).
  let docsRedeleted = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    if (opts.settleMs > 0) await new Promise((r) => setTimeout(r, opts.settleMs));
    const back: string[] = [];
    for (let i = 0; i < ordered.length; i += 100) {
      const refs = ordered.slice(i, i + 100).map((p) => db.doc(p));
      const snaps = await db.getAll(...refs);
      for (const s of snaps) if (s.exists) back.push(s.ref.path);
    }
    if (back.length === 0) break;
    docsRedeleted += await deleteDocs(db, runId, deleteOrder(back), 're-deleted after a trigger recreated it:', log);
  }

  let usersDeleted = 0;
  for (const u of plan.users) {
    try {
      await auth.deleteUser(u.uid);
    } catch (err) {
      if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
      log(`ALREADY GONE auth/${u.uid}`);
      continue;
    }
    await db.collection('activity_log').add(auditRow(runId, 'auth', u.uid, `deleted Auth user ${u.uid} (#1082 reserved-domain purge)`));
    log(`DELETED auth/${u.uid}  ${u.email ?? '(no email)'}`);
    usersDeleted += 1;
  }
  return { docsDeleted, docsRedeleted, usersDeleted };
}

// ── Output ──────────────────────────────────────────────────────────────────

export function planLines(plan: Plan): string[] {
  const lines: string[] = [];
  lines.push(plan.sendGate.line);
  lines.push('');
  lines.push(`Fake households (kinfolk address on a reserved domain): ${plan.households.length}`);
  for (const h of plan.households) lines.push(`  ${h}`);
  lines.push(`Fake uids: ${plan.uids.length}`);
  lines.push(`Auth users to delete: ${plan.users.length}`);
  for (const u of plan.users) lines.push(`  auth/${u.uid}  ${u.email ?? '(no email)'}${u.disabled ? '  (disabled)' : ''}  ${u.reason}`);
  const byCollection: Record<string, number> = {};
  for (const d of plan.docs) {
    const parts = d.path.split('/');
    const key = parts.filter((_, i) => i % 2 === 0).join('/*/');
    byCollection[key] = (byCollection[key] ?? 0) + 1;
  }
  lines.push(`Firestore documents to delete: ${plan.docs.length}`);
  for (const [k, n] of Object.entries(byCollection).sort()) lines.push(`  ${String(n).padStart(5)}  ${k}`);
  lines.push('');
  lines.push('Every document:');
  for (const d of plan.docs) {
    const addr = d.contacts.length > 0 ? `  [${d.contacts.map((c) => `${c.field}=${c.address}`).join(', ')}]` : '';
    lines.push(`  ${d.path}  ${d.reason}${addr}`);
  }
  lines.push('');
  lines.push(`Left in place, real clients docs naming a fake household: ${plan.danglingClients.length}`);
  for (const c of plan.danglingClients) lines.push(`  ${c.path}  kinfolkIds includes ${c.kinfolkIds.join(', ')}`);
  lines.push(`Trigger side effects outside the plan: ${plan.triggerSideEffects.length}`);
  for (const s of plan.triggerSideEffects) lines.push(`  ${s}`);
  const problems = planProblems(plan);
  lines.push('');
  if (problems.length > 0) {
    lines.push(`WOULD REFUSE: ${problems.length} target(s) carry a real-looking or protected address. --apply will delete nothing until this is resolved:`);
    for (const p of problems) lines.push(`  ${p}`);
  } else {
    lines.push('Every address in the plan is on a reserved domain.');
  }
  lines.push(`Plan fingerprint: ${planFingerprint(plan)}  (${plan.docs.length} document(s), ${plan.users.length} Auth user(s))`);
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  console.log(describeTarget(target, args.apply));
  if (getApps().length === 0) initializeApp(target.projectId ? { projectId: target.projectId } : {});
  const db = getFirestore();
  const auth = getAuth();
  const plan = await buildPlan(db, auth);
  for (const line of planLines(plan)) console.log(line);
  if (!args.apply) {
    console.log('');
    console.log(`READ ONLY: nothing was written. To delete exactly this list, re-run with --apply --confirm ${planFingerprint(plan)}`);
    return;
  }
  assertPlanSafe(plan);
  const settleSeconds = args.settleSeconds ?? (target.kind === 'emulator' ? 0 : 10);
  console.log('');
  const r = await applyPlan(db, auth, plan, { settleMs: settleSeconds * 1000, confirm: args.confirm ?? '' });
  console.log('');
  console.log(
    `APPLIED: ${r.docsDeleted} document(s) and ${r.usersDeleted} Auth user(s) deleted, ${r.docsRedeleted} re-deleted after a trigger. ` +
      'One activity_log row per deletion (UNCHAINED: runs outside writeAuditEntry).',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
