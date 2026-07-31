package com.tribetails.auntieos.web.config

/**
 * Client feature flags for AuntieOS web.
 *
 * Mirrors MyTribe's pattern (no Firebase Remote Config; runtime Firestore-doc
 * read via the shared `getFeatureFlags` callable). Precedence:
 *   1. compile-time [DEFAULT] (this file) - safe baseline shipped in the app
 *   2. global doc  `business_settings/feature_flags`  (dark-launch for everyone)
 *   3. per-user override (merged server-side by getFeatureFlags)
 *
 * Keys are namespaced `auntieos.<area>.<flag>` so AuntieOS and MyTribe
 * (`mytribe.*`) share one Firestore doc without collision. Unknown keys are
 * ignored (a typo in the remote doc can never cause surprise behavior).
 *
 * These flags gate "suggested" UI from the redesign mockups that is NOT yet
 * backed by a real callable/data path - they default OFF and ship dark until
 * the backend exists. Anything backable today is built, not gated.
 *
 * 0D: the formerly screen-local `const val FF_… = false` dark gates are promoted
 * here so the Feature Flags admin screen can dark-launch each when its backend
 * lands. Screens read these via `LocalFeatureFlags.current`.
 */
data class FeatureFlags(
    // ---- 0D: promoted from screen-local FF_ consts ----
    /** Communicate: Broadcast send (segments + multichannel fan-out). Live:
     *  broadcastMessage + saveAudienceSegment/listAudienceSegments/
     *  deleteAudienceSegment callables shipped (Stage 2 step 6). Kill-switch:
     *  default on, flip off to hide. */
    val communicateBroadcast: Boolean = true,
    /** Settings: profile-picture upload (real avatar upload pipeline; slice 7). */
    val settingsProfilePicUpload: Boolean = true,
    /** Invoices: create invoice (slice 2: createInvoice callable live). */
    val invoicesCreate: Boolean = true,
    /** Invoices: generate receipt (slice 2: generateReceipt callable live). */
    val invoicesGenerateReceipt: Boolean = true,
    /** KinTale report: pet-mood pills. Live: default template ships
     *  petMoodEnabled with mood options and the composer authors selections. */
    val kintalePetMoodPills: Boolean = true,
    /** KinTale report: forum-style comment thread (live read + addKinTaleComment).
     *  Wired on all three platforms; flag remains as a kill-switch (default on). */
    val kintaleCommentThread: Boolean = true,
    /** Training Docs: create/update/delete (callables shipped, spec 23). */
    val trainingDocsCreate: Boolean = true,
    /** Communicate/KinTale: route copy generation through the Firebase `generate`
     *  function instead of the (retired, often-offline) n8n webhook. ALWAYS_ON: a
     *  stale remote `false` must never re-route generation back to a dead n8n. */
    val communicateGenerateViaFunction: Boolean = true,
    val communicateCommsRecap: Boolean = false,
) {
    fun toMap(): Map<String, Boolean> = mapOf(
        KEY_COMMUNICATE_BROADCAST to communicateBroadcast,
        KEY_SETTINGS_PROFILE_PIC_UPLOAD to settingsProfilePicUpload,
        KEY_INVOICES_CREATE to invoicesCreate,
        KEY_INVOICES_GENERATE_RECEIPT to invoicesGenerateReceipt,
        KEY_KINTALE_PET_MOOD to kintalePetMoodPills,
        KEY_KINTALE_COMMENT_THREAD to kintaleCommentThread,
        KEY_TRAINING_DOC_CREATE to trainingDocsCreate,
        KEY_COMMUNICATE_GENERATE_VIA_FUNCTION to communicateGenerateViaFunction,
        KEY_COMMUNICATE_COMMS_RECAP to communicateCommsRecap,
    )

    companion object {
        // 0D promoted keys
        const val KEY_COMMUNICATE_BROADCAST = "auntieos.communicate.broadcast"
        const val KEY_SETTINGS_PROFILE_PIC_UPLOAD = "auntieos.settings.profilePicUpload"
        const val KEY_INVOICES_CREATE = "auntieos.invoices.create"
        const val KEY_INVOICES_GENERATE_RECEIPT = "auntieos.invoices.generateReceipt"
        const val KEY_KINTALE_PET_MOOD = "auntieos.kintale.petMoodPills"
        const val KEY_KINTALE_COMMENT_THREAD = "auntieos.kintale.commentThread"
        const val KEY_TRAINING_DOC_CREATE = "auntieos.trainingDocs.create"
        const val KEY_COMMUNICATE_GENERATE_VIA_FUNCTION = "auntieos.communicate.generateViaFunction"
        const val KEY_COMMUNICATE_COMMS_RECAP = "auntieos.communicate.commsRecap"

        /** Compile-time safe baseline. */
        val DEFAULT = FeatureFlags()

        /** Every key the client understands. Unknown remote keys are ignored. */
        val KEYS: List<String> = DEFAULT.toMap().keys.toList()

        /**
         * #3: built features that ship ON by default and are intentionally NOT shown as
         * toggle rows in the admin screen (they are not experimental flags). They stay in
         * the registry (so a remote override can still kill-switch one in an emergency),
         * but the operator's Feature Flags screen only lists genuinely-gated flags. A new
         * flag NOT in this set still must get a row (FeatureFlagsScreenCoverageTest).
         */
        val ALWAYS_ON: Set<String> = setOf(
            KEY_COMMUNICATE_BROADCAST,
            KEY_SETTINGS_PROFILE_PIC_UPLOAD,
            KEY_INVOICES_CREATE,
            KEY_INVOICES_GENERATE_RECEIPT,
            KEY_KINTALE_PET_MOOD,
            KEY_KINTALE_COMMENT_THREAD,
            KEY_TRAINING_DOC_CREATE,
            KEY_COMMUNICATE_GENERATE_VIA_FUNCTION,
        )

        /** Builds flags from a key->bool map, defaulting any omitted key. */
        fun fromMap(map: Map<String, Boolean>): FeatureFlags {
            val d = DEFAULT
            fun v(key: String, def: Boolean) = map[key] ?: def
            return FeatureFlags(
                communicateBroadcast = v(KEY_COMMUNICATE_BROADCAST, d.communicateBroadcast),
                settingsProfilePicUpload = v(KEY_SETTINGS_PROFILE_PIC_UPLOAD, d.settingsProfilePicUpload),
                invoicesCreate = v(KEY_INVOICES_CREATE, d.invoicesCreate),
                invoicesGenerateReceipt = v(KEY_INVOICES_GENERATE_RECEIPT, d.invoicesGenerateReceipt),
                kintalePetMoodPills = v(KEY_KINTALE_PET_MOOD, d.kintalePetMoodPills),
                kintaleCommentThread = v(KEY_KINTALE_COMMENT_THREAD, d.kintaleCommentThread),
                trainingDocsCreate = v(KEY_TRAINING_DOC_CREATE, d.trainingDocsCreate),
                communicateGenerateViaFunction = v(KEY_COMMUNICATE_GENERATE_VIA_FUNCTION, d.communicateGenerateViaFunction),
                communicateCommsRecap = v(KEY_COMMUNICATE_COMMS_RECAP, d.communicateCommsRecap),
            )
        }

        /**
         * Overlays sparse remote overrides onto the compile-time defaults.
         *
         * ALWAYS_ON keys are immune to remote overrides: a shipped, always-on
         * feature must never be silently killed by a stale Firestore doc. (A
         * stale `auntieos.communicate.broadcast: false` dark-gated the live
         * Broadcast feature in prod, 2026-06-08.) Unknown keys are ignored.
         */
        fun fromOverrides(overrides: Map<String, Boolean>): FeatureFlags =
            fromMap(DEFAULT.toMap() + overrides.filterKeys { it in KEYS && it !in ALWAYS_ON })
    }
}
