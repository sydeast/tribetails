package com.tribetails.auntieos.web.config

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 0D, the central registry must carry every promoted local FF_ flag so the
 * Feature Flags admin screen can toggle them, and the map round-trips losslessly.
 */
class FeatureFlagsTest {

    // The promoted keys still gated dark (formerly screen-local `const val FF_… = false`).
    // NOTE: invoices.create + invoices.generateReceipt were promoted to live in
    // slice 2 (backed by the createInvoice / generateReceipt callables), so they
    // are intentionally NOT in this default-off list; they still live in KEYS.
    // NOTE: kintale.petMoodPills went live in slice 3 (default template ships
    // petMoodEnabled with mood options and the composer authors selections), so it
    // defaults ON now and is likewise omitted here while remaining in KEYS.
    // NOTE: kintale.commentThread went live in slice 4 (live read from
    // kin_care_reports/{taleId}/comments + addKinTaleComment write). It is now a
    // kill-switch that defaults ON, so it is omitted from the default-off list here
    // while remaining in KEYS (the admin screen can still flip it off).
    private val promotedKeys = listOf(
        // NOTE: communicate.broadcast went LIVE in Stage 2 step 6 (saved audience
        // segments + multichannel fan-out: saveAudienceSegment /
        // listAudienceSegments / deleteAudienceSegment / broadcastMessage admin
        // callables). It now defaults ON as a kill-switch, so it is omitted from
        // the default-off list here while remaining in KEYS (admin can flip it off).
        // NOTE: communicate.externalSend went LIVE in Stage 2 step 5 (real
        // sendExternalMessage + suppressExternalRecipient admin callables: client-side
        // channel/recipient validation, opt-out consent gate surfaced clearly, audit
        // with the recipient redacted). The flag was removed from the registry entirely
        // (9 -> 8 keys), so it is no longer listed here or in KEYS.
        // NOTE: settings.profilePicUpload went live in slice 7 (real avatar upload
        // pipeline + setMediaProfilePhoto callable stamping users/{uid}.photoUrl).
        // It now defaults ON as a kill-switch, so it is omitted from the
        // default-off list here while remaining in KEYS (admin can flip it off).
        "auntieos.settings.integrationManage",
        // NOTE: formschemas.livePreview went LIVE (real preview pane via the shared
        // DynamicFormFields renderer + formSchemaPreviewModel mapper). The flag was
        // removed from the registry entirely, so it is no longer listed here or in KEYS.
        // NOTE: the Stage-2 Step-2 batch (home.weeklyRevenueStat, directory.lastVisit,
        // directory.newBadge, schedule.dragReschedule, auntieTime.multiPetAvatars,
        // invoices.clientPaymentsHeuristic) was promoted to always-on and REMOVED from
        // the registry entirely (real streams + the rescheduleBooking callable), so
        // those keys are no longer listed here or in KEYS.
        // NOTE: the Stage-2-tail Step-1 flags (invoices.headerActions,
        // invoices.sendReminder, invoices.reviewAndSendDraft, bookings.bulkSelect,
        // inbox.bulkMarkRead, templateAssignment.unboundCatalogHint) went LIVE and
        // were removed from the registry entirely (real callables:
        // generateReceipt / sendInvoiceReminder / postInvoiceEvent /
        // batchUpdateBookings / bulkMarkNotificationsRead / listCatalogKeys), so
        // they are no longer listed here.
        // NOTE: formschemas.rowDelete went live (deleteFormSchema callable wired into
        // the list row with an AuntieDialog confirm), and kintale.viewAsKinfolk went
        // live (view-as-kinfolk preview + createShareLink share dialog). Both flags
        // were removed from the registry entirely, so they are no longer listed here.
        // NOTE: trainingDocs.create went live in slice 6 (Tribal Intel generator:
        // createTrainingDocument / updateTrainingDocument / deleteTrainingDocument
        // admin callables + reconcile note channel). It now defaults ON as a
        // kill-switch, so it is omitted from the default-off list here while
        // remaining in KEYS (the admin screen can still flip it off).
        // NOTE: notifications.quickActions went LIVE in Stage 2 Step 4 (real
        // markNotificationRead / markNotificationUnread / archiveNotification /
        // bulkArchiveNotifications / batchUpdateBookings callables + targetType
        // linkage). The flag was removed from the registry entirely (10 -> 9 keys),
        // so it is no longer listed here or in KEYS.
    )

    @Test fun `registry contains every promoted flag key`() {
        for (key in promotedKeys) {
            assertTrue(key in FeatureFlags.KEYS, "missing key in registry: $key")
        }
    }

    @Test fun `all promoted flags default off`() {
        val defaults = FeatureFlags.DEFAULT.toMap()
        for (key in promotedKeys) {
            assertEquals(false, defaults[key], "$key should default off (dark)")
        }
    }

    @Test fun `overrides toggle a promoted flag on and round-trip`() {
        val flags = FeatureFlags.fromOverrides(mapOf("auntieos.invoices.create" to true))
        assertTrue(flags.toMap()["auntieos.invoices.create"] == true)
        // other flags untouched (settings.integrationManage still defaults off)
        assertFalse(flags.toMap()["auntieos.settings.integrationManage"] == true)
    }

    @Test fun `toMap and fromMap round-trip losslessly`() {
        val original = FeatureFlags.fromOverrides(
            mapOf(
                "auntieos.kintale.commentThread" to true,
                "auntieos.communicate.broadcast" to true,
                "auntieos.settings.integrationManage" to true,
            )
        )
        val restored = FeatureFlags.fromMap(original.toMap())
        assertEquals(original, restored)
    }

    @Test fun `unknown remote keys are ignored`() {
        val flags = FeatureFlags.fromOverrides(mapOf("auntieos.bogus.nope" to true))
        assertEquals(FeatureFlags.DEFAULT, flags)
    }

    // 2026-06-08 prod regression: a stale `auntieos.communicate.broadcast: false`
    // doc dark-gated the live Broadcast feature. ALWAYS_ON keys must be immune to
    // remote overrides so a shipped, always-on feature can never be silently killed.
    @Test fun `always-on flag is immune to a stale false override`() {
        val flags = FeatureFlags.fromOverrides(
            mapOf("auntieos.communicate.broadcast" to false)
        )
        assertTrue(flags.communicateBroadcast, "broadcast (ALWAYS_ON) must ignore remote false")
        assertEquals(FeatureFlags.DEFAULT, flags)
    }

    @Test fun `every always-on key survives a false override`() {
        val allOff = FeatureFlags.ALWAYS_ON.associateWith { false }
        val flags = FeatureFlags.fromOverrides(allOff).toMap()
        for (key in FeatureFlags.ALWAYS_ON) {
            assertEquals(true, flags[key], "$key is ALWAYS_ON and must stay on")
        }
    }

    @Test fun commsRecap_defaults_off_and_round_trips() {
        assertFalse(FeatureFlags().communicateCommsRecap)
        assertTrue(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP in FeatureFlags.KEYS)
        // not ALWAYS_ON — operator can flip it on remotely
        assertFalse(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP in FeatureFlags.ALWAYS_ON)
        val on = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP to true))
        assertTrue(on.communicateCommsRecap)
    }
}
