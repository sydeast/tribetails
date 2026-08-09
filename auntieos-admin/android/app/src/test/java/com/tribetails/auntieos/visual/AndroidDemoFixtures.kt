package com.tribetails.auntieos.visual

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
import com.tribetails.auntieos.data.admin.NotificationDetail
import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.model.BaseService
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.Dossier
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.FieldResponse
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaSection
import com.tribetails.auntieos.data.model.FormSchemaSummary
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.GpsSummary
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.Surcharge
import com.tribetails.auntieos.data.model.SurchargeType
import com.tribetails.auntieos.data.model.TimeSlotSource
import com.tribetails.auntieos.data.model.TimeSlotType
import com.tribetails.auntieos.data.model.TrackingAccuracy
import com.tribetails.auntieos.data.model.TrainingDocument
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.model.VoicemailLog
import com.tribetails.auntieos.data.repository.TemplateRepository
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/**
 * Deterministic demo data for android screenshot tests. Mirrors the seeded
 * `_demo:true` names (and the desktop harness's DemoFixtures) so android captures
 * line up with the same ui-ideas mockups. Fixed strings only.
 */
object AndroidDemoFixtures {

    val kinfolk: List<Kinfolk> = listOf(
        Kinfolk(id = "demo-kf-1", firstName = "Wanda", lastName = "Thorne", status = "active",
            phoneNumber = "555-0101", email = "wanda@example.com"),
        Kinfolk(id = "demo-kf-2", firstName = "Nora", lastName = "Halbrook", status = "active",
            phoneNumber = "555-0102", email = "nora@example.com"),
        Kinfolk(id = "demo-kf-3", firstName = "Tessa", lastName = "Brooks", status = "active",
            phoneNumber = "555-0103", email = "tessa@example.com"),
        Kinfolk(id = "demo-kf-4", firstName = "Priya", lastName = "Ashford", status = "active",
            phoneNumber = "555-0104", email = "priya@example.com"),
        Kinfolk(id = "demo-kf-5", firstName = "Iris", lastName = "Ellery", status = "active",
            phoneNumber = "555-0105", email = "iris@example.com"),
        Kinfolk(id = "demo-kf-6", firstName = "Fern", lastName = "Calloway", status = "active",
            phoneNumber = "555-0106", email = "fern@example.com"),
    )

    val allKin: List<Kin> = listOf(
        Kin(id = "k1", name = "Biscuit", kinfolkId = "demo-kf-1", species = "Dog", status = "active"),
        Kin(id = "k2", name = "Gravy", kinfolkId = "demo-kf-1", species = "Dog", status = "active"),
        Kin(id = "k3", name = "Marigold", kinfolkId = "demo-kf-2", species = "Cat", status = "active"),
        Kin(id = "k4", name = "Pepper", kinfolkId = "demo-kf-3", species = "Dog", status = "active"),
        Kin(id = "k5", name = "Clover", kinfolkId = "demo-kf-4", species = "Cat", status = "active"),
        Kin(id = "k6", name = "Sage", kinfolkId = "demo-kf-4", species = "Cat", status = "active"),
        Kin(id = "k7", name = "Cocoa", kinfolkId = "demo-kf-5", species = "Dog", status = "active"),
        Kin(id = "k8", name = "Olive", kinfolkId = "demo-kf-5", species = "Dog", status = "active"),
        Kin(id = "k9", name = "Pip", kinfolkId = "demo-kf-6", species = "Dog", status = "active"),
    )

