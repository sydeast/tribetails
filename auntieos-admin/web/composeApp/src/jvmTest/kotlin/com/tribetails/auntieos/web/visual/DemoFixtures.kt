package com.tribetails.auntieos.web.visual

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.FieldResponse
import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.FormSectionSpec
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.TrainingDocument
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.data.VoicemailLog

/**
 * Deterministic demo data for desktop screenshot tests. Mirrors the seeded
 * `_demo:true` dataset names so captures line up with the ui-ideas mockups
 * (Wanda Thorne et al.). Fixed strings only - no clocks, no randomness.
 */
object DemoFixtures {

    val kinfolk: List<Kinfolk> = listOf(
        Kinfolk(_id = "demo-kf-1", firstName = "Wanda", lastName = "Thorne",
            serviceAddress = "The Thornes, Riverside", status = "active", tags = listOf("Biscuit", "Gravy")),
        Kinfolk(_id = "demo-kf-2", firstName = "Nora", lastName = "Halbrook",
            serviceAddress = "The Halbrooks, Oak Hill", status = "active", tags = listOf("Marigold")),
        Kinfolk(_id = "demo-kf-3", firstName = "Tessa", lastName = "Brooks",
            serviceAddress = "The Brooks, Maple Grove", status = "active", tags = listOf("Pepper")),
        Kinfolk(_id = "demo-kf-4", firstName = "Priya", lastName = "Ashford",
            serviceAddress = "The Ashfords, Cedar Park", status = "active", tags = listOf("Clover", "Sage")),
        Kinfolk(_id = "demo-kf-5", firstName = "Iris", lastName = "Ellery",
            serviceAddress = "The Ellerys, Riverside", status = "active", tags = listOf("Cocoa", "Olive")),
        Kinfolk(_id = "demo-kf-6", firstName = "Fern", lastName = "Calloway",
            serviceAddress = "Meet & Greet Thu", status = "active", tags = listOf("Pip")),
    )

    private fun kin(id: String, kfId: String, name: String, species: String, breed: String) =
        Kin(_id = id, kinfolkId = kfId, name = name, species = species, breed = breed, status = "active")

    val kinByKinfolk: Map<String, List<Kin>> = mapOf(
        "demo-kf-1" to listOf(kin("k1", "demo-kf-1", "Biscuit", "Dog", "Beagle"),
                              kin("k2", "demo-kf-1", "Gravy", "Dog", "Lab")),
        "demo-kf-2" to listOf(kin("k3", "demo-kf-2", "Marigold", "Cat", "Tabby")),
        "demo-kf-3" to listOf(kin("k4", "demo-kf-3", "Pepper", "Dog", "Corgi")),
        "demo-kf-4" to listOf(kin("k5", "demo-kf-4", "Clover", "Cat", "Calico"),
                              kin("k6", "demo-kf-4", "Sage", "Cat", "Siamese")),
        "demo-kf-5" to listOf(kin("k7", "demo-kf-5", "Cocoa", "Dog", "Poodle"),
                              kin("k8", "demo-kf-5", "Olive", "Dog", "Terrier")),
        "demo-kf-6" to listOf(kin("k9", "demo-kf-6", "Pip", "Dog", "Pug")),
    )

    val allKin: List<Kin> = kinByKinfolk.values.flatten()

    val invoices: List<Invoice> = listOf(
        Invoice(_id = "demo-inv-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            invoiceNumber = "INV-1001", client = "Wanda Thorne", address = "The Thornes, Riverside",
            date = "2026-05-20", terms = "Net 15", dueDate = "2026-06-04"),
    )

