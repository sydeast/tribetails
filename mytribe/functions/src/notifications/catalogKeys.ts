import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_KEY_ALIASES,
  RETIRED_NOTIFICATION_KEYS,
  canonicalNotificationKey,
} from './catalog';
import type { Audience, Category } from './types';

/**
 * The one honest answer to "what catalog keys exist?".
 *
 * A catalog key is the document id of a `notificationTemplateBindings` doc, and
 * `resolveTemplateId(key)` (lib/sendFromTemplate.ts) is the only thing that ever
 * reads one. So the set of keys that can possibly do anything is exactly the set
 * of arguments `resolveTemplateId` is ever called with, which is two things and
 * nothing else:
 *
 *  1. `def.templates.email` for every row in the notification catalog. The
 *     dispatcher's email channel (notifications/senders/emailChannel.ts) passes
 *     the def's email template id, not the def's key. Every catalog row today
 *     has `templates.email === key`; `catalogKeyEmailTemplateDrift()` below
 *     exists so the day that stops being true is a loud test failure rather
 *     than a silently dead binding.
 *  2. The DIRECT_SEND_KEYS below: literals handed straight to
 *     `sendFromTemplate(key, ...)` by code outside the catalog dispatcher.
 *
 * Anything else written into `notificationTemplateBindings` is dead on arrival:
 * nothing ever looks it up. That is the whole of issue #382 (assignTemplate let
 * a typo create one) and issue #383 (listCatalogKeys reported the binding
 * collection back as if it were the catalog).
 */

/** A key sent directly via `sendFromTemplate`, bypassing the catalog dispatcher. */
export interface DirectSendKey {
  key: string;
  label: string;
}

/**
 * Keys passed as string literals to `sendFromTemplate()` outside the catalog
 * dispatcher. Each one resolves through the bindings collection exactly like a
 * catalog key does, so an admin can rebind them, and so they belong in any
 * honest key list. Call sites (verified, not assumed):
 *
 *   invite.primary          admin/provisionTribe.ts, admin/mintInvite.ts,
 *                           admin/inviteKinfolkToPortal.ts
 *   invite.secondary        membership/mintInviteFromPrimary.ts
 *   invite.verify-email     membership/acceptInvite.ts
 *   invite.auntie-notify    membership/mintInviteFromPrimary.ts
 *   invite.primary-receipt  membership/mintInviteFromPrimary.ts
 *   recovery.requested      recovery/requestPrimaryRecovery.ts
 *   recovery.completed      admin/executePrimaryRecovery.ts
 *   error.daily-digest      scheduled/errorDailyDigest.ts
 *
 * `catalogKeys.test.ts` greps the source for every string literal handed to
 * sendFromTemplate and fails if this list and the source ever disagree.
 */
export const DIRECT_SEND_KEYS: readonly DirectSendKey[] = Object.freeze([
  { key: 'error.daily-digest', label: 'Daily error digest, to the business inbox' },
  { key: 'invite.auntie-notify', label: 'A member was invited, to the business inbox' },
  { key: 'invite.primary', label: 'Portal invite to a primary kinfolk' },
  { key: 'invite.primary-receipt', label: 'Invite-sent receipt, back to the primary' },
  { key: 'invite.secondary', label: 'Portal invite to a secondary member' },
  { key: 'invite.verify-email', label: 'Verify your email address' },
  { key: 'recovery.completed', label: 'Primary recovery completed' },
  { key: 'recovery.requested', label: 'Primary recovery requested, to the business inbox' },
]);

/** Where a key comes from, so a client can group the picker honestly. */
export type CatalogKeySource = 'catalog' | 'direct-send' | 'legacy';

/**
 * One row of the catalog-key list. `defaultTemplateId` is what
 * `resolveTemplateId` falls back to when no binding exists (the key itself for
 * direct-send and legacy keys; `templates.email` for a catalog row).
 */
export interface CatalogKeyRow {
  key: string;
  label: string;
  /** Catalog category, or null for keys that live outside the catalog. */
  category: Category | null;
  /** Catalog audience, or null for keys that live outside the catalog. */
  audience: Audience | null;
  source: CatalogKeySource;
  defaultTemplateId: string;
  /** Whether `emailTemplates/{defaultTemplateId}` actually exists. */
  hasDefaultTemplate: boolean;
  /** Whether a `notificationTemplateBindings` doc exists for this key. */
  bound: boolean;
  /** What dispatch sends for this key right now (binding if active, else default). */
  resolvedTemplateId: string;
}

/** The template id `resolveTemplateId` falls back to for a catalog key. */
function defaultTemplateIdForCatalogKey(key: string): string {
  return NOTIFICATION_CATALOG[key]?.templates.email ?? key;
}

