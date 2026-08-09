package com.tribetails.auntieos.config

/**
 * Client feature flags for AuntieOS Android. Android parity with the web
 * `com.tribetails.auntieos.web.config.FeatureFlags` (0D-android).
 *
 * Keys, defaults, and merge semantics are IDENTICAL to web so both clients share the
 * single Firestore doc `business_settings/feature_flags` without collision. Precedence:
 *   1. compile-time [DEFAULT] (this file) - safe baseline shipped in the app
 *   2. global doc `business_settings/feature_flags` (dark-launch for everyone)
 *   3. per-user override (merged server-side by getFeatureFlags)
 *
 * Keys are namespaced `auntieos.<area>.<flag>`. Unknown remote keys are ignored.
 * Flags gate "suggested" UI not yet backed by a real callable/data path; they default
 * OFF and ship dark until the backend exists. Screens read via `LocalFeatureFlags.current`.
 */
data class FeatureFlags(
    // Communicate broadcast (segments + multichannel fan-out) went live in Stage 2
    // step 6. Kill-switch: defaults ON (parity with web), flip off to hide.
    val communicateBroadcast: Boolean = true,
    // #3: built features default ON (parity with web).
    val settingsProfilePicUpload: Boolean = true,
    val invoicesCreate: Boolean = true,
    val invoicesGenerateReceipt: Boolean = true,
    val kintalePetMoodPills: Boolean = true,
    // KinTale forum-style comment thread on a SENT report (live read +
    // addKinTaleComment write). Kill-switch: default on, flip off to hide.
    val kintaleCommentThread: Boolean = true,
    val trainingDocsCreate: Boolean = true,
    // Route copy generation through the Firebase `generate` function instead of the
    // retired/offline n8n webhook. ALWAYS_ON: a stale remote `false` must never
    // re-route generation back to a dead n8n. Parity with web.
    val communicateGenerateViaFunction: Boolean = true,
    val communicateCommsRecap: Boolean = false,
    // WARNING-8 (android-only): when ON, the client STOPS persisting inbound
    // call/voicemail/SMS records from spoofable FCM data pushes; the MyTribe
    // server-side Twilio webhooks (twilioInboundSms/Voicemail/Call) become the
    // sole authoritative writer to calls_log/voicemails/sms_messages. Ships OFF
    // (today's behavior: client writes) so it is safe BEFORE the operator
    // verifies the server path; flip ON to close the vuln once the webhooks are
    // live. Operator-flippable (NOT in ALWAYS_ON). Default-off is the
    // SAFE-for-data choice: an unknown/unreadable flag keeps the client write so
    // records are never lost. This flag has no web counterpart (the inbound-push
    // persistence path is android-only), so it lives in the android registry only.
    val inboundCommsServerAuthoritative: Boolean = false,
    // Which of two Inbox arrangements the message-thread list is drawn in. ON
    // (the default) is the "Waiting on a reply" / "Answered" sectioning PR #301
    // shipped; OFF is the one flat run of threads that preceded it here. Both
    // arms are finished code and everything else about the panel is identical,
    // so this is a layout choice the operator makes, not a feature switch.
    //
    // THE ONLY GATED FLAG IN THIS REGISTRY THAT DEFAULTS ON, deliberately: the
    // sections are what android renders today, and shipping this trial must not
    // re-lay out anyone's Inbox on its own. NOT in ALWAYS_ON, because an
    // ALWAYS_ON key gets no toggle row and ignores remote overrides, the two
    // things an A/B trial cannot do without. The key is shared with the React
    // admin (web src/lib/featureFlagsCatalog.ts), so the operator's single
    // choice reaches both clients off one Firestore doc.
    //
    // Its exit plan is written out once, at the web catalog's copy of this key.
    val inboxWaitingSections: Boolean = true,
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
        KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE to inboundCommsServerAuthoritative,
        KEY_INBOX_WAITING_SECTIONS to inboxWaitingSections,
    )

    companion object {
        const val KEY_COMMUNICATE_BROADCAST = "auntieos.communicate.broadcast"
        const val KEY_SETTINGS_PROFILE_PIC_UPLOAD = "auntieos.settings.profilePicUpload"
        const val KEY_INVOICES_CREATE = "auntieos.invoices.create"
        const val KEY_INVOICES_GENERATE_RECEIPT = "auntieos.invoices.generateReceipt"
        const val KEY_KINTALE_PET_MOOD = "auntieos.kintale.petMoodPills"
        const val KEY_KINTALE_COMMENT_THREAD = "auntieos.kintale.commentThread"
        const val KEY_TRAINING_DOC_CREATE = "auntieos.trainingDocs.create"
        const val KEY_COMMUNICATE_GENERATE_VIA_FUNCTION = "auntieos.communicate.generateViaFunction"
        const val KEY_COMMUNICATE_COMMS_RECAP = "auntieos.communicate.commsRecap"
        const val KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE = "auntieos.inboundComms.serverAuthoritative"
        const val KEY_INBOX_WAITING_SECTIONS = "auntieos.inbox.waitingSections"

        /** Compile-time safe baseline. */
        val DEFAULT = FeatureFlags()

        /** Every key the client understands. Unknown remote keys are ignored. */
        val KEYS: List<String> = DEFAULT.toMap().keys.toList()

        /**
         * #3: built features that ship ON by default and are intentionally NOT shown as
         * toggle rows in the admin screen (they are not experimental flags). They stay in
         * the registry (a remote override can still kill-switch one), but the Feature Flags
         * screen only lists genuinely-gated flags. A new flag NOT in this set still must get
         * a row (FeatureFlagsScreenCoverageTest). Mirrors the web ALWAYS_ON.
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
                inboundCommsServerAuthoritative = v(KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE, d.inboundCommsServerAuthoritative),
                inboxWaitingSections = v(KEY_INBOX_WAITING_SECTIONS, d.inboxWaitingSections),
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

        /**
         * WARNING-8 gate (pure, testable). Decides whether the android client should
         * persist an inbound call/voicemail/SMS record that arrived via an
         * (unauthenticated, spoofable) FCM data push.
         *
         * - flag OFF (default): persist == true  -> today's behavior, client writes.
         * - flag ON: persist == false -> client SKIPS the write; the MyTribe
         *   server-side Twilio webhooks are the authoritative writer, closing the vuln.
         *
         * Default-off means an unknown / unreadable flag falls through to the
         * SAFE-for-data branch (write), so inbound records are never silently lost.
         */
        fun shouldPersistInboundFromPush(flags: FeatureFlags): Boolean =
            !flags.inboundCommsServerAuthoritative
    }
}
