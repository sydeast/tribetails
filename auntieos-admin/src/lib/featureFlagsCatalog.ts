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
/**
 * Which of two Inbox arrangements the message-thread list is drawn in. ON (the
 * default) is the "Waiting on a reply" / "Answered" sectioning PR #301 shipped;
 * OFF is the arrangement that preceded it, one flat list grouped by local
 * calendar day. Day grouping lives inside both, so this is a layout choice and
 * not a feature switch: the filter chips, the unread badge, the row markup and
 * "Mark all read" are the same product on either side.
 *
 * ── THIS FLAG IS AN A/B TRIAL, AND IT IS MEANT TO DIE ─────────────────────
 * It exists so the operator can live on each arrangement in turn and keep the
 * one they prefer. When that decision is made, REMOVING THE LOSING ARM is:
 *
 *   1. Delete this constant and its KEYS / DEFAULTS entries here, and the same
 *      three in android `config/FeatureFlags.kt`. The two coverage tests
 *      (FeatureFlags.coverage.test.ts, FeatureFlagsScreenCoverageTest.kt) then
 *      FAIL until the toggle rows in FeatureFlags.tsx / FeatureFlagsScreen.kt
 *      go too, so neither screen can be left listing a key nothing reads.
 *   2. Delete the losing branch: Inbox.tsx's `arrangement === 'flatByDay'`
 *      block and android `MessagesSection`'s `ThreadSectionKey.FLAT` handling,
 *      plus `inboxArrangementFromFlags` / `arrangeThreads` and every test that
 *      names the losing arm.
 *   3. If SECTIONS LOSE, `groupThreadsByWaiting` (both clients),
 *      `SECTION_READ_STATE`, `ThreadSectionKey`, the `.inbox__status-*` CSS and
 *      the empty-section copy all go with it, and the Inbox golden must be
 *      re-recorded. If SECTIONS WIN, nothing in `inboxFormat.ts` dies:
 *      `groupThreadsByDay` still runs inside every section, and the golden
 *      already photographs that arrangement.
 *   4. Clear the key out of `business_settings/feature_flags.flags`, so no
 *      stale doc outlives the code that read it.
 */
export const KEY_INBOX_WAITING_SECTIONS = 'auntieos.inbox.waitingSections';

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
  KEY_INBOX_WAITING_SECTIONS,
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
  // Defaults TRUE, unlike every other gated flag here, and deliberately so:
  // merging this PR must not change what the operator already sees. The
  // sectioned Inbox is what main renders today and what the committed golden
  // photographs, so the safe baseline is "keep it", and the flag's job is to
  // let the operator step BACK to the older arrangement, not forward into an
  // unproven one. Deliberately NOT in ALWAYS_ON below: an ALWAYS_ON key gets no
  // toggle row and ignores remote overrides, which are the two things an A/B
  // trial cannot do without.
  [KEY_INBOX_WAITING_SECTIONS]: true,
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
