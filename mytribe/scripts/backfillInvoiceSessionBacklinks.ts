/**
 * #1901 / #1970: repairs the visit side of invoice links that existing data
 * left half-written, and reports every case it will not decide.
 *
 * WHY. Until #1901 `createInvoice` stored the invoice's `sessionIds` and never
 * set the visit's own `invoiceId`, so every visit billed from New invoice is
 * still on the un-invoiced list and can be billed a second time. Until #1970
 * removing a visit's line in Edit left the visit in `sessionIds` with its
 * back-link set. The callables now keep both sides in one transaction; this
 * script brings the rows written before that into line.
 *
 * WHAT IT WRITES, AND ONLY THIS. A visit is given `invoiceId` = the invoice
 * when ALL of these hold, which is the shape #1901 produced and nothing else:
 *
 *   - exactly one invoice claims the visit (in `sessionIds` or by a line);
 *   - that invoice has a LINE bound to the visit, so it really bills it;
 *   - the visit exists, is not cancelled, and its back-link is blank;
 *   - the invoice is not a quote and not cancelled (a quote's hold on a visit
 *     is an open question, and a cancelled invoice bills nothing).
 *
 * When that line's visit is missing from the invoice's own `sessionIds`, the
 * id is added there too, so the two sides name each other.
 *
 * WHAT IT ONLY REPORTS, because which side is right decides which invoice a
 * visit is billed on, and only the operator knows that:
 *
 *   - a visit claimed by two or more invoices;
 *   - a visit whose back-link names a different invoice than the one claiming it;
 *   - a linked visit an itemized invoice has no line for (a #1970 leftover, or a
 *     deliberate Link visits attribution: the data cannot tell them apart);
 *   - an invoice naming a visit with no record, or a cancelled visit;
 *   - quotes and cancelled invoices holding visits.
 *
 * TRIGGERS. A `kin_care_sessions` write runs `onKinCareSessionCalendarSync`,
 * which ignores `invoiceId`; an `invoices` write of `sessionIds` alone changes
 * no state `onInvoicesWrite` reads, so no household is told anything.
 *
 * Dry run unless `--apply`. `--allow-prod` only says the target is production.
 *
 *   npm --prefix mytribe/functions run backfill:invoice-session-backlinks -- --project <id> --allow-prod
 *   npm --prefix mytribe/functions run backfill:invoice-session-backlinks -- --project <id> --allow-prod --apply
 */
// The single firebase-admin import point (#846).
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { isSessionCancelled, isSessionClaimed } from '../functions/src/lib/sessionInvoicing';
import { boundSessionIds, storedSessionIds } from '../functions/src/lib/invoiceSessionLinks';

export const INVOICES = 'invoices';
export const SESSIONS = 'kin_care_sessions';
/** Firestore's write limit per batch. */
export const BATCH_LIMIT = 500;
/** Stamped on every visit this script links, so the trail says who did it. */
export const ATTRIBUTION = 'backfill_1901';

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  apply: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, apply: false };
  // An explicit --dry-run ALWAYS wins, in either flag order.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillInvoiceSessionBacklinks.ts: marks visits billed by the invoice whose line bills them (#1901, #1970)',
          '',
          '  npm --prefix mytribe/functions run backfill:invoice-session-backlinks -- --project <id> --allow-prod',
          '  npm --prefix mytribe/functions run backfill:invoice-session-backlinks -- --project <id> --allow-prod --apply',
          '',
          'Dry run unless --apply. --dry-run forces it back and wins in either flag order.',
          '--allow-prod says the target is production; it is refused when FIRESTORE_EMULATOR_HOST is set.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (explicitDryRun) args.apply = false;
  return args;
}

export type Target = { kind: 'emulator'; host: string } | { kind: 'production' };