/**
 * Catalog rows whose `templates.email` differs from their `key`. Empty today.
 * A non-empty result means the binding doc id dispatch actually reads is no
 * longer the catalog key, which would make every binding on the drifted row
 * dead without a single error, so a test asserts this stays empty.
 */
export function catalogKeyEmailTemplateDrift(): Array<{ key: string; emailTemplateId: string | undefined }> {
  return Object.values(NOTIFICATION_CATALOG)
    .filter((def) => def.templates.email !== def.key)
    .map((def) => ({ key: def.key, emailTemplateId: def.templates.email }));
}

/**
 * Every key a binding can be written under and still be read by dispatch:
 * catalog keys plus the direct-send literals. Retired alias keys are NOT in
 * here, on purpose. Dispatch resolves an alias to its canonical row and then
 * looks up the CANONICAL key's template id, so a binding stored at the alias
 * doc id would never be read.
 */
export function liveCatalogKeys(): Set<string> {
  const set = new Set<string>(Object.keys(NOTIFICATION_CATALOG).map(defaultTemplateIdForCatalogKey));
  for (const d of DIRECT_SEND_KEYS) set.add(d.key);
  return set;
}

/** True when a binding written at [key] would actually be read by dispatch. */
export function isLiveCatalogKey(key: string): boolean {
  return liveCatalogKeys().has(key);
}

/**
 * The human label for [key], or null when nothing on the platform sends it.
 * Lets an error name the notification an admin would break, not just its id.
 */
export function catalogKeyLabel(key: string): string | null {
  const def = NOTIFICATION_CATALOG[key];
  if (def) return def.label;
  return DIRECT_SEND_KEYS.find((d) => d.key === key)?.label ?? null;
}

/**
 * The reason [key] cannot be bound, in words an admin can act on, or null when
 * the key is fine. Retired keys get told which key replaced them rather than a
 * flat "unknown", because the caller is not wrong so much as out of date.
 */
export function explainUnbindableKey(key: string): string | null {
  if (isLiveCatalogKey(key)) return null;
  if (NOTIFICATION_KEY_ALIASES[key]) {
    return (
      `Catalog key '${key}' is retired and nothing dispatches it. ` +
      `Bind '${canonicalNotificationKey(key)}' instead.`
    );
  }
  const retired = RETIRED_NOTIFICATION_KEYS[key];
  if (retired) {
    return (
      `Catalog key '${key}' was retired on ${retired.retiredOn} and nothing sends it ` +
      `any more. ${retired.reason} There is no replacement key to bind instead.`
    );
  }
  return (
    `Unknown catalog key '${key}'. It is not in the notification catalog and nothing ` +
    `sends it, so a binding here would never be read. Pick a key from listCatalogKeys.`
  );
}

/**
 * The full catalog-key list as rows, folding in the current bindings so a client
 * can show what is bound and what each key resolves to today.
 *
 * @param boundKeys      catalog keys that have a binding doc.
 * @param activeBindings key -> templateId for bindings that are NOT inactive.
 *                       An inactive binding falls back to the default, matching
 *                       `resolveTemplateId`.
 * @param templateIds    ids present in `emailTemplates`, for hasDefaultTemplate.
 */
export function buildCatalogKeyRows(
  boundKeys: ReadonlySet<string>,
  activeBindings: ReadonlyMap<string, string>,
  templateIds: ReadonlySet<string>,
): CatalogKeyRow[] {
  const rows: CatalogKeyRow[] = [];
  const seen = new Set<string>();

  const push = (
    key: string,
    label: string,
    category: Category | null,
    audience: Audience | null,
    source: CatalogKeySource,
    defaultTemplateId: string,
  ) => {
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      key,
      label,
      category,
      audience,
      source,
      defaultTemplateId,
      hasDefaultTemplate: templateIds.has(defaultTemplateId),
      bound: boundKeys.has(key),
      resolvedTemplateId: activeBindings.get(key) ?? defaultTemplateId,
    });
  };

  for (const def of Object.values(NOTIFICATION_CATALOG)) {
    push(
      defaultTemplateIdForCatalogKey(def.key),
      def.label,
      def.category,
      def.audience,
      'catalog',
      defaultTemplateIdForCatalogKey(def.key),
    );
  }
  for (const d of DIRECT_SEND_KEYS) {
    push(d.key, d.label, null, null, 'direct-send', d.key);
  }
  // Whatever else is already in the bindings collection. These are dead keys,
  // but they are the operator's data and hiding them would leave the Assignments
  // screen showing a binding the key list denies exists.
  for (const key of boundKeys) {
    push(key, 'Not in the catalog, nothing dispatches it', null, null, 'legacy', key);
  }

  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
}