    val sessions: List<KinCareSession> = listOf(
        KinCareSession(id = "demo-s1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            serviceType = "Dog Walk", startTime = "2026-05-31T09:00", status = "SCHEDULED"),
        KinCareSession(id = "demo-s2", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            serviceType = "Drop-In Visit", startTime = "2026-05-31T14:00", status = "SCHEDULED"),
    )

    val invoice: Invoice = Invoice(id = "demo-inv-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
        invoiceNumber = "INV-1001", client = "Wanda Thorne", address = "The Thornes, Riverside",
        date = "2026-05-20", terms = "Net 15", dueDate = "2026-06-04")

    /**
     * The invoice detail screen's payments panel, as `getInvoiceLedger` answers
     * it — every figure in INTEGER CENTS, resolved server-side.
     *
     * THE ROW IS DELIBERATELY THE $137.50 STRIPE ONE. Its stored `amount` is
     * `13750`, Stripe's own cents in a field the Kotlin `Payment` model reads as
     * dollars, and this screen printed $13750.00 for it until the read moved
     * onto this callable. The golden is where a person looking at the picture
     * would have caught that, so the golden now contains it.
     */
    val invoiceLedger: GetInvoiceLedgerResult = GetInvoiceLedgerResult(
        invoiceId = "demo-inv-1",
        payments = emptyList(),
        paidCents = 0L,
        totalCents = 0L,
        amountDueCents = 0L,
        ledgerPayments = listOf(
            GetInvoiceLedgerResultLedgerPayment(
                paymentId = "demo-pay-stripe",
                amountCents = 13750L,
                // A row the server read cleanly, which is what a demo should
                // show: the unreadable case has its own dedicated test rather
                // than being smuggled into the screenshot baseline.
                amountResolved = true,
                tipCents = 0L,
                feeCents = 0L,
                tipBasis = "unknown",
                reconciles = true,
                appliedCents = 0L,
                unappliedCents = 13750L,
                proceedsCents = 13750L,
                autoApply = false,
                appliedInvoiceId = "",
                appliedInvoiceNumber = "",
                method = "stripe",
                reference = "pi_3Ov1029",
                date = "2026-05-28",
                notes = "",
                recordedBy = null,
            ),
        ),
        unlinkedKinfolkPayments = emptyList(),
        unresolvedAmountCount = 0L,
        sessions = emptyList(),
        missingSessionIds = emptyList(),
        orphanSessionIds = emptyList(),
        truncated = false,
    )

    // === Date-anchored helpers ===
    // Several screens filter to "today" (LocalDate.now()) before rendering a day's
    // list, so these fixtures must be anchored to the real run date, not a hard
    // string, or the list shows the empty-state card instead of content.
    private val today: LocalDate = LocalDate.now()
    private val todayIso: String = today.format(DateTimeFormatter.ISO_LOCAL_DATE) // YYYY-MM-DD
    private fun atToday(hour: Int): String =
        today.atTime(hour, 0).format(DateTimeFormatter.ISO_LOCAL_DATE_TIME) // YYYY-MM-DDTHH:00:00

    // === communicate ===
    val dossier: Dossier = Dossier(
        id = "demo-dos-1", kinfolkId = "demo-kf-1",
        communicationStyle = "Warm and chatty, loves photo updates",
        householdNotes = "Two dogs, fenced yard, gate code on file",
        relationshipWithAuntie = "Long-time client since 2023",
        importantLifeContext = "New baby arriving this summer",
        preferredContactMethod = "Text",
        rawSummary = "The Thornes are easygoing regulars who adore play-by-play visit notes.",
        media = emptyList(),
    )

    val kinForKinfolk: List<Kin> = listOf(
        Kin(id = "k1", kinfolkId = "demo-kf-1", name = "Biscuit", species = "Dog", breed = "Golden Retriever"),
        Kin(id = "k2", kinfolkId = "demo-kf-1", name = "Gravy", species = "Dog", breed = "Beagle"),
    )

    val kin411: Kin411 = Kin411(
        id = "411-k1", kinId = "k1", breed = "Golden Retriever",
        personality = "Goofy and affectionate",
        quirksAndPreferences = "Will not walk past the blue mailbox",
        medicalNotes = "Mild hip stiffness in cold weather",
        dietaryDetails = "2 cups kibble AM/PM, no chicken",
        gallery = emptyList(),
    )

    val generateResponse: GenerateResponse = GenerateResponse(
        generatedCopy = "Hi Wanda! Biscuit had a wonderful walk today, tail wagging the whole way and making two new park friends. Such a joy as always! - Auntie",
        draftId = "demo-draft-1",
        kinfolkId = "demo-kf-1",
        kinfolkName = "Wanda Thorne",
        communicationType = "visit_report",
        model = "claude-opus",
        error = null,
    )

    // === kintale-logs ===
    val kinTaleReports: List<KinCareReport> = listOf(
        KinCareReport(id = "demo-rpt-1", sessionId = "demo-sess-1", kinfolkId = "demo-kf-1",
            kinfolkName = "Wanda Thorne", serviceType = "Drop-In Visit",
            visitDate = "2026-05-20T14:30:00",
            bodyCopy = "Biscuit and Gravy had a calm midday check-in. Both fed and watered, lots of cuddles.",
            mediaFileIds = listOf("m1", "m2"), status = "SENT",
            sentAt = "2026-05-20T15:10:00", sentVia = "sms", createdAt = "2026-05-20T14:00:00"),
        KinCareReport(id = "demo-rpt-2", sessionId = "demo-sess-2", kinfolkId = "demo-kf-2",
            kinfolkName = "Nora Halbrook", serviceType = "Dog Walk",
            visitDate = "2026-05-21T09:00:00",
            bodyCopy = "Marigold was sunbathing by the window all morning. Wrote up a quick note for review.",
            status = "DRAFT", createdAt = "2026-05-21T08:30:00"),
        KinCareReport(id = "demo-rpt-3", sessionId = "demo-sess-3", kinfolkId = "demo-kf-3",
            kinfolkName = "Tessa Brooks", serviceType = "Overnight",
            visitDate = "2026-05-19T20:00:00",
            bodyCopy = "Overnight stay went smoothly. Delivery failed on first send, needs another look.",
            status = "FAILED", sentVia = "email", createdAt = "2026-05-19T19:00:00"),
        KinCareReport(id = "legacy_82", kinfolkId = "", kinfolkName = "", serviceType = "",
            visitDate = "2026-05-10T11:00:00",
            bodyCopy = "Walked the dog around the block, all good.",
            status = "DRAFT", sentVia = "legacy_visit_logs", triageStatus = "",
            createdAt = "2026-05-10T11:00:00"),
    )

    // === manage-bookings (calendar day view; anchored to today) ===
    val bookings: List<EnhancedBooking> = listOf(
        EnhancedBooking(id = "demo-bk-1", title = "Morning Dog Walk", kinfolkId = "demo-kf-1",
            kinfolkName = "Wanda Thorne", kinIds = listOf("k1", "k2"), kinNames = listOf("Biscuit", "Gravy"),
            baseServiceTitle = "Dog Walking", startDateTime = atToday(9), endDateTime = atToday(10),
            totalPrice = 35.0, status = BookingStatus.ACCEPTED, notes = "Front gate code 4421."),
        EnhancedBooking(id = "demo-bk-2", title = "Daycare Drop-In", kinfolkId = "demo-kf-5",
            kinfolkName = "Iris Ellery", baseServiceTitle = "Daycare",
            startDateTime = atToday(13), endDateTime = atToday(15),
            totalPrice = 48.0, status = BookingStatus.DRAFT),
        EnhancedBooking(id = "demo-bk-3", title = "Overnight Stay", kinfolkId = "demo-kf-4",
            kinfolkName = "Priya Ashford", baseServiceTitle = "Overnight",
            startDateTime = atToday(18), endDateTime = atToday(20),
            totalPrice = 90.0, status = BookingStatus.COMPLETED),
    )

    val baseServices: List<BaseService> = listOf(
        BaseService(id = "svc-1", title = "Dog Walking", basePrice = 35.0, isActive = true, category = "Dog Walking"),
        BaseService(id = "svc-2", title = "Overnight", basePrice = 90.0, isActive = true, category = "Overnight Care"),
    )

    // === schedule (SchedulingOptions) ===
    val blockedTimeSlots: List<BookingTimeSlot> = listOf(
        BookingTimeSlot(id = "demo-slot-1", date = todayIso, startTime = "12:00", endTime = "13:00",
            isAvailable = false, slotType = TimeSlotType.BLOCKED, notes = "Lunch",
            source = TimeSlotSource.INTERNAL_MANUAL),
        BookingTimeSlot(id = "demo-slot-2", date = todayIso, startTime = "16:00", endTime = "17:00",
            isAvailable = false, slotType = TimeSlotType.BLOCKED, notes = "Personal appointment",
            source = TimeSlotSource.GOOGLE_BUSY_IMPORT),
    )

    val surcharges: List<Surcharge> = listOf(
        Surcharge(id = "demo-sur-1", title = "Holiday Rate", description = "Holiday surcharge",
            type = SurchargeType.PERCENTAGE_OF_SERVICE, amount = 25.0, isActive = true),
    )

    // === auntie-time (KinCare sessions; ACTIVE bypasses date filter, others anchored to today) ===
    val auntieTimeSessions: List<KinCareSession> = listOf(
        KinCareSession(id = "demo-s1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            serviceType = "Dog Walk", startTime = atToday(9), endTime = atToday(10),
            status = "ARRIVED", arrivedAt = atToday(9), invoiceId = "demo-inv-1",
            notes = "Side gate, leash on hook", kinfolkNotes = "Pls text on arrival"),
        KinCareSession(id = "demo-s2", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            serviceType = "Drop-In Visit", startTime = atToday(14), endTime = atToday(15),
            status = "SCHEDULED", kinfolkNotes = "Two dogs, meds at noon"),
        KinCareSession(id = "demo-s3", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            serviceType = "Daycare", startTime = atToday(8), endTime = atToday(12),
            status = "COMPLETED", completedAt = atToday(12)),
    )

    // === invoices ===
    val invoices: List<Invoice> = listOf(
        invoice,
        Invoice(id = "demo-inv-2", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            invoiceNumber = "INV-1002", client = "Wanda Thorne", address = "The Thornes, Riverside",
            date = "2026-05-20", terms = "Net 15", dueDate = "2026-06-04",
            total = 240.0, amountDue = 240.0, status = "sent", discount = "10%",
            sessionIds = listOf("demo-s1", "demo-s2")),
        Invoice(id = "demo-inv-3", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            invoiceNumber = "INV-1003", client = "Nora Halbrook", address = "Halbrook Residence",
            date = "2026-05-15", terms = "Net 15", dueDate = "2026-05-30",
            total = 120.0, amountDue = 0.0, status = "paid"),
        Invoice(id = "demo-inv-4", kinfolkId = "demo-kf-3", kinfolkName = "Tessa Brooks",
            invoiceNumber = "INV-1004", client = "Tessa Brooks", address = "Brooks Cottage",
            date = "2026-05-25", terms = "Net 30", dueDate = "2026-06-24",
            total = 360.0, amountDue = 360.0, status = "draft"),
    )

    // === payments ===
    val payments: List<Payment> = listOf(
        Payment(id = "demo-pay-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            client = "Wanda Thorne", date = "2026-05-28", paymentMethod = "Cash",
            referenceNumber = "CHK-1042", email = "wanda@example.com",
            tip = 5.0, amount = 60.0, notes = "Two dogs, midday walk"),
        Payment(id = "demo-pay-2", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            client = "Nora Halbrook", date = "2026-05-26", paymentMethod = "Check",
            referenceNumber = "1188", amount = 120.0, notes = "Overnight stay"),
        Payment(id = "demo-pay-3", kinfolkId = "demo-kf-3", kinfolkName = "Tessa Brooks",
            client = "Tessa Brooks", date = "2026-05-24", paymentMethod = "Venmo",
            email = "tessa@example.com", tip = 10.0, amount = 90.0),
        Payment(id = "demo-pay-4", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            client = "Iris Ellery", date = "2026-05-22", paymentMethod = "Zelle",
            amount = 48.0, notes = "Daycare drop-in"),
    )

    // === inbox ===
    val voicemails: List<VoicemailLog> = listOf(
        VoicemailLog(id = "demo-vm-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            callerNumber = "+15035550148",
            transcript = "Hi Auntie, calling to confirm Biscuit's drop-in tomorrow afternoon, thanks!",
            audioUrl = "https://example.com/vm/demo-vm-1.mp3", durationSec = 34,
            direction = "inbound", timestamp = "2026-05-30T15:42:00", replyStatus = "unread"),
    )

    val calls: List<CallLog> = listOf(
        CallLog(id = "demo-call-1", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            counterpartNumber = "+15035550193", direction = "inbound", status = "missed",
            durationSec = 0, timestamp = "2026-05-30T11:08:00"),
    )

    val sms: List<SmsMessage> = listOf(
        SmsMessage(id = "demo-sms-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            counterpartNumber = "+15035550148", direction = "inbound", subType = "sms",
            body = "Running 10 min late for pickup, sorry!", mediaUrls = emptyList(),
            timestamp = "2026-05-30T09:15:00"),
    )

    val emails: List<EmailMessage> = listOf(
        EmailMessage(id = "demo-email-1", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            fromAddress = "nora@example.com", toAddresses = listOf("hello@tribetails.com"),
            subject = "Vaccination records for Pepper",
            body = "Attaching the updated rabies certificate as requested.",
            attachmentUrls = listOf("https://example.com/att/pepper-rabies.pdf"),
            direction = "inbound", timestamp = "2026-05-29T17:03:00"),
    )

    // === activity-log ===
    val activityLog: List<ActivityLogEntry> = listOf(
        ActivityLogEntry(id = "demo-act-1", timestamp = "2026-05-31T14:22:00", actionType = "LOGIN",
            description = "Auntie Admin signed in", status = "SUCCESS", actorId = "demo-admin"),
        ActivityLogEntry(id = "demo-act-2", timestamp = "2026-05-31T13:05:00", actionType = "CREATE_BOOKING",
            description = "Created booking for Wanda Thorne", status = "SUCCESS", actorId = "demo-admin",
            targetId = "demo-bk-1", targetCollection = "enhanced_bookings"),
        ActivityLogEntry(id = "demo-act-3", timestamp = "2026-05-31T11:48:00", actionType = "UPDATE_SETTINGS",
            description = "Updated business hours", status = "SUCCESS", actorId = "demo-admin"),
        ActivityLogEntry(id = "demo-act-4", timestamp = "2026-05-30T16:30:00", actionType = "NOTIFICATION_SENT",
            description = "Sent visit report to Nora Halbrook", status = "SUCCESS", actorId = "demo-admin",
            targetId = "demo-rpt-2", targetCollection = "kin_care_reports"),
        ActivityLogEntry(id = "demo-act-5", timestamp = "2026-05-30T09:12:00", actionType = "DELETE_INVOICE",
            description = "Failed to delete invoice INV-1004", status = "FAILURE", actorId = "demo-admin",
            targetId = "demo-inv-4", targetCollection = "invoices"),
    )

    // === settings ===
    val businessSettings: BusinessSettings = BusinessSettings(
        id = "business_settings",
        enableGPSTrackingForAllVisits = true,
        autoStartTrackingOnVisitStart = true,
        trackingAccuracy = TrackingAccuracy.HIGH,
        defaultEtaMinutes = 15,
        draftRetentionDays = 30,
        observedUsHolidays = listOf("new_years", "thanksgiving", "christmas"),
        companyHolidays = listOf("2026-07-04|Founder's Day"),
        // Unified settings (2026-06-05): booking config folded in from the old
        // admin_settings fixture.
        observeUsHolidays = true,
    )

    val businessHours: List<BusinessHours> = (1..7).map { d ->
        BusinessHours(id = "bh-$d", dayOfWeek = d, isOpen = d <= 5, openTime = "09:00", closeTime = "17:00")
    }

    val userProfile: UserProfile = UserProfile(
        id = "demo-admin", uid = "demo-admin", email = "admin@tribetails.com",
        displayName = "Auntie Admin", firstName = "Auntie", lastName = "Admin",
        title = "Owner", bio = "Lead auntie",
    )

    // === training-documents ===
    val trainingDocs: List<TrainingDocument> = listOf(
        TrainingDocument(id = "demo-td-1", title = "Administering Oral Medication",
            communicationType = "How-to",
            content = "Always confirm the prescription label before each dose. Wrap the pill in a small pocket of " +
                "soft treat or pill paste and offer it from a relaxed, seated position. Watch the swallow, then " +
                "follow with water and a second treat so the dog associates the routine with something positive. " +
                "If the dog spits the pill, wait two minutes and try again rather than forcing it.",
            kinfolkRef = "Wanda Thorne", uploadedAt = "2026-05-10",
            notes = "Confirm dosage with the vet office before each visit."),
        TrainingDocument(id = "demo-td-2", title = "Severe Weather Policy",
            communicationType = "Policy",
            content = "When a heat advisory or thunderstorm warning is in effect, walks are shortened to potty " +
                "breaks only and indoor enrichment replaces the remaining time. Notify the kinfolk through the " +
                "app and log the adjustment. Never leave an animal outdoors unattended during active severe weather.",
            uploadedAt = "2026-05-08"),
        TrainingDocument(id = "demo-td-3", title = "New Auntie Onboarding",
            communicationType = "Training",
            content = "Shadow two full routes before taking solo visits. Review each household's 411 and dossier " +
                "the night before, confirm gate codes and vet contacts, and practice the arrival and departure GPS " +
                "flow so the kinfolk always receives an accurate timeline of the visit.",
            uploadedAt = "2026-05-05"),
    )

    // === notifications ===
    // Shaped like real dispatcher.ts output (issue #20, then ruling R5): a
    // catalog title + description, a resolved actorName, a targetType/targetId
    // pair, the free-form `data` bag the household reference actually hides in,
    // and the server-resolved `detail` the card opens to.
    //
    // NO status/mode/channels. R5 moved delivery state onto
    // `notificationDispatch/{id}`, so a fixture still carrying them would
    // photograph a screen that cannot exist.
    //
    // The last row deliberately carries NO target and NO detail, so the
    // screenshot proves both honest-absence cases at once: no dead Open button,
    // and no disclosure control on a card with nothing to disclose.
    val notifications: List<NotificationEntry> = listOf(
        NotificationEntry(id = "demo-notif-1", key = "kincare.booking.requested", category = "bookings",
            recipientUid = "demo-uid", actorUid = "demo-kf-2",
            createdAt = "2026-05-31T14:02:11Z",
            title = "Visit requested", description = "A household asked for a new KinCare visit.",
            actorName = "Nora Halbrook", targetType = "booking", targetId = "demo-visit-1",
            detail = NotificationDetail(requestedBy = "Nora Halbrook", kinfolkName = "The Halbrook Home",
                kinName = "Marigold", serviceType = "Drop-in visit", bookingDate = "Sun, May 31",
                bookingTime = "9:00 AM", notes = "Side gate, code 4417. Marigold hides under the bed."),
            data = mapOf("kinfolkId" to "demo-kf-2", "bookingId" to "demo-visit-1")),
        NotificationEntry(id = "demo-notif-2", key = "payment.received", category = "payments",
            recipientUid = "demo-uid", actorUid = "demo-kf-1",
            createdAt = "2026-05-31T10:18:00Z",
            title = "Payment received", description = "An invoice was paid in full.",
            actorName = "Wanda Thorne", targetType = "invoice", targetId = "demo-inv-1",
            detail = NotificationDetail(requestedBy = "Wanda Thorne", kinfolkName = "The Thorne Home",
                invoiceNumber = "TT-2048", amount = "$280.00", dueDate = "Jun 5, 2026"),
            data = mapOf("kinfolkId" to "demo-kf-1", "invoiceId" to "demo-inv-1")),
        NotificationEntry(id = "demo-notif-3", key = "kintale.comment.added", category = "kintales",
            recipientUid = "demo-uid", actorUid = "demo-kf-3",
            createdAt = "2026-05-30T19:44:00Z",
            title = "New comment on a KinTale", description = "Someone replied on a visit report.",
            actorName = "Tessa Brooks", targetType = "kintale", targetId = "demo-tale-1",
            detail = NotificationDetail(requestedBy = "Tessa Brooks", kinfolkName = "The Brooks Home",
                kinName = "Biscuit"),
            data = mapOf("kinfolkId" to "demo-kf-3", "taleId" to "demo-tale-1")),
        NotificationEntry(id = "demo-notif-4", key = "security.breach_attempt", category = "security",
            recipientUid = "demo-uid",
            createdAt = "2026-05-30T08:01:00Z",
            title = "Unusual sign-in attempt",
            description = "A sign-in was blocked from an unrecognized device."),
    )

    // === template-bank / template-assignment ===
    val emailTemplates: List<TemplateRepository.EmailTemplate> = listOf(
        TemplateRepository.EmailTemplate(templateId = "onboarding.welcome",
            subject = "Welcome to TribeTails, {{firstName}}!",
            body = "Hi {{firstName}}, we are so glad your household joined the tribe. Here is what to expect next.",
            html = null, title = "Welcome email",
            description = "Sent the moment a new kinfolk household is onboarded.",
            tags = listOf("welcome", "onboarding"), category = "Onboarding"),
        TemplateRepository.EmailTemplate(templateId = "booking-confirm-v2",
            subject = "Your visit is confirmed",
            body = "Hi {{firstName}}, your {{serviceType}} on {{date}} is confirmed. We can't wait to see the gang!",
            html = null, title = "Booking Confirmation",
            description = "Confirmation sent after a booking is accepted.",
            tags = listOf("booking"), category = "Bookings"),
        TemplateRepository.EmailTemplate(templateId = "invoice.sent",
            subject = "Invoice {{invoiceNumber}} from TribeTails",
            body = "Hi {{firstName}}, your invoice for recent care is ready. Total due: {{amountDue}}.",
            html = null, title = "Invoice notice",
            description = "Accompanies a newly issued invoice.",
            tags = listOf("billing"), category = "Invoicing"),
        TemplateRepository.EmailTemplate(templateId = "reengage.checkin",
            subject = "We miss {{petName}}!",
            body = "Hi {{firstName}}, it's been a while. Ready to book {{petName}}'s next adventure?",
            html = null, title = "Re-engagement check-in",
            description = "Nudge for households inactive 60+ days.",
            tags = listOf("retention"), category = "Re-engagement"),
    )

    val templateBindings: List<TemplateRepository.TemplateBinding> = listOf(
        TemplateRepository.TemplateBinding(catalogKey = "kincare.booking.confirm",
            templateId = "booking-confirm-v2", audience = "kinfolk", triggerKey = null, active = true),
        TemplateRepository.TemplateBinding(catalogKey = "onboarding.welcome",
            templateId = "onboarding.welcome", audience = "kinfolk", triggerKey = null, active = true),
        TemplateRepository.TemplateBinding(catalogKey = "billing.invoice.sent",
            templateId = "invoice.sent", audience = "auntie", triggerKey = "manual.override", active = false),
    )

    // === formschema-list ===
    val formSchemas: List<FormSchemaSummary> = listOf(
        FormSchemaSummary(id = "tribeProfile", name = "Tribe Profile", version = 3,
            updatedAt = "2026-05-30", updatedBy = "Wanda Thorne"),
        FormSchemaSummary(id = "kinIntake", name = "New Kin Intake", version = 5,
            updatedAt = "2026-05-22", updatedBy = "Auntie Admin"),
        FormSchemaSummary(id = "vetRelease", name = "Vet Release Authorization", version = 1,
            updatedAt = "2026-05-12", updatedBy = "Auntie Admin"),
        FormSchemaSummary(id = "overnightAddendum", name = "Overnight Addendum", version = 2,
            updatedAt = "2026-05-02", updatedBy = "Auntie Admin"),
    )

    // === formschema-editor ===
    val formSchema: FormSchema = FormSchema(
        id = "tribeProfile", name = "Tribe Profile", description = "Kinfolk-facing intake form",
        version = 3,
        sections = listOf(
            FormSchemaSection(title = "About the Tribe", description = "Basics we need on file",
                fields = listOf(
                    FormSchemaField(key = "householdName", label = "Household name", type = "text",
                        required = true, helperText = "As it appears on the lease", placeholder = "e.g. The Thornes"),
                    FormSchemaField(key = "primaryPhone", label = "Primary phone", type = "phone",
                        required = true, placeholder = "(555) 010-0000"),
                )),
            FormSchemaSection(title = "Pets", description = "Tell us about the kin",
                fields = listOf(
                    FormSchemaField(key = "petSize", label = "Pet size", type = "select", required = false,
                        options = listOf("Small", "Medium", "Large"), group = "pets"),
                    FormSchemaField(key = "specialNotes", label = "Special notes", type = "textarea",
                        required = false, helperText = "Anything an auntie should know"),
                )),
        ),
        createdAt = "2026-05-01", updatedAt = "2026-05-20", updatedBy = "Wanda Thorne",
    )

    // === kintale-report ===
    val kinTaleSession: KinCareSession = KinCareSession(
        id = "demo-s1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
        kinIds = listOf("k1", "k2"), serviceType = "Dog Walk",
        startTime = "2026-05-30T09:00", arrivedAt = "2026-05-30T09:02",
        departedAt = "2026-05-30T09:48", visitRouteId = "route-demo-1", status = "DEPARTED",
        gpsSummary = GpsSummary(
            distanceMeters = 1450.0, durationSeconds = 2760L,
            route = listOf(
                GpsPoint(lat = 33.97, lng = -118.42, t = 1L),
                GpsPoint(lat = 33.971, lng = -118.421, t = 2L),
                GpsPoint(lat = 33.972, lng = -118.419, t = 3L),
            )),
    )

    val kinTaleKin: List<Kin> = listOf(
        Kin(id = "k1", kinfolkId = "demo-kf-1", name = "Biscuit", species = "Dog", status = "active"),
        Kin(id = "k2", kinfolkId = "demo-kf-1", name = "Gravy", species = "Dog", status = "active"),
    )

    val kinTaleReport: KinCareReport = KinCareReport(
        id = "demo-report-1", sessionId = "demo-s1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
        kinIds = listOf("k1", "k2"), serviceType = "Dog Walk", visitDate = "2026-05-30T09:00",
        arrivedAt = "2026-05-30T09:02", departedAt = "2026-05-30T09:48", visitRouteId = "route-demo-1",
        bodyCopy = "Biscuit and Gravy had a wonderful morning walk along the river, tails wagging the whole way.",
        status = ReportStatus.DRAFT.name, mediaFileIds = listOf("m1", "m2", "m3"),
        fieldResponses = mapOf(
            "k1|fed" to FieldResponse(fieldKey = "fed", kinId = "k1", boolValue = true),
            "k2|played" to FieldResponse(fieldKey = "played", kinId = "k2", boolValue = true),
            "peed" to FieldResponse(fieldKey = "peed", kinId = "k1", boolValue = true),
        ),
        petMoodSelections = mapOf("k1" to "happy", "k2" to "playful"),
    )

    val kinTaleMedia: List<MediaFile> = listOf(
        MediaFile(id = "m1", entityId = "demo-s1", entityType = MediaEntityType.VISIT_LOG.name,
            fileType = MediaType.IMAGE, storageUrl = "https://demo/m1.jpg",
            thumbnailUrl = "https://demo/m1-thumb.jpg", description = "Biscuit on the trail"),
        MediaFile(id = "m2", entityId = "demo-s1", entityType = MediaEntityType.VISIT_LOG.name,
            fileType = MediaType.IMAGE, storageUrl = "https://demo/m2.jpg"),
        MediaFile(id = "m3", entityId = "demo-s1", entityType = MediaEntityType.VISIT_LOG.name,
            fileType = MediaType.IMAGE, storageUrl = "https://demo/m3.jpg"),
    )
}
