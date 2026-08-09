package com.tribetails.auntieos.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FeatureFlagsTest {

    @Test fun defaults_onlyCommsRecapAndInboundCommsOff() {
        // #3: built features default ON (they live in ALWAYS_ON); only the genuinely-gated
        // flags still ship dark. Parity with web defaults (plus the android-only WARNING-8 flag).
        val map = FeatureFlags.DEFAULT.toMap()
        assertTrue(map.filterKeys { it in FeatureFlags.ALWAYS_ON }.values.all { it })
        // commsRecap and the android-only WARNING-8 inboundComms flag are the only
        // default-off flags (integrationManage was retired, not just defaulted-off).
        // WARNING-8 ships dark (OFF) = today's behavior (client writes); the operator
        // flips it ON to make the server authoritative.
        assertEquals(
            setOf(
                FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP,
                FeatureFlags.KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE,
            ),
            map.filterValues { !it }.keys
        )
    }

    @Test fun registry_has11Keys_allNamespaced() {
        // 29 finished/always-on flags have been retired. The latest 6 (Stage 2 Step 2)
        // were built for real, not gated, so their flags are gone:
        //   directory.lastVisit (per-kinfolk last-completed-visit date, lastVisitByKinfolk),
        //   directory.newBadge (isNewKinfolk = created < 14d OR zero KinTales),
        //   auntieTime.multiPetAvatars (kinAvatarsForSession stacked per-stop kin avatars),
        //   home.weeklyRevenueStat (weeklyRevenue = sum of PAID invoices this week),
        //   schedule.dragReschedule (long-press a visit -> reschedule via rescheduleBooking),
        //   invoices.clientPaymentsHeuristic (disclosed kinfolk-level payment fallback).
        // formschemas.livePreview retired: the live preview is now BUILT FOR REAL
        // (renders the in-progress schema through the shared DynamicFormFields
        // renderer), so it is no longer gated.
        // notifications.quickActions retired (Stage 2 Step 4): the per-notification
        // read/unread toggle, open-linked-item, dismiss/archive (+ bulk), and quick
        // approve/deny are BUILT FOR REAL against the deployed markNotificationRead /
        // markNotificationUnread / archiveNotification / bulkArchiveNotifications /
        // batchUpdateBookings callables, so the flag is gone.
        // communicate.externalSend retired (Stage 2 Step 5): the external one-off
        // email/SMS send (+ recipient opt-out) is BUILT FOR REAL against the deployed
        // sendExternalMessage / suppressExternalRecipient callables, so the flag is
        // gone. settings.integrationManage retired (feature-flag cleanup): no backing
        // code ever existed and none was built, so the flag is deleted rather than kept
        // gated. The shared-with-web registry target is 9; the android-only WARNING-8
        // flag (auntieos.inboundComms.serverAuthoritative) adds one android key on top,
        // so the android registry is 10 (web stays 9 - the inbound-push persistence path
        // it gates is android-only). The Inbox arrangement A/B flag
        // (auntieos.inbox.waitingSections) is shared with web and makes it 11 here, 10
        // there; it is a TRIAL and is meant to be deleted once the operator picks an
        // arrangement, which is when these two numbers go back to 10 and 9.
        assertEquals(11, FeatureFlags.KEYS.size)
        assertTrue(FeatureFlags.KEYS.all { it.startsWith("auntieos.") })
        assertEquals(FeatureFlags.KEYS.size, FeatureFlags.KEYS.toSet().size) // no dup keys
    }

    @Test fun keys_matchWebExactly_forSharedFirestoreDoc() {
        // These strings MUST equal the web client's keys or the shared doc desyncs.
        assertEquals("auntieos.communicate.broadcast", FeatureFlags.KEY_COMMUNICATE_BROADCAST)
        assertEquals("auntieos.invoices.create", FeatureFlags.KEY_INVOICES_CREATE)
    }

    @Test fun toMap_fromMap_roundTrips() {
        val flags = FeatureFlags(communicateBroadcast = true, invoicesCreate = true)
        assertEquals(flags, FeatureFlags.fromMap(flags.toMap()))
    }

    @Test fun fromOverrides_appliesKnownAndIgnoresUnknown() {
        val result = FeatureFlags.fromOverrides(
            mapOf(
                FeatureFlags.KEY_INVOICES_CREATE to true,
                "auntieos.totally.bogus" to true, // unknown -> ignored, never surprises
            ),
        )
        assertTrue(result.invoicesCreate)
        assertFalse(result.communicateCommsRecap) // untouched default (still off)
    }

    @Test fun fromOverrides_omittedKeysKeepDefaults() {
        val result = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_INVOICES_CREATE to true))
        assertTrue(result.invoicesCreate)
        assertFalse(result.communicateCommsRecap)
    }

    // 2026-06-08 prod regression: a stale `auntieos.communicate.broadcast: false`
    // doc dark-gated the live Broadcast feature. ALWAYS_ON keys must be immune to
    // remote overrides so a shipped, always-on feature can never be silently killed.
    @Test fun fromOverrides_alwaysOnImmuneToStaleFalseOverride() {
        val flags = FeatureFlags.fromOverrides(
            mapOf(FeatureFlags.KEY_COMMUNICATE_BROADCAST to false),
        )
        assertTrue(flags.communicateBroadcast)
        assertEquals(FeatureFlags.DEFAULT, flags)
    }

    @Test fun fromOverrides_everyAlwaysOnKeySurvivesFalse() {
        val allOff = FeatureFlags.ALWAYS_ON.associateWith { false }
        val map = FeatureFlags.fromOverrides(allOff).toMap()
        FeatureFlags.ALWAYS_ON.forEach { key ->
            assertEquals(true, map[key])
        }
    }

    @Test fun commsRecap_defaults_off_and_round_trips() {
        assertFalse(FeatureFlags().communicateCommsRecap)
        assertTrue(FeatureFlags.KEYS.contains(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP))
        assertFalse(FeatureFlags.ALWAYS_ON.contains(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP))
        val on = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_COMMUNICATE_COMMS_RECAP to true))
        assertTrue(on.communicateCommsRecap)
    }

    // The Inbox arrangement A/B trial. The ONLY gated flag here that defaults ON,
    // because both of its arms are finished code and the default has to be the
    // arrangement already shipping: merging must not re-lay out anyone's Inbox.
    @Test fun inboxWaitingSections_defaultsOn_inKeys_notAlwaysOn_andFlipsOff() {
        assertTrue(FeatureFlags().inboxWaitingSections)
        assertTrue(FeatureFlags.KEYS.contains(FeatureFlags.KEY_INBOX_WAITING_SECTIONS))
        // NOT always-on: an ALWAYS_ON key gets no toggle row and ignores remote
        // overrides, which are exactly the two things an A/B trial needs.
        assertFalse(FeatureFlags.ALWAYS_ON.contains(FeatureFlags.KEY_INBOX_WAITING_SECTIONS))
        val off = FeatureFlags.fromOverrides(mapOf(FeatureFlags.KEY_INBOX_WAITING_SECTIONS to false))
        assertFalse(off.inboxWaitingSections)
        assertEquals(off, FeatureFlags.fromMap(off.toMap()))
    }

    @Test fun inboxWaitingSections_keyMatchesWeb_forTheSharedFirestoreDoc() {
        // One doc, three clients: this string is how the operator's single choice
        // reaches both the React admin and android.
        assertEquals("auntieos.inbox.waitingSections", FeatureFlags.KEY_INBOX_WAITING_SECTIONS)
    }

    // WARNING-8: android-only flag that gates client-side persistence of inbound
    // call/voicemail/SMS records from spoofable FCM pushes. Ships dark (OFF).
    @Test fun inboundCommsServerAuthoritative_defaultsOff_inKeys_notAlwaysOn_andFlips() {
        // Default OFF = today's behavior (client still writes); safe to ship before
        // the operator verifies the server Twilio webhook path.
        assertFalse(FeatureFlags().inboundCommsServerAuthoritative)
        // In the registry so a remote override can reach it.
        assertTrue(FeatureFlags.KEYS.contains(FeatureFlags.KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE))
        // NOT always-on: it is operator-flippable (a stale remote value must be honored,
        // unlike ALWAYS_ON keys).
        assertFalse(FeatureFlags.ALWAYS_ON.contains(FeatureFlags.KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE))
        // fromOverrides flips it ON.
        val on = FeatureFlags.fromOverrides(
            mapOf(FeatureFlags.KEY_INBOUND_COMMS_SERVER_AUTHORITATIVE to true)
        )
        assertTrue(on.inboundCommsServerAuthoritative)
        // Round-trips through toMap/fromMap.
        assertEquals(on, FeatureFlags.fromMap(on.toMap()))
    }

    // WARNING-8 pure gating helper. The MainActivity intent handlers are not unit-testable
    // (Activity), so the decision lives in this pure function and is covered here.
    @Test fun shouldPersistInboundFromPush_writesWhenFlagOff_skipsWhenOn() {
        // Flag OFF (default) -> persist (today's behavior, client writes).
        assertTrue(FeatureFlags.shouldPersistInboundFromPush(FeatureFlags.DEFAULT))
        assertTrue(FeatureFlags.shouldPersistInboundFromPush(FeatureFlags()))
        // Flag ON -> skip the client write (server is authoritative, vuln closed).
        val serverAuthoritative = FeatureFlags(inboundCommsServerAuthoritative = true)
        assertFalse(FeatureFlags.shouldPersistInboundFromPush(serverAuthoritative))
    }

    @Test fun retiredFlags_absentFromRegistry() {
        // The retired flags' keys must no longer appear in the shared registry.
        val retired = setOf(
            // Stage 2 Step 2 (this slice): all 6 built for real, no flag gate.
            "auntieos.directory.lastVisit",
            "auntieos.directory.newBadge",
            "auntieos.auntieTime.multiPetAvatars",
            "auntieos.home.weeklyRevenueStat",
            "auntieos.schedule.dragReschedule",
            "auntieos.invoices.clientPaymentsHeuristic",
            "auntieos.shell.notificationBell",
            "auntieos.kintale.listSearch",
            "auntieos.auntieTime.timeBlockLabels",
            "auntieos.activity.chainVerify",
            "auntieos.payments.searchFilter",
            "auntieos.templateBank.search",
            "auntieos.formschemas.search",
            "auntieos.formschemas.countChip",
            "auntieos.trainingDocs.commFilter",
            "auntieos.templateAssignment.triggerOverrideEcho",
            "auntieos.schedule.newVisit",
            "auntieos.settings.schedulingSync",
            "auntieos.formschemas.rowDelete",
            "auntieos.kintale.viewAsKinfolk",
            "auntieos.schedule.googleCalBusy",
            "auntieos.home.globalSearch",
            // Stage 2 tail (this slice): all 6 wired to real deployed callables.
            "auntieos.invoices.headerActions",      // generateReceipt + sendInvoiceReminder
            "auntieos.invoices.sendReminder",       // sendInvoiceReminder
            "auntieos.invoices.reviewAndSendDraft", // postInvoiceEvent (DRAFT -> sent)
            "auntieos.bookings.bulkSelect",         // batchUpdateBookings
            "auntieos.inbox.bulkMarkRead",          // bulkMarkNotificationsRead (Notifications)
            "auntieos.templateAssignment.unboundCatalogHint", // listCatalogKeys diff
            // Live preview built for real (DynamicFormFields), no longer gated.
            "auntieos.formschemas.livePreview",
            // Stage 2 Step 4: notifications quick actions built for real (read/unread
            // toggle, open-linked-item, dismiss/archive + bulk, quick approve/deny).
            "auntieos.notifications.quickActions",
            // Stage 2 Step 5: external one-off email/SMS send + recipient opt-out built
            // for real against sendExternalMessage / suppressExternalRecipient.
            "auntieos.communicate.externalSend",
            // Feature-flag cleanup: settings.integrationManage had no backing code and
            // none was built for it, so it is deleted outright rather than kept gated.
            "auntieos.settings.integrationManage",
        )
        assertTrue(FeatureFlags.KEYS.none { it in retired })
    }
}