    val sessions: List<KinCareSession> = listOf(
        KinCareSession(_id = "demo-s1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            serviceType = "Dog Walk", startTime = "2026-05-30T09:00", status = "COMPLETED"),
        KinCareSession(_id = "demo-s2", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            serviceType = "Drop-In Visit", startTime = "2026-05-31T14:00", status = "SCHEDULED"),
    )

    val userProfile: UserProfile = UserProfile(
        _id = "demo-admin", uid = "demo-admin", email = "admin@tribetails.com",
        displayName = "Auntie Admin", firstName = "Auntie", lastName = "Admin", title = "Owner",
    )

    // ---- Stage 2 (2026-05-31) demo fixtures for the 15 expanded desktop captures ----

    /** Richer booking list so manage-bookings shows Pending / Scheduled / History. */
    val bookingSessions: List<KinCareSession> = listOf(
        KinCareSession(_id = "demo-bk-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            serviceType = "Dog Walk", startTime = "2026-06-02T09:00", status = "PENDING",
            kinfolkNotes = "Front gate code 4421; Biscuit pulls left."),
        KinCareSession(_id = "demo-bk-2", kinfolkId = "demo-kf-4", kinfolkName = "Priya Ashford",
            serviceType = "Overnight", startTime = "2026-06-03T18:00", status = "DRAFT"),
        KinCareSession(_id = "demo-bk-3", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            serviceType = "Drop-In Visit", startTime = "2026-06-01T14:00", status = "SCHEDULED",
            notes = "Two dogs, meds at noon."),
        KinCareSession(_id = "demo-bk-4", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            serviceType = "Daycare", startTime = "2026-05-29T08:00", status = "COMPLETED"),
    )

    /** Auntie Time day-of list: one ARRIVED (active, date-independent) plus phase variants. */
    val auntieTimeSessions: List<KinCareSession> = listOf(
        KinCareSession(_id = "demo-at-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            serviceType = "Dog Walk", startTime = "2026-05-31T09:00", endTime = "2026-05-31T10:00",
            status = "ARRIVED", arrivedAt = "2026-05-31T09:05", invoiceId = "demo-inv-1",
            notes = "Side gate, leash on hook"),
        KinCareSession(_id = "demo-at-2", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            serviceType = "Drop-In Visit", startTime = "2026-05-31T14:00", status = "SCHEDULED",
            kinfolkNotes = "Text on arrival please"),
        KinCareSession(_id = "demo-at-3", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            serviceType = "Daycare", startTime = "2026-05-31T08:00", status = "COMPLETED",
            completedAt = "2026-05-31T08:45"),
    )

    /** Varied invoice list so the summary tiles + Paid/Unpaid/Draft rows all populate. */
    val variedInvoices: List<Invoice> = listOf(
        Invoice(_id = "demo-inv-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            invoiceNumber = "INV-1001", client = "Wanda Thorne", address = "The Thornes, Riverside",
            date = "2026-05-20", terms = "Net 15", dueDate = "2026-06-04",
            total = 240.0, amountDue = 240.0, status = "sent", sessionIds = listOf("demo-s1", "demo-s2")),
        Invoice(_id = "demo-inv-2", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            invoiceNumber = "INV-1002", client = "Iris Ellery", address = "The Ellerys, Riverside",
            date = "2026-05-18", terms = "Net 15", dueDate = "2026-06-02",
            total = 180.0, amountDue = 0.0, status = "paid"),
        Invoice(_id = "demo-inv-3", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            invoiceNumber = "INV-1003", client = "Nora Halbrook", address = "The Halbrooks, Oak Hill",
            date = "2026-05-22", terms = "Net 30", dueDate = "2026-06-21",
            total = 95.0, amountDue = 95.0, status = "draft"),
        Invoice(_id = "demo-inv-4", kinfolkId = "demo-kf-3", kinfolkName = "Tessa Brooks",
            invoiceNumber = "INV-1004", client = "Tessa Brooks", address = "The Brooks, Maple Grove",
            date = "2026-05-10", terms = "Net 15", dueDate = "2026-05-25",
            total = 320.0, amountDue = 320.0, status = "sent"),
    )

    /** Varied payments so the method chips + tips + sort-by-date all read. */
    val payments: List<Payment> = listOf(
        Payment(_id = "demo-pay-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            client = "Wanda Thorne", date = "2026-05-28", paymentMethod = "CASH",
            tip = 5.0, amount = 60.0, notes = "Two dogs, midday walk"),
        Payment(_id = "demo-pay-2", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            client = "Nora Halbrook", date = "2026-05-27", paymentMethod = "CHECK",
            referenceNumber = "CHK-1042", amount = 120.0, notes = "Weekly daycare"),
        Payment(_id = "demo-pay-3", kinfolkId = "demo-kf-3", kinfolkName = "Tessa Brooks",
            client = "Tessa Brooks", date = "2026-05-25", paymentMethod = "CARD",
            referenceNumber = "AUTH-88231", tip = 10.0, amount = 240.0),
        Payment(_id = "demo-pay-4", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            client = "Iris Ellery", date = "2026-05-24", paymentMethod = "TRANSFER",
            amount = 90.0, notes = "Overnight stay"),
    )

    /** Inbox: voicemails. */
    val voicemails: List<VoicemailLog> = listOf(
        VoicemailLog(_id = "demo-vm-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            callerNumber = "+15035550148",
            transcript = "Hi Auntie, calling to confirm Biscuit's drop-in tomorrow afternoon, thanks!",
            audioUrl = "https://example.com/vm/demo-vm-1.mp3", durationSec = 34,
            direction = "inbound", timestamp = "2026-05-30T15:42:00", replyStatus = "unread"),
    )

    /** Inbox: call logs. */
    val calls: List<CallLog> = listOf(
        CallLog(_id = "demo-call-1", kinfolkId = "demo-kf-5", kinfolkName = "Iris Ellery",
            counterpartNumber = "+15035550193", direction = "inbound", status = "missed",
            transcript = "", recordingUrl = "", durationSec = 0, timestamp = "2026-05-30T11:08:00"),
    )

    /** Inbox: SMS/MMS. */
    val sms: List<SmsMessage> = listOf(
        SmsMessage(_id = "demo-sms-1", kinfolkId = "demo-kf-1", kinfolkName = "Wanda Thorne",
            counterpartNumber = "+15035550148", direction = "inbound", subType = "sms",
            body = "Running 10 min late for pickup, sorry!", mediaUrls = emptyList(),
            timestamp = "2026-05-30T09:15:00"),
    )

    /** Inbox: emails. */
    val emails: List<EmailMessage> = listOf(
        EmailMessage(_id = "demo-email-1", kinfolkId = "demo-kf-2", kinfolkName = "Nora Halbrook",
            fromAddress = "nora@example.com", toAddresses = listOf("hello@tribetails.com"),
            subject = "Vaccination records for Pepper",
            body = "Attaching the updated rabies certificate as requested.",
            attachmentUrls = listOf("https://example.com/att/pepper-rabies.pdf"),
            direction = "inbound", timestamp = "2026-05-29T17:03:00"),
    )

    /** Activity log: spread across action types + statuses incl one FAILURE; two days. */
    val activityLog: List<ActivityLogEntry> = listOf(
        ActivityLogEntry(_id = "demo-act-1", timestamp = "2026-05-31T14:22:00", actionType = "LOGIN",
            description = "Wanda Thorne signed in", status = "SUCCESS", actorId = "demo-kf-1"),
        ActivityLogEntry(_id = "demo-act-2", timestamp = "2026-05-31T13:05:00", actionType = "CREATE_BOOKING",
            description = "Booking created for Iris Ellery", status = "SUCCESS", actorId = "demo-admin",
            targetId = "demo-bk-3", targetCollection = "kin_care_sessions"),
        ActivityLogEntry(_id = "demo-act-3", timestamp = "2026-05-31T11:48:00", actionType = "NOTIFICATION_SENT",
            description = "Booking confirmation dispatched", status = "SUCCESS", actorId = "demo-admin",
            targetCollection = "notifications"),
        ActivityLogEntry(_id = "demo-act-4", timestamp = "2026-05-30T16:10:00", actionType = "UPDATE_SETTINGS",
            description = "Business hours updated", status = "SUCCESS", actorId = "demo-admin",
            targetCollection = "business_settings"),
        ActivityLogEntry(_id = "demo-act-5", timestamp = "2026-05-30T09:31:00", actionType = "ADMIN_TRIAGE",
            description = "Orphan report could not be assigned", status = "FAILURE", actorId = "demo-admin",
            targetId = "legacy_82", targetCollection = "kin_care_reports"),
    )

    /** Business settings for the settings screen Business Profile + Hours + Notifications panels. */
    val businessSettings: BusinessSettings = BusinessSettings(
        _id = "business_settings",
        businessName = "Tribe Tails Pet Care",
        businessEmail = "hello@tribetails.com",
        businessPhone = "555-0100",
        businessAddress = "Riverside",
        businessHours = mapOf(
            "Monday" to "09:00-17:00", "Tuesday" to "09:00-17:00", "Wednesday" to "09:00-17:00",
            "Thursday" to "09:00-17:00", "Friday" to "09:00-17:00", "Saturday" to "", "Sunday" to "",
        ),
        notificationEmail = true, notificationSms = true, notificationPush = false,
        observedUsHolidays = listOf("new_years", "thanksgiving", "christmas"),
        companyHolidays = listOf("2026-07-04|Founder's Day"),
    )

    /** Training documents across communication types so the summary stats read 3/3. */
    val trainingDocs: List<TrainingDocument> = listOf(
        TrainingDocument(_id = "demo-td-1", title = "Administering Oral Medication",
            communicationType = "How-to",
            content = "Always confirm the dosage on the prescription label before each visit. " +
                "Wrap the pill in a soft treat or pill pocket, then offer it by hand. Watch the " +
                "swallow and follow with water. If the kin spits it out twice, stop and text the " +
                "household before trying again. Never crush extended-release tablets.",
            kinfolkRef = "Wanda Thorne", uploadedAt = "2026-05-10",
            notes = "Confirm dosage with the vet office before each visit."),
        TrainingDocument(_id = "demo-td-2", title = "Severe Weather Policy",
            communicationType = "Policy",
            content = "When the county issues a heat advisory above 90 degrees, shorten walks to " +
                "15 minutes and stick to shaded routes. Carry water on every walk. In a lightning " +
                "warning, skip the walk entirely and do an indoor enrichment visit instead, then log " +
                "the change in the visit notes so the household understands the shortened time.",
            kinfolkRef = "", uploadedAt = "2026-05-08",
            notes = "Review before summer season."),
        TrainingDocument(_id = "demo-td-3", title = "New Auntie Onboarding Walkthrough",
            communicationType = "Training",
            content = "Day one: shadow a senior auntie for two full routes. Learn the lockbox and " +
                "gate-code conventions, how to log arrival and departure, and how to write a KinTale " +
                "that reads warm but factual. By the end of week one you should be comfortable running " +
                "a solo drop-in and sending the recap home without supervision.",
            kinfolkRef = "", uploadedAt = "2026-05-05",
            notes = ""),
    )

    /** Notifications: mix of pending + dispatched across categories and two days. */
    val notifications: List<NotificationEntry> = listOf(
        NotificationEntry(_id = "demo-notif-1", key = "kincare.booking.requested", category = "bookings",
            recipientUid = "demo-uid", actorUid = "demo-kf-2", status = "pending", mode = "trigger",
            channels = listOf("push", "in_app"), createdAt = "2026-05-31T14:02:11Z"),
        NotificationEntry(_id = "demo-notif-2", key = "payment.received", category = "payments",
            recipientUid = "demo-uid", actorUid = "demo-kf-1", status = "dispatched", mode = "trigger",
            channels = listOf("email"), createdAt = "2026-05-31T10:18:00Z"),
        NotificationEntry(_id = "demo-notif-3", key = "kintale.comment.added", category = "kintales",
            recipientUid = "demo-uid", actorUid = "demo-kf-3", status = "dispatched", mode = "debounced",
            channels = listOf("push", "in_app"), createdAt = "2026-05-30T19:41:00Z"),
        NotificationEntry(_id = "demo-notif-4", key = "security.breach_attempt", category = "security",
            recipientUid = "demo-uid", actorUid = null, status = "pending", mode = "trigger",
            channels = listOf("email", "push"), createdAt = "2026-05-30T08:05:00Z"),
    )

    /** KinTale logs buckets: Sent / Drafts / Needs-another-look + one untriaged orphan. */
    val kinTaleLogReports: List<KinCareReport> = listOf(
        KinCareReport(_id = "demo-rpt-1", sessionId = "demo-sess-1", kinfolkId = "demo-kf-1",
            kinfolkName = "Wanda Thorne", serviceType = "Drop-In Visit", visitDate = "2026-05-20T14:30:00",
            bodyCopy = "Biscuit and Gravy were thrilled to see me. Both ate well and got a good play session.",
            mediaFileIds = listOf("m1", "m2"), status = "SENT", sentAt = "2026-05-20T15:10:00",
            sentVia = "sms", createdAt = "2026-05-20T14:00:00"),
        KinCareReport(_id = "demo-rpt-2", sessionId = "demo-sess-2", kinfolkId = "demo-kf-2",
            kinfolkName = "Nora Halbrook", serviceType = "Dog Walk", visitDate = "2026-05-21T09:00:00",
            bodyCopy = "Marigold had a calm morning walk and met a friendly neighbor cat.",
            status = "DRAFT", createdAt = "2026-05-21T08:30:00"),
        KinCareReport(_id = "demo-rpt-3", sessionId = "demo-sess-3", kinfolkId = "demo-kf-3",
            kinfolkName = "Tessa Brooks", serviceType = "Overnight", visitDate = "2026-05-19T20:00:00",
            bodyCopy = "Pepper settled in for the night after a long evening play.",
            status = "FAILED", sentVia = "email", createdAt = "2026-05-19T19:00:00"),
        KinCareReport(_id = "legacy_82", kinfolkId = "", kinfolkName = "", serviceType = "",
            visitDate = "2026-05-10T11:00:00", bodyCopy = "Walked the dog around the block, all good.",
            status = "DRAFT", sentVia = "legacy_visit_logs", triageStatus = "",
            createdAt = "2026-05-10T11:00:00"),
    )

    /** KinTale report detail: ONE SENT report keyed to sessionId "demo-sess-1". */
    val kinTaleReports: List<KinCareReport> = listOf(
        KinCareReport(_id = "demo-report-1", sessionId = "demo-sess-1", kinfolkId = "demo-kf-1",
            kinfolkName = "Wanda Thorne", authorDisplayName = "Auntie Admin",
            kinIds = listOf("k1", "k2"), serviceType = "Dog Walk", visitDate = "2026-05-30",
            arrivedAt = "09:02", departedAt = "09:48", visitRouteId = "route-demo-1",
            bodyCopy = "Biscuit and Gravy had a wonderful morning walk along the river. Lots of tail " +
                "wags, two new dog friends, and a thorough sniff of every mailbox on the block.",
            status = "SENT", sentAt = "2026-05-30T09:50", sentVia = "email",
            deliveryReceiptId = "rcpt-demo-1", mediaFileIds = listOf("m1", "m2", "m3"),
            fieldResponses = mapOf(
                "k1|fed" to FieldResponse(fieldKey = "fed", kinId = "k1", boolValue = true),
                "k1|water" to FieldResponse(fieldKey = "water", kinId = "k1", boolValue = true),
                "k2|play" to FieldResponse(fieldKey = "play", kinId = "k2", boolValue = true),
                "secure" to FieldResponse(fieldKey = "secure", kinId = "", boolValue = true),
                "locked" to FieldResponse(fieldKey = "locked", kinId = "", boolValue = true),
            )),
    )

    /** Form-schema list rows for the admin formschema-list capture. */
    val formSchemas: List<FormSchemaSummary> = listOf(
        FormSchemaSummary(id = "demo-fs-1", name = "New Kinfolk Intake", version = 3,
            updatedAt = "2026-05-30", updatedBy = "Wanda Thorne"),
        FormSchemaSummary(id = "tribeProfile", name = "Tribe Profile", version = 2,
            updatedAt = "2026-05-20", updatedBy = "Auntie Admin"),
        FormSchemaSummary(id = "demo-fs-3", name = "Vet Office On File", version = 1,
            updatedAt = "2026-05-12", updatedBy = "Auntie Admin"),
        FormSchemaSummary(id = "demo-fs-4", name = "Overnight Stay Checklist", version = 5,
            updatedAt = "2026-05-08", updatedBy = "Nora Halbrook"),
    )

    /** Single full FormSchema for the formschema-editor capture (incl one select field). */
    val formSchema: FormSchema = FormSchema(
        id = "tribeProfile", name = "Tribe Profile", description = "Kinfolk-facing intake form",
        version = 3,
        sections = listOf(
            FormSectionSpec(title = "About the Tribe", description = "Basics we need on file",
                fields = listOf(
                    FormFieldSpec(key = "householdName", label = "Household name", type = "text",
                        required = true, helperText = "As it appears on the lease",
                        placeholder = "e.g. The Thornes"),
                    FormFieldSpec(key = "petSize", label = "Pet size", type = "select",
                        required = false, options = listOf("Small", "Medium", "Large"), group = "pets"),
                    FormFieldSpec(key = "primaryPhone", label = "Primary phone", type = "phone",
                        required = true, placeholder = "(555) 555-0100"),
                )),
            FormSectionSpec(title = "Access & Notes", description = "How we get in and stay safe",
                fields = listOf(
                    FormFieldSpec(key = "gateCode", label = "Gate or lockbox code", type = "text",
                        required = false, helperText = "Leave blank if none"),
                    FormFieldSpec(key = "specialNotes", label = "Anything else", type = "textarea",
                        required = false, placeholder = "Quirks, hazards, routines..."),
                )),
        ),
        createdAt = "2026-05-01", updatedAt = "2026-05-20", updatedBy = "Wanda Thorne",
    )

    // Raw callable-response JSON for the callable-only template screens (desktop seam).
    // Shape matches what TemplateService.listTemplates()/listBindings() decode.
    val templatesJson: String = """
        {"templates":[
          {"templateId":"onboarding.welcome","subject":"Welcome to TribeTails, {{firstName}}!","body":"Hi {{firstName}}, we are so glad your household joined the tribe. Expect play-by-play visit notes and the occasional very good photo.","html":null,"title":"Welcome email","description":"Sent when a new kinfolk household is onboarded.","tags":["welcome","onboarding"],"category":"Onboarding"},
          {"templateId":"booking.confirm","subject":"Your visit is confirmed","body":"We have your visit booked and on the calendar. See you and the crew soon!","title":"Booking Confirmation","tags":["booking","kincare"],"category":"KinCare"},
          {"templateId":"invoice.sent","subject":"Your invoice is ready","body":"Your latest invoice is attached. Thank you for trusting us with your tribe.","title":"Invoice Ready","tags":["billing"],"category":"Invoicing"},
          {"templateId":"reengage.miss_you","subject":"We miss your pets!","body":"It has been a little while since the last visit. Book your next one whenever you are ready.","title":"Re-engagement nudge","tags":["reengage"],"category":"Re-engagement"}
        ]}
    """.trimIndent()

    // Server-deduped category list the listCategories callable returns for the
    // templatesJson fixture above (sorted case-insensitively).
    val categoriesJson: String = """
        {"categories":["Invoicing","KinCare","Onboarding","Re-engagement"],"schemaVersion":1}
    """.trimIndent()

    val templateBindingsJson: String = """
        {"bindings":[
          {"catalogKey":"kincare.booking.confirm","templateId":"booking.confirm","audience":"kinfolk","triggerKey":null,"active":true},
          {"catalogKey":"invoice.sent","templateId":"invoice.sent","audience":"kinfolk","triggerKey":null,"active":true},
          {"catalogKey":"kincare.booking.requested","templateId":"onboarding.welcome","audience":"auntie","triggerKey":"manual.override","active":false}
        ]}
    """.trimIndent()
}
