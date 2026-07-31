/**
 * Central `auntieos.*` feature-flag catalog for the React admin: the key list,
 * compile-time defaults, the ALWAYS_ON set, and the override-merge rule.
 *
 * Ported from the Kotlin registries this mirrors key-for-key (android
 * `config/FeatureFlags.kt`, composeApp `web/config/FeatureFlags.kt`), so all
 * three clients share one Firestore doc (`business_settings/feature_flags`)
 * without collision. Before this module, FeatureFlags.tsx hand-rolled its own
 * FLAGS array with no registry behind it and no defaulting on read, so a stale
 * remote doc had nothing stopping it from silently disabling an ALWAYS_ON
 * feature on web. That is the same class of incident the Kotlin registries
 * already had to fix once (see the ALWAYS_ON note on `fromOverrides` below).
 *
 * Precedence, identical to both Kotlin registries:
 *   1. compile-time DEFAULTS (this file), the safe baseline shipped in the app.
 *   2. global doc `business_settings/feature_flags` (dark-launch for everyone).
 *   3. per-user override (merged server-side by getFeatureFlags).
 *
 * Keys are namespaced `auntieos.<area>.<flag>`. Unknown remote keys are ignored.
 * `auntieos.settings.integrationManage` is deliberately absent: deleted by the
 * flag-cleanup PR (nothing ever read it), resolved here during the rebase.
 */

export const KEY_COMMUNICATE_BROADCAST = 'auntieos.communicate.broadcast';
export const KEY_SETTINGS_PROFILE_PIC_UPLOAD = 'auntieos.settings.profilePicUpload';
export const KEY_INVOICES_CREATE = 'auntieos.invoices.create';
export const KEY_INVOICES_GENERATE_RECEIPT = 'auntieos.invoices.generateReceipt';
export const KEY_KINTALE_PET_MOOD = 'auntieos.kintale.petMoodPills';
export const KEY_KINTALE_COMMENT_THREAD = 'auntieos.kintale.commentThread';
export const KEY_TRAINING_DOC_CREATE = 'auntieos.trainingDocs.create';
export const KEY_COMMUNICATE_GENERATE_VIA_FUNCTION = 'auntieos.communicate.generateViaFunction';
export const KEY_COMMUNICATE_COMMS_RECAP = 'auntieos.communicate.commsRecap';

/** Every key this client understands. Unknown remote keys are ignored. */
export const KEYS: readonly string[] = [
  KEY_COMMUNICATE_BROADCAST,
  KEY_SETTINGS_PROFILE_PIC_UPLOAD,
  KEY_INVOICES_CREATE,
  KEY_INVOICES_GENERATE_RECEIPT,
  KEY_KINTALE_PET_MOOD,
  KEY_KINTALE_COMMENT_THREAD,
  KEY_TRAINING_DOC_CREATE,
  KEY_COMMUNICATE_GENERATE_VIA_FUNCTION,
  KEY_COMMUNICATE_COMMS_RECAP,
];

/** Compile-time safe baseline. Mirrors the Kotlin registries' DEFAULT. */
export const DEFAULTS: Readonly<Record<string, boolean>> = {
  [KEY_COMMUNICATE_BROADCAST]: true,
  [KEY_SETTINGS_PROFILE_PIC_UPLOAD]: true,
  [KEY_INVOICES_CREATE]: true,
  [KEY_INVOICES_GENERATE_RECEIPT]: true,
  [KEY_KINTALE_PET_MOOD]: true,
  [KEY_KINTALE_COMMENT_THREAD]: true,
  [KEY_TRAINING_DOC_CREATE]: true,
  [KEY_COMMUNICATE_GENERATE_VIA_FUNCTION]: true,
  [KEY_COMMUNICATE_COMMS_RECAP]: false,
};

/**
 * Built features that ship ON by default and are intentionally NOT shown as
 * toggle rows in the admin screen (they are not experimental flags). They stay
 * in the registry (a remote override can still kill-switch one in an
 * emergency), but the Feature Flags screen only lists genuinely-gated flags. A
 * new flag NOT in this set still must get a row (see
 * FeatureFlags.coverage.test.ts). Mirrors both Kotlin ALWAYS_ON sets.
 */
export const ALWAYS_ON: ReadonlySet<string> = new Set([
  KEY_COMMUNICATE_BROADCAST,
  KEY_SETTINGS_PROFILE_PIC_UPLOAD,
  KEY_INVOICES_CREATE,
  KEY_INVOICES_GENERATE_RECEIPT,
  KEY_KINTALE_PET_MOOD,
  KEY_KINTALE_COMMENT_THREAD,
  KEY_TRAINING_DOC_CREATE,
  KEY_COMMUNICATE_GENERATE_VIA_FUNCTION,
]);

/**
 * Overlays sparse remote overrides onto the compile-time defaults.
 *
 * ALWAYS_ON keys are immune to remote overrides: a shipped, always-on feature
 * must never be silently killed by a stale Firestore doc. (A stale
 * `auntieos.communicate.broadcast: false` doc dark-gated the live Broadcast
 * feature in prod, 2026-06-08, the incident that put this immunity rule into
 * both Kotlin registries. Web had no such rule until this file.) Unknown keys
 * are ignored, so a typo in the remote doc can never cause surprise behavior.
 */
export function fromOverrides(overrides: Readonly<Record<string, boolean>>): Record<string, boolean> {
  const applied: Record<string, boolean> = {};
  for (const key of KEYS) {
    if (ALWAYS_ON.has(key)) continue;
    const value = overrides[key];
    if (value !== undefined) applied[key] = value;
  }
  return { ...DEFAULTS, ...applied };
}
