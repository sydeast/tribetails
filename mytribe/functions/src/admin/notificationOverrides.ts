import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import {
  canonicalNotificationKey,
  getNotificationDef,
  legacyKeysFor,
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEY_ALIASES,
} from '../notifications/catalog';
import { resolveOverrideForKey } from '../notifications/prefs';
import { TEMPLATE_FIELDS } from '../notifications/enrichTemplateData';
import {
  NEVER_FIRES,
  NOTIFICATION_EMITTERS,
  UNGATED_SENDS,
  whoReceives,
  type EmitterDescriptor,
  type UngatedSend,
} from '../notifications/provenance';
import { readBusinessAdmins } from '../lib/businessAdmins';
import { readTemplateBindings } from '../lib/sendFromTemplate';
import type { BusinessNotificationOverride } from '../notifications/types';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Admin callables for business-side notification overrides.
 *
 * Storage: single doc `businessSettings/notifications` with shape:
 *   {
 *     byKey: {
 *       [catalogKey]: { enabled: boolean, channels: { email?, sms?, push? } },
 *     },
 *     updatedAtMs: number,
 *   }
 *
 * Why a single doc? Catalog is small (≤50 keys) and the dispatcher already
 * fetches this exact doc per notification, keeping reads at O(1) per
 * dispatch beats fan-out across N override docs.
 *
 * Catalog `alwaysEnabled=true` keys CAN be disabled via override (see issue #7,
 * 2026-06-08: operator can now disable even catalog-required and always-on
 * notifications, with a warning in the UI but no server-side hard enforcement).
 * #396 built the warning half of that, which had never shipped: the gate now
 * renders the flag as a risk marker that escalates once a row is actually off,
 * rather than as the "Always on" caption that implied a lock nobody enforces.
 *
 * PROVENANCE (#396). The catalog projection below carries the three facts that
 * used to exist only in source: who a notification reaches (`whoReceives`),
 * what fires it (`emitters`), and which template renders it per channel
 * (`templates`) with the merge fields that template can print (`mergeFields`).
 * They are projected as finished ENGLISH here rather than as enums, so the web
 * and Android clients render the same sentence instead of each maintaining
 * their own enum-to-prose map and drifting apart. See notifications/provenance.ts.
 */

const Channel = z.enum(['email', 'sms', 'push']);
const ChannelMap = z.partialRecord(Channel, z.boolean()).optional();
// Audience revamp 2026-07: a per-stream overlay carries the same gate fields as the
// flat override; the dispatcher falls back field-by-field to the flat values.
const StreamGate = z
  .object({
    enabled: z.boolean().optional(),
    channels: ChannelMap,
    lockedEnabled: z.boolean().optional(),
    locked: z.partialRecord(Channel, z.literal(true)).optional(),
  })
  .strict();
const OverridePayload = z.object({
  enabled: z.boolean(),
  channels: ChannelMap,
  // Run-4 #13: admin-set locks. lockedEnabled pins the whole on/off; locked[channel]
  // pins a channel. Persisted verbatim into byKey and returned by the getter, so the
  // kinfolk prefs UI can render the locked toggles as read-only.
  lockedEnabled: z.boolean().optional(),
  locked: z.partialRecord(Channel, z.literal(true)).optional(),
  // Operator-authored reason shown to users on locked/required rows. Trimmed here;
  // an empty result means "clear the stored reason" (handled in the save handler).
  lockReason: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= 300, 'lockReason must be 300 characters or fewer')
    .optional(),
  // Only the three audience streams are addressable; .strict() rejects anything else.
  streams: z
    .object({
      business: StreamGate.optional(),
      staff: StreamGate.optional(),
      kinfolk: StreamGate.optional(),
    })
    .strict()
    .optional(),
});

const SaveArgs = z.object({
  key: z.string().min(1),
  override: OverridePayload,
});

const DeleteArgs = z.object({
  key: z.string().min(1),
});