/** Throws when the flags and the environment disagree about where the writes would go. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host && args.allowProd) {
    throw new Error(
      `--allow-prod refused: FIRESTORE_EMULATOR_HOST is set (${host}), so this would touch the emulator, not production. ` +
        'Unset FIRESTORE_EMULATOR_HOST to reach production, or drop --allow-prod to work against the emulator.',
    );
  }
  if (host) return { kind: 'emulator', host };
  if (!args.allowProd) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set, so this would reach PRODUCTION. Pass --allow-prod to confirm.');
  }
  return { kind: 'production' };
}

export function describeTarget(args: Args, env: Record<string, string | undefined>): string {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const project = args.projectId ?? '(default credentials project)';
  const mode = args.apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)';
  return host ? `EMULATOR at ${host}, project ${project} - ${mode}` : `PRODUCTION Firestore, project ${project} - ${mode}`;
}

export interface Row {
  id: string;
  data: Record<string, unknown>;
}

export type Finding =
  | { kind: 'multiple_claimants'; sessionId: string; invoiceIds: string[] }
  | { kind: 'backlink_elsewhere'; sessionId: string; invoiceId: string; backlink: string }
  | { kind: 'linked_without_line'; sessionId: string; invoiceId: string }
  | { kind: 'missing_session'; sessionId: string; invoiceId: string }
  | { kind: 'cancelled_session'; sessionId: string; invoiceId: string }
  | { kind: 'held_by_quote_or_cancelled'; sessionId: string; invoiceId: string; state: string };

export interface Plan {
  /** Visits to mark as billed by `invoiceId`. */
  backlinks: { sessionId: string; invoiceId: string }[];
  /** Invoices whose `sessionIds` gains the visits its lines bill. */
  invoiceSets: { invoiceId: string; sessionIds: string[] }[];
  findings: Finding[];
  scanned: { invoices: number; sessions: number };
}