interface GetResult {
  overrides: Record<string, BusinessNotificationOverride>;
  catalog: Array<{
    key: string;
    label: string;
    category: string;
    audience: string;
    audiences: { kinfolk?: true; business?: true; staff?: true };
    allowedChannels: string[];
    required: Record<string, boolean>;
    alwaysEnabled: boolean;
    /** Streams alwaysEnabled applies to; absent = every stream the key serves. */
    alwaysEnabledStreams?: { kinfolk?: true; business?: true; staff?: true };
    kinfolkFacing: boolean;
    deliveryMode: string;
    description: string;
    marketingCategory?: string;
    // ── #396 provenance: who / what fires it / which template ──────────────
    /** The recipient rule(s) as finished sentences. One per resolver in play. */
    whoReceives: string[];
    /** Raw resolver names, kept for anything that needs to branch on them. */
    recipientResolver: string;
    secondaryResolver?: string;
    /** Every call site that dispatches this key, in business terms. */
    emitters: EmitterDescriptor[];
    /** True when NOTHING dispatches this key, so its toggles control nothing. */
    neverFires: boolean;
    /**
     * channel -> the `${channel}Templates/{id}` document that ACTUALLY renders
     * it. For email this is the effective id after `notificationTemplateBindings`
     * is applied, not the catalog default: this same screen can retarget an
     * email, and naming the catalog document on a retargeted row would be the
     * screen confidently reporting the wrong body.
     */
    templates: Record<string, string>;
    /** Set only when an active binding has moved email off the catalog default. */
    emailTemplateRetargetedFrom?: string;
    /** Merge fields `enrichTemplateData` hydrates for this key's templates. */
    mergeFields: string[];
    /** True when an outside system delivers it and this gate controls nothing. */
    external: boolean;
  }>;
  /**
   * Email the platform sends that this gate does NOT govern: invites, account
   * recovery, the error digest. Every toggle above is irrelevant to these, and
   * leaving them off the screen is how the gate reads as a complete inventory
   * of outbound mail when it is not one.
   */
  ungated: UngatedSend[];
  /**
   * How many people a `businessAdmins` row actually reaches right now, and from
   * where. Null when the roster cannot be resolved at all — which is a real
   * state (the document has been missing in prod before) and is reported as
   * unknown rather than as zero.
   */
  businessAdminCount: number | null;
  businessAdminRosterPath: string;
  updatedAtMs: number | null;
}

export async function getBusinessNotificationOverridesHandler(
  _req: CallableRequest<unknown>,
): Promise<GetResult> {
  const snap = await db().collection('businessSettings').doc('notifications').get();
  const data = snap.data() as
    | { byKey?: Record<string, BusinessNotificationOverride>; updatedAtMs?: number }
    | undefined;

  // Email retargeting is a live capability of the Template Assignments screen
  // (#439): a `notificationTemplateBindings` doc points a catalog key's email at
  // a different `emailTemplates/{id}`, and `sendFromTemplate` honors it at send
  // time. So the catalog default is NOT the answer to "which template writes
  // this" on a retargeted row, and this screen would otherwise name a document
  // that has not rendered anything in weeks.
  //
  // The resolution itself is NOT reimplemented here. `readTemplateBindings`
  // (lib/sendFromTemplate.ts) is the same read `listCatalogKeys` uses to build
  // the Assignments routing table, so the two screens cannot disagree about what
  // a key sends. Assignments remains the place to CHANGE the routing; this is
  // the gate reporting it, and the gate's row detail says so.
  //
  // Email only. `smsChannel` and `pushChannel` read `def.templates.*` directly
  // and consult no bindings, which is why retargeting those needs a deploy.
  let bindings: ReadonlyMap<string, string> = new Map();
  try {
    bindings = (await readTemplateBindings()).activeBindings;
  } catch {
    // Same rule as the roster read below: a settings GET must not fail the whole
    // matrix. With no bindings read, every row shows its catalog default, which
    // is what an un-retargeted row would show anyway.
  }
  const catalog = Object.values(NOTIFICATION_CATALOG).map((def) => {
    // The binding is keyed by the TEMPLATE id the sender asks for, not by the
    // catalog key. They coincide for every row today; reading it the way
    // `sendFromTemplate` does means they may stop coinciding without this
    // silently reporting the wrong document.
    const catalogEmailId = def.templates.email;
    const boundEmailId = catalogEmailId ? bindings.get(catalogEmailId) : undefined;
    const retargeted = boundEmailId !== undefined && boundEmailId !== catalogEmailId;
    return {
      key: def.key,
      label: def.label,
      category: def.category,
      audience: def.audience,
      audiences: { ...def.audiences },
      allowedChannels: [...def.allowedChannels],
      required: Object.fromEntries(
        Object.entries(def.required).map(([k, v]) => [k, v === true]),
      ),
      alwaysEnabled: def.alwaysEnabled,
      ...(def.alwaysEnabledStreams ? { alwaysEnabledStreams: { ...def.alwaysEnabledStreams } } : {}),
      kinfolkFacing: def.kinfolkFacing,
      deliveryMode: def.deliveryMode,
      description: def.description,
      ...(def.marketingCategory ? { marketingCategory: def.marketingCategory } : {}),
      whoReceives: whoReceives(def),
      recipientResolver: def.recipientResolver,
      ...(def.secondaryResolver ? { secondaryResolver: def.secondaryResolver } : {}),
      // Spread into fresh objects: this is a wire projection, and handing the
      // frozen catalog's own arrays to the serializer is how a caller ends up
      // able to mutate the catalog in-process.
      emitters: (NOTIFICATION_EMITTERS[def.key] ?? []).map((e) => ({
        trigger: e.trigger,
        source: e.source,
        dataKeys: [...e.dataKeys],
        ...(e.dataNote ? { dataNote: e.dataNote } : {}),
      })),
      neverFires: NEVER_FIRES.includes(def.key),
      templates: {
        ...def.templates,
        ...(retargeted && boundEmailId ? { email: boundEmailId } : {}),
      } as Record<string, string>,
      ...(retargeted && catalogEmailId ? { emailTemplateRetargetedFrom: catalogEmailId } : {}),
      mergeFields: [...(TEMPLATE_FIELDS[def.key] ?? [])],
      external: def.external === true,
    };
  });

  // The plain roster read, NOT `resolveBusinessAdminUids`. That resolver throws
  // when nothing is configured and self-heals from AUNTIE_OPERATOR_UIDS by
  // WRITING the roster back — both correct on the dispatch path, both wrong
  // here. This is a settings GET: it must not fail the whole 44-row matrix over
  // an empty roster, and reading a screen must not quietly edit who receives
  // business mail. An unresolvable roster is reported as unknown, never as zero.
  let businessAdminCount: number | null;
  try {
    businessAdminCount = (await readBusinessAdmins()).uids.length;
  } catch {
    businessAdminCount = null;
  }

  // Key aliases: a row the operator saved under a since-retired key still
  // governs dispatch, so the matrix must show it on the canonical row rather
  // than as an invisible shadow setting. Fold it in, drop the retired row, and
  // leave any other stored key untouched (an unknown key is the operator's
  // data, not ours to discard).
  const stored = data?.byKey ?? {};
  const overrides: Record<string, BusinessNotificationOverride> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (NOTIFICATION_KEY_ALIASES[key]) continue;
    overrides[key] = value;
  }
  for (const key of Object.keys(NOTIFICATION_CATALOG)) {
    const resolved = resolveOverrideForKey(stored, key);
    if (resolved) overrides[key] = resolved;
  }

  return {
    overrides,
    catalog,
    ungated: UNGATED_SENDS.map((u) => ({ ...u })),
    businessAdminCount,
    businessAdminRosterPath: 'businessSettings/admins.uids',
    updatedAtMs: data?.updatedAtMs ?? null,
  };
}

export async function saveBusinessNotificationOverrideHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; key: string }> {
  const args = SaveArgs.parse(req.data);
  // Validates the key exists in the catalog (throws on an unknown key). A
  // retired key from a stale client resolves to the row that replaced it.
  getNotificationDef(args.key);
  const key = canonicalNotificationKey(args.key);

  // #7 (2026-06-08): the operator may now turn off even catalog-required channels
  // and always-on notifications. The admin UI surfaces a warning first
  // (warn-but-allow-off); the previous hard enforcement here is removed so the
  // operator stays in control of their own business notifications.

  // A whitespace-only lockReason is the "clear it" gesture from the UI.
  const stored: Record<string, unknown> = { ...args.override };
  if (args.override.lockReason !== undefined && args.override.lockReason === '') {
    stored.lockReason = FieldValue.delete();
  }

  // The operator has now made an explicit choice on the merged row, so any
  // value left under a retired key is superseded. Clearing it in the same write
  // keeps exactly one row per notification and stops the old value resurfacing.
  const byKey: Record<string, unknown> = { [key]: stored };
  for (const legacy of legacyKeysFor(key)) byKey[legacy] = FieldValue.delete();

  await db()
    .collection('businessSettings')
    .doc('notifications')
    .set(
      {
        byKey,
        updatedAtMs: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  logEvent({
    severity: 'info',
    function: 'saveBusinessNotificationOverride',
    event: 'admin.notif.override.saved',
    extra: { key, requestedKey: args.key, actorUid: req.auth?.uid, override: args.override },
  });
  return { ok: true, key };
}

export async function deleteBusinessNotificationOverrideHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; key: string }> {
  const args = DeleteArgs.parse(req.data);
  const key = canonicalNotificationKey(args.key);
  // Reset-to-default must clear the retired keys too, or the row would spring
  // back to whatever was stored under the pre-merge key.
  const byKey: Record<string, unknown> = { [key]: FieldValue.delete() };
  for (const legacy of legacyKeysFor(key)) byKey[legacy] = FieldValue.delete();

  await db()
    .collection('businessSettings')
    .doc('notifications')
    .set(
      {
        byKey,
        updatedAtMs: Date.now(),
      },
      { merge: true },
    );

  logEvent({
    severity: 'info',
    function: 'deleteBusinessNotificationOverride',
    event: 'admin.notif.override.deleted',
    extra: { key, requestedKey: args.key, actorUid: req.auth?.uid },
  });
  return { ok: true, key };
}

export const getBusinessNotificationOverrides = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('getBusinessNotificationOverrides', getBusinessNotificationOverridesHandler),
);

export const saveBusinessNotificationOverride = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('saveBusinessNotificationOverride', saveBusinessNotificationOverrideHandler),
);

export const deleteBusinessNotificationOverride = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('deleteBusinessNotificationOverride', deleteBusinessNotificationOverrideHandler),
);