/** The invoice's state word, lowercased, from either field writers have used. */
function stateWord(data: Record<string, unknown>): string {
  const raw = data['status'] ?? data['invoiceStatus'];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Every invoice and visit, decided. READS ONLY. */
export function buildPlanFromRows(invoices: Row[], sessions: Row[]): Plan {
  const sessionById = new Map(sessions.map((s) => [s.id, s.data]));
  // visit id -> the invoices that claim it, and how.
  const claims = new Map<string, { invoiceId: string; byLine: boolean; inSet: boolean; state: string }[]>();
  for (const inv of invoices) {
    const inSet = new Set(storedSessionIds(inv.data));
    const byLine = new Set(boundSessionIds(inv.data['lineItems']));
    const state = stateWord(inv.data);
    for (const sid of new Set([...inSet, ...byLine])) {
      const list = claims.get(sid) ?? [];
      list.push({ invoiceId: inv.id, byLine: byLine.has(sid), inSet: inSet.has(sid), state });
      claims.set(sid, list);
    }
  }

  const plan: Plan = {
    backlinks: [],
    invoiceSets: [],
    findings: [],
    scanned: { invoices: invoices.length, sessions: sessions.length },
  };
  const setAdds = new Map<string, string[]>();

  for (const [sid, list] of [...claims.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (list.length > 1) {
      plan.findings.push({ kind: 'multiple_claimants', sessionId: sid, invoiceIds: list.map((c) => c.invoiceId).sort() });
      continue;
    }
    const claim = list[0]!;
    const visit = sessionById.get(sid);
    if (visit === undefined) {
      plan.findings.push({ kind: 'missing_session', sessionId: sid, invoiceId: claim.invoiceId });
      continue;
    }
    const backlink = isSessionClaimed(visit['invoiceId']) ? String(visit['invoiceId']).trim() : '';
    if (backlink !== '' && backlink !== claim.invoiceId) {
      plan.findings.push({ kind: 'backlink_elsewhere', sessionId: sid, invoiceId: claim.invoiceId, backlink });
      continue;
    }
    if (claim.state === 'quote' || claim.state === 'cancelled') {
      plan.findings.push({ kind: 'held_by_quote_or_cancelled', sessionId: sid, invoiceId: claim.invoiceId, state: claim.state });
      continue;
    }
    if (isSessionCancelled(visit['status'])) {
      plan.findings.push({ kind: 'cancelled_session', sessionId: sid, invoiceId: claim.invoiceId });
      continue;
    }
    if (!claim.byLine) {
      // Linked with no line. A typed-total invoice's attribution, a Link
      // visits link, or a line removed before #1970: not this script's call.
      // Reported when the invoice is itemized (it could be a #1970 leftover)
      // or the visit does not point back (a half link). A typed-total invoice
      // whose visit already points back is consistent and says nothing.
      const itemized = Array.isArray(invoices.find((i) => i.id === claim.invoiceId)?.data['lineItems']);
      if (backlink === '' || itemized) {
        plan.findings.push({ kind: 'linked_without_line', sessionId: sid, invoiceId: claim.invoiceId });
      }
      continue;
    }
    // A line bills it and nobody else claims it: the #1901 shape.
    if (backlink === '') plan.backlinks.push({ sessionId: sid, invoiceId: claim.invoiceId });
    if (!claim.inSet) {
      const adds = setAdds.get(claim.invoiceId) ?? [];
      adds.push(sid);
      setAdds.set(claim.invoiceId, adds);
    }
  }

  for (const [invoiceId, adds] of setAdds) {
    const inv = invoices.find((i) => i.id === invoiceId)!;
    plan.invoiceSets.push({ invoiceId, sessionIds: [...storedSessionIds(inv.data), ...adds] });
  }
  return plan;
}

export async function buildPlan(db: Firestore): Promise<Plan> {
  const [invSnap, sesSnap] = await Promise.all([db.collection(INVOICES).get(), db.collection(SESSIONS).get()]);
  return buildPlanFromRows(
    invSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
    sesSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
  );
}

const FINDING_WORDS: Record<Finding['kind'], string> = {
  multiple_claimants: 'claimed by more than one invoice',
  backlink_elsewhere: 'back-link names a different invoice',
  linked_without_line: 'linked with no line on an itemized invoice, or back-link blank with no line',
  missing_session: 'invoice names a visit with no record',
  cancelled_session: 'invoice bills a cancelled visit',
  held_by_quote_or_cancelled: 'held by a quote or a cancelled invoice',
};

export function reportLines(plan: Plan, applied: boolean): string[] {
  const lines = [
    '',
    `=== Invoice visit back-link backfill (${applied ? 'APPLIED' : 'DRY RUN'}) ===`,
    `invoices scanned                  : ${plan.scanned.invoices}`,
    `visits scanned                    : ${plan.scanned.sessions}`,
    `visits marked billed              : ${plan.backlinks.length}`,
    `invoices whose visit set grows    : ${plan.invoiceSets.length}`,
    `left for the operator (reported)  : ${plan.findings.length}`,
  ];
  if (plan.backlinks.length > 0) {
    lines.push('', '-- visits marked billed --');
    for (const b of plan.backlinks) lines.push(`  ${SESSIONS}/${b.sessionId}  ->  ${INVOICES}/${b.invoiceId}`);
  }
  if (plan.invoiceSets.length > 0) {
    lines.push('', '-- invoice visit sets --');
    for (const s of plan.invoiceSets) lines.push(`  ${INVOICES}/${s.invoiceId}  sessionIds = [${s.sessionIds.join(', ')}]`);
  }
  if (plan.findings.length > 0) {
    lines.push('', '-- reported, not changed --');
    for (const f of plan.findings) {
      const where = 'invoiceIds' in f ? f.invoiceIds.join(', ') : f.invoiceId;
      lines.push(`  ${SESSIONS}/${f.sessionId}  ${FINDING_WORDS[f.kind]}  (${where})`);
    }
  }
  lines.push('');
  if (!applied) lines.push('DRY RUN: nothing was written. Re-run with --apply to write.');
  return lines;
}

export async function applyPlan(db: Firestore, plan: Plan, nowIso = new Date().toISOString()): Promise<void> {
  const ops: ((batch: ReturnType<Firestore['batch']>) => void)[] = [
    // merge-set of the link fields only: the visit keeps everything else.
    ...plan.backlinks.map((b) => (batch: ReturnType<Firestore['batch']>) => {
      batch.set(
        db.collection(SESSIONS).doc(b.sessionId),
        { invoiceId: b.invoiceId, _attribution: ATTRIBUTION, _attributionAt: nowIso },
        { merge: true },
      );
    }),
    ...plan.invoiceSets.map((s) => (batch: ReturnType<Firestore['batch']>) => {
      batch.update(db.collection(INVOICES).doc(s.invoiceId), { sessionIds: s.sessionIds });
    }),
  ];
  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.projectId === null) args.projectId = process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  console.log(`Target: ${describeTarget(args, process.env)}`);
  resolveTarget(args, process.env);
  if (getApps().length === 0) initializeApp(args.projectId ? { projectId: args.projectId } : {});
  const db = getFirestore();
  const plan = await buildPlan(db);
  if (args.apply) await applyPlan(db, plan);
  for (const line of reportLines(plan, args.apply)) console.log(line);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
