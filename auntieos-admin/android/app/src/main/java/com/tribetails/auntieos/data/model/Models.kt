package com.tribetails.auntieos.data.model

import androidx.annotation.Keep
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.PropertyName
import com.google.gson.annotations.SerializedName

@Keep
data class BaserowFile(
    val url: String = "",
    val name: String = "",
    val size: Int = 0,
    @get:PropertyName("mime_type") @set:PropertyName("mime_type") var mimeType: String = "",
    @get:PropertyName("is_image") @set:PropertyName("is_image") var isImage: Boolean = false
)

// --- Tags (2026-07-19 Tags port) ---
//
// The tag vocabularies live on `business_settings/business_settings`
// (householdTags / petTags); an ASSIGNMENT on a profile is just the tag NAME, a
// flat string list under `tags` on kinfolk/{id} and kin/{id}. A name is resolved
// back to its color/icon against the relevant vocabulary at render time, so a
// name with no matching vocab entry renders a neutral chip rather than an error.
// Wire shapes are byte-identical to the React admin (auntieos-admin
// src/lib/tags/model.ts + src/api/settings.ts), which is the authoring surface.
//
// #713: deleting a tag is a CASCADE, not a list edit. The `removeBusinessTag`
// callable drops the vocabulary row AND strips the name off every kinfolk (or
// kin) doc carrying it, so a deleted tag no longer lives on as a neutral chip.
// The neutral chip now covers a free-form name a profile assigned without
// promoting it, and legacy docs written before the cascade existed.

/**
 * A tag palette entry as persisted: the stable [token] plus the [css] paint
 * string React uses (e.g. "var(--color-accent)").
 *
 * Kotlin has no CSS variables and paints a chip from its own brand palette by
 * [token], but it MUST carry [css] back to Firestore unchanged. React paints
 * from `color.css` directly, so dropping it (or substituting a hex) leaves the
 * admin unable to render its own chips.
 */
@Keep
data class TagColor(
    var token: String = "",
    var css: String = "",
)

/**
 * A tag vocabulary entry. [name] is the key assignments reference; [icon] is a
 * plain emoji string where "" means no icon, never null (React drops any row
 * whose icon is not a string, so a null would silently vanish there).
 */
@Keep
data class TagDef(
    var name: String = "",
    var color: TagColor = TagColor(),
    var icon: String = "",
)

/**
 * Decode a raw `householdTags`/`petTags` array into clean [TagDef]s, keeping
 * only well-formed `{ name, color: { token, css }, icon }` rows and dropping
 * anything malformed (a hand-edited doc, a half-written row, a legacy shape).
 * Never throws: a bad vocabulary must never take down the whole settings read.
 * Drop rules are a one-for-one port of decodeTagDefs in
 * auntieos-admin src/api/settings.ts, including keeping [TagDef.name] untrimmed.
 */
fun decodeTagDefs(raw: Any?): List<TagDef> {
    val rows = raw as? List<*> ?: return emptyList()
    val out = ArrayList<TagDef>(rows.size)
    for (row in rows) {
        val r = row as? Map<*, *> ?: continue
        val name = r["name"] as? String ?: continue
        if (name.trim().isEmpty()) continue
        val icon = r["icon"] as? String ?: continue
        val color = r["color"] as? Map<*, *> ?: continue
        val token = color["token"] as? String ?: continue
        val css = color["css"] as? String ?: continue
        out.add(TagDef(name = name, color = TagColor(token = token, css = css), icon = icon))
    }
    return out
}

/**
 * Encode a vocabulary back to the Firestore wire shape. [TagColor.css] goes out
 * exactly as it came in (Kotlin never invents or rewrites a css value), so a
 * save from android leaves the React admin painting the same chips.
 */
fun encodeTagDefs(defs: List<TagDef>): List<Map<String, Any>> = defs.map { def ->
    mapOf(
        "name" to def.name,
        "color" to mapOf("token" to def.color.token, "css" to def.color.css),
        "icon" to def.icon,
    )
}

// --- MyTribe portal Home layout (issue #397 M10) ---
//
// `business_settings.mytribePortal.home.sections`: the operator-editable order
// of the kinfolk portal's Home screen. Mirrors `HomeSectionCfg` (React admin
// `src/api/settings.ts`) and `PortalHomeSection` (mytribe/functions/src/portal/
// getMyHome.ts). `limit` 0 means unlimited. This client models ONLY this one
// sub-field of `mytribePortal` (not `logoUrl`/`themeId`/`banner`/`chat`, which
// have no editor here); [BusinessSettings.mytribePortal] is held raw (the same
// Class A posture as [householdTags]/[petTags] above) so a save from here can
// patch `home.sections` without knowing about, or disturbing, the sibling
// fields the React admin owns.

/**
 * A single Home section config: `{ id, enabled, limit }`. Order is the array
 * order — this IS the persisted layout, not a display hint.
 */
@Keep
data class PortalHomeSection(
    var id: String = "",
    var enabled: Boolean = true,
    var limit: Int = 0,
)

/**
 * Decode `mytribePortal.home.sections` from the raw `mytribePortal` value held
 * on [BusinessSettings.mytribePortal]. Same Class A posture as [decodeTagDefs]:
 * a malformed or missing row is dropped, never thrown, because a hand-edited
 * doc must never blank the whole Settings read. Row order is preserved.
 */
fun decodeHomeSections(raw: Any?): List<PortalHomeSection> {
    val portal = raw as? Map<*, *> ?: return emptyList()
    val home = portal["home"] as? Map<*, *> ?: return emptyList()
    val rows = home["sections"] as? List<*> ?: return emptyList()
    val out = ArrayList<PortalHomeSection>(rows.size)
    for (row in rows) {
        val r = row as? Map<*, *> ?: continue
        val id = r["id"] as? String ?: ""
        val enabled = r["enabled"] as? Boolean ?: true
        val limit = (r["limit"] as? Number)?.toInt() ?: 0
        out.add(PortalHomeSection(id = id, enabled = enabled, limit = limit))
    }
    return out
}

/**
 * Encode a Home layout back onto a raw `mytribePortal` map, replacing ONLY the
 * `home.sections` key. Every other key already on [raw] — `logoUrl`,
 * `logoRemovedAt`, `themeId`, `banner`, `chat` — survives unread and unchanged.
 *
 * THIS IS THE DIFF-NOT-REBUILD GUARD for this field: android does not model
 * those sibling keys, so a naive `mapOf("home" to ...)` return value would be a
 * save that silently wipes them the moment `SetOptions.merge()` writes this
 * field's whole value (merge protects fields OUTSIDE this map, not the ones
 * INSIDE it — see `BusinessSettingsDiff.kt`'s file header). Copying [raw]
 * forward first, key for key, is what keeps this a patch of one sub-field
 * rather than a rebuild of the object around it.
 */
fun encodeHomeSections(raw: Any?, sections: List<PortalHomeSection>): Map<String, Any?> {
    val portal = LinkedHashMap<String, Any?>()
    (raw as? Map<*, *>)?.forEach { (k, v) -> if (k is String) portal[k] = v }
    val home = LinkedHashMap<String, Any?>()
    (portal["home"] as? Map<*, *>)?.forEach { (k, v) -> if (k is String) home[k] = v }
    home["sections"] = sections.map { mapOf("id" to it.id, "enabled" to it.enabled, "limit" to it.limit) }
    portal["home"] = home
    return portal
}

/**
 * Decode a profile's `tags` field: keep only the String entries, drop everything
 * else, default empty. Mirrors kinfolkProfile.ts / kinView.ts. Deliberately
 * permissive on the raw type: a single Boolean inside the array would otherwise
 * fail CustomClassMapper's String conversion and blank the ENTIRE query, not
 * just the one doc.
 */
fun decodeTagNames(raw: Any?): List<String> =
    (raw as? List<*>)?.filterIsInstance<String>() ?: emptyList()

// --- Primary CRM Models (Spec-Complete) ---

@Keep
data class Kinfolk(
    @DocumentId val id: String = "",
    var firstName: String = "",
    var lastName: String = "",
    var phoneNumber: String = "",
    var email: String = "",
    var profilePictureUrl: String = "",
    var status: String = "active", // active, inactive, prospect, archived
    var outstandingBalance: String = "0.00",
    // The last-changed stamp. `updateKinfolkFields` writes it as a
    // serverTimestamp on every save and never round-trips what was read, so this
    // is a READ-ONLY view of it. Live on 8 of 12 kinfolk. Held raw for the same
    // reason as Kin.updatedAt, even though kinfolk currently stores it as a
    // String and kin stores it as a Timestamp; read via updatedAtIso().
    var updatedAt: Any? = null,
    // Household tag assignments: a flat list of tag NAMES resolved against
    // BusinessSettings.householdTagDefs() at render time. Held raw (Class A
    // pattern, same as KinCareSession.createdAt) because the field is absent on
    // every doc predating the Tags feature and is written by the React admin: a
    // typed `List<String>` would throw on a stored null (non-null setter
    // intrinsic) and on a Boolean element (String conversion), either of which
    // blanks the whole kinfolk query. Read via [tagNames]; write via
    // `copy(tags = listOf(...))`, which still type-checks.
    var tags: Any? = null,

    // Contact & Identity
    var secondaryPhone: String = "",
    var secondaryEmail: String = "",
    var preferredContactMethod: String = "Text",
    var bestTimeToContact: String = "",

    // Home & Access
    var serviceAddress: String = "",
    var gateCode: String = "",
    var parkingInstructions: String = "",
    var entryNotes: String = "",
    var wifiName: String = "",
    var wifiPassword: String = "",

    // Emergency Contacts. The flat triple is legacy and now READ-ONLY: kept so
    // an older doc still decodes, never written by this client again.
    var emergencyContactName: String = "",
    var emergencyContactPhone: String = "",
    var emergencyContactRelation: String = "",
    // #829. The ordered array written ONLY by the saveEmergencyContacts callable.
    // Held raw (Class A pattern, same as `tags`): a list of maps holding
    // Timestamps, absent on every doc until the migration. Read via
    // `emergencyContactsOf`. Never diffed (see KINFOLK_SERVER_OWNED).
    var emergencyContacts: Any? = null,

    // NO VET FIELDS. The household vet lives on `household_data`, catalog-linked
    // by clinic id (operator ruling 2026-08-01: "vet info lives on household
    // data, it can be seen on the kin profile"; page-specs 04 item 3).
    //
    // Removing them from this data class is what closes the WRITE path: the
    // CREATE writer here (createKinfolkComplete) serialises the whole object,
    // so a field this class does not declare is never written. Edits go
    // through `updateKinfolkFields`, which writes only the
    // field names `KINFOLK_DIFF_FIELDS` lists, and the vet is not among them.
    //
    // It does NOT clear what is already stored: those writes use
    // SetOptions.merge(), so an undeclared field survives on existing docs. The
    // A2 migration deletes them explicitly with FieldValue.delete(); an omission
    // here would leave a populated second copy that still looks authoritative.

    // Admin & Relationship
    var internalNotes: String = "",
    var referralSource: String = "",
    var joinDate: String = "",

    // Firebase auth uid for the Kinfolk-side MyTribe app install. Populated when
    // the kinfolk onboards in MyTribe (app links its anon/phone-auth uid to this
    // doc by phone match). Used by the Send Message workflow to resolve
    // kinfolk_id -> uid -> fcm_tokens/{uid} for FCM push.
    // Blank = MyTribe not installed yet; FCM channel must fail-loud for this kinfolk.
    var uid: String = "",

    // Time-bounded contact override - set by the reconcile pipeline when a comm
    // tells us "reach me a different way for now". When non-null AND within the
    // window, notification settings and any compose UI MUST prefer
    // [contactOverride.channel] over [preferredContactMethod]. The override
    // expires naturally when [effectiveUntil] passes; reconcile may also clear it.
    var contactOverride: ContactOverride? = null,

    // Archive metadata. Set when status="archived" via AuntieRepository.archiveKinfolk;
    // cleared on unarchive. Mirrors web KinfolkEditScreen ArchiveBlock semantics.
    var archivedAt: String = "",
    var archivedReason: String = "",
    var archivedBy: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on KINFOLK
    // (appliesTo == "KINFOLK"), keyed by field id. Mirrors Kin.formValues.
    var formValues: Map<String, String> = emptyMap(),
) {
    val displayName: String get() = "$firstName $lastName".trim().ifBlank { "Unnamed Kinfolk" }
    val isArchived: Boolean get() = status.equals("archived", ignoreCase = true)

    /** The assigned household tag NAMES, junk entries dropped. Never throws. */
    fun tagNames(): List<String> = decodeTagNames(tags)
}

/**
 * A short-lived override on a Kinfolk's preferred contact method, written by
 * the comms reconcile pipeline when a message contains "reach me a different
 * way" intent (e.g. "I'll only be available by text this week").
 *
 * The default [preferredContactMethod] on [Kinfolk] is unchanged - this just
 * supersedes it temporarily, with full provenance back to the source message.
 */
@Keep
data class ContactOverride(
    var channel: String = "",            // text, email, phone, none
    var effectiveFrom: String = "",      // ISO-8601 (inclusive)
    var effectiveUntil: String = "",     // ISO-8601 (inclusive); blank = open-ended
    var note: String = "",               // free-text reason, e.g. "on vacation, text only"
    var sourceLogType: String = "",      // sms | email | voicemail | call
    var sourceLogId: String = "",        // the log doc id that produced this override
    var setAt: String = "",              // when the reconcile step wrote it
)

@Keep
data class Dossier(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var communicationStyle: String = "",
    var householdNotes: String = "",
    var relationshipWithAuntie: String = "",
    var importantLifeContext: String = "",
    var preferredContactMethod: String = "",
    var rawSummary: String = "",   // narrative prose - see ANNOTATION_CONVENTIONS below
    var tldr: String = "",         // AI-generated 1-2 sentence summary; blank until reconcile writes it
    var media: List<BaserowFile> = emptyList(),

    // Reconciliation provenance - set every time the comms pipeline merges a new
    // fact into [rawSummary] or any structured field above.
    var lastReconciledAt: String = "",
    var lastReconcileSourceLogIds: List<String> = emptyList(),  // most recent first
    var needsMoreSamples: Boolean = false,
)

/**
 * The household's own reconciled record (issue #461), the peer of [Dossier] (one
 * human) and [Kin411] (one animal).
 *
 * Operator ruling 2026-08-18: "kinfolk data go to kinfolks dossiers, kin data
 * goes into the kins 411s. and then household gets its own bank." The nightly
 * pipeline writes it at `household_bank/{householdId}`, where the household id
 * is the anchoring kinfolk id, and the five structured fields below are
 * deliberately DISJOINT from the dossier's and the 411's: a fact about a person
 * or a pet has its own home and must not land here wearing a field name that
 * looks right.
 *
 * ADMIN-ONLY, the same standing ruling that governs the other two. Kinfolk never
 * see it.
 *
 * Every property is `var` with a default, the Firestore `toObject` requirement
 * the two peers already satisfy.
 */
@Keep
data class HouseholdBank(
    @DocumentId val id: String = "",
    var householdId: String = "",
    var accessAndEntry: String = "",
    var propertyNotes: String = "",
    var householdRoutine: String = "",
    var standingInstructions: String = "",
    var schedulingNotes: String = "",
    var rawSummary: String = "",   // narrative prose - same annotation conventions as Dossier
    var tldr: String = "",         // AI-generated 1-2 sentence summary; blank until reconcile writes it

    // Reconciliation provenance - set every time the comms pipeline merges a new
    // fact into [rawSummary] or any structured field above.
    var lastUpdated: String = "",
    var lastReconciledAt: String = "",
    var lastReconcileSourceLogIds: List<String> = emptyList(),  // most recent first
    var needsMoreSamples: Boolean = false,
)

@Keep
data class Kin(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var name: String = "",
    var species: String = "Dog",
    var breed: String = "",
    var age: String = "",
    var sex: String = "",
    var weight: String = "",
    var photos: List<BaserowFile> = emptyList(),
    var status: String = "active",
    var profilePictureUrl: String = "",   // Kin (pet) photo; parity with web Kin.profilePictureUrl

    // Both are DERIVED, never edited here. `updateKinFields` re-stamps
    // familyKinPath from the kin and kinfolk ids on every save and writes
    // updatedAt as a serverTimestamp, so these two are a read-only view.
    // familyKinPath is set on 24 of 24 live kin; updatedAt on 23, as a Firestore
    // Timestamp, so it is held raw and read via updatedAtIso() (same pattern as
    // KinCareSession.updatedAt) rather than typed String.
    var familyKinPath: String = "",
    var updatedAt: Any? = null,

    // Extended fields from migration data
    var colorMarkings: String = "",
    var spayedNeutered: Boolean = false,
    var staysAs: String = "",
    var routine: String = "",
    var trainingCommands: String = "",
    var feedingBrand: String = "",
    var vaccinations: String = "",
    var medicationHealthNotes: String = "",
    var vetInfo: String = "",
    var checklist: String = "",
    var reactive: Boolean = false,
    var officeNotes: String = "",
    // Structured per-kin values for dynamic KIN form_schemas (appliesTo=KIN), e.g. the
    // precare checklist (spec 06 item 5 / 1C). Keyed by FormSchemaField.key. Supersedes
    // the free-text [checklist] blob, which is kept read-only (no data loss).
    var formValues: Map<String, String> = emptyMap(),
    // Pet tag assignments: a flat list of tag NAMES resolved against
    // BusinessSettings.petTagDefs() at render time. MANDATORY, not cosmetic:
    // the android save used to write the WHOLE object with .set(kin), so without
    // this field every kin save wiped the `tags` the React admin had written.
    // DECLARING IT WAS ONLY HALF THE FIX - `buildKinFromEditState` rebuilt the
    // model from form state and never populated this field, so null went on
    // being written anyway. The edited model is copied from the loaded record
    // now, and `updateKinFields` writes only what changed. Held raw for the same
    // reason as Kinfolk.tags above (absent on legacy docs, and one bad element
    // must not blank the whole kin query).
    // Read via [tagNames]; write via `copy(tags = listOf(...))`.
    var tags: Any? = null,
) {
    /** The assigned pet tag NAMES, junk entries dropped. Never throws. */
    fun tagNames(): List<String> = decodeTagNames(tags)
}

@Keep
data class Kin411(
    @DocumentId val id: String = "",
    var kinId: String = "",
    var breed: String = "",
    var personality: String = "",
    var quirksAndPreferences: String = "",
    var medicalNotes: String = "",
    var dietaryDetails: String = "",
    var rawSummary: String = "",   // narrative prose - see ANNOTATION_CONVENTIONS below
    var tldr: String = "",         // AI-generated 1-2 sentence summary; blank until reconcile writes it
    var gallery: List<BaserowFile> = emptyList(),

    // Repaired for UI. Nullable: legacy/optional 411 docs store these as null;
    // a non-null String setter throws under toObject() (Class B decode crash).
    var vetName: String? = "",
    var vetPhone: String? = "",
    var feedingAmount: String? = "",
    var feedingFrequency: String? = "",
    var pottyRoutine: String? = "",
    var reactive: Boolean = false,

    // Reconciliation provenance - see Dossier for shape semantics.
    var lastReconciledAt: String = "",
    var lastReconcileSourceLogIds: List<String> = emptyList(),
    var needsMoreSamples: Boolean = false,
)

/**
 * ANNOTATION_CONVENTIONS - patterns the comms reconcile pipeline writes inside
 * [Dossier.rawSummary] and [Kin411.rawSummary] so the prose stays warm + human
 * but full provenance is preserved.
 *
 *  - `[[source: <channel> on {{date}}]]`  - citation for any fact carried forward
 *      e.g. `loves gummy bears [[source: Meet & Greet]]`
 *
 *  - `{{messageReceiveDate&Time, messageID}}`  - date-stamp on a fact that
 *      *supersedes* an earlier one. The earlier statement should be kept as
 *      historical context, not deleted.
 *      e.g. `Doesn't need to be crated at night anymore starting
 *           {{2026-04-26T14:30Z, sms_3f9a1b}}.`
 *
 *  - `||CREATE TASK|| <imperative>`  - a placeholder for the far-future Task
 *      feature. The reconcile step lays these down when a comm implies a
 *      follow-up; nothing acts on them yet, but they're greppable.
 *      e.g. `||CREATE TASK|| Follow up if Dougie stopped peeing on the rug`
 */
object DossierAnnotations {
    const val CITATION_OPEN     = "[[source:"
    const val CITATION_CLOSE    = "]]"
    const val SUPERSEDE_OPEN    = "{{"
    const val SUPERSEDE_CLOSE   = "}}"
    const val TASK_MARKER       = "||CREATE TASK||"
}

// --- New Admin & Business Data Models ---

@Keep
data class Invoice(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var invoiceNumber: String = "",
    var client: String = "",
    var address: String = "",
    var date: String = "",
    var terms: String = "",
    var dueDate: String = "",
    var discount: String = "",
    var total: Double = 0.0,
    // Nullable: legacy invoices store paymentsHistory as null (Class B decode crash).
    var paymentsHistory: String? = "",
    var amountDue: Double = 0.0,
    /**
     * What has been collected against this invoice, in INTEGER CENTS, written by
     * the `markInvoicePaid` callable and by the partial-payment repair pass.
     *
     * ABSENT on every invoice predating 2026-07-25, so it decodes to 0, and
     * [com.tribetails.auntieos.domain.invoicePartPaid] reads 0 as "no record of
     * a payment" rather than as a real zero.
     *
     * Deliberately NOT derived from `total - amountDue`: those are float
     * dollars, and on every invoice the old partial-payment write touched
     * `amountDue` reads 0.0 while a real balance is owed, so that subtraction
     * would report the whole total as collected on exactly the wrong invoices.
     */
    var paidCents: Long = 0L,
    /** Collected beyond the total, in integer cents. Non-zero only after an overpayment. */
    var overpaidCents: Long = 0L,
    /**
     * The Invoice State Classifier's stored verdict (ADR-0002): one of the
     * server's eight canonical lowercase states (`quote`, `draft`, `cancelled`,
     * `credit`, `redeemed`, `paid`, `zero`, `open`), written by every
     * money-touching callable in the same write that moves the money, and
     * backfilled onto every pre-existing doc. Decoded (never re-derived) by
     * `domain.invoiceStateOrNull`; a value outside that vocabulary renders raw
     * and offers no actions.
     */
    var status: String = "",
    /**
     * The classifier's stored edit verdict, written alongside [status]:
     * `all`, `metadataOnly`, or `none`. NULLABLE because every invoice that
     * predates the ADR-0002 backfill window could lack the field, and a
     * non-null setter that meets a null under `toObject()` blanks the whole
     * invoice query, not one row (the Class B decode crash `paymentsHistory`
     * above records). Absent decodes to "offer no edit affordances" through
     * `domain.invoiceEditScopeOf` - the fail-soft ruling, never a recompute.
     */
    var editScope: String? = null,
    /**
     * WHAT THE HOUSEHOLD SAID ABOUT A QUOTE: `accepted`, `denied`, or absent
     * (issue #385). Written by the portal's `acceptQuote` / `denyQuote`
     * callables, never by this app.
     *
     * NULLABLE, per the Class B decode rule the fields above record: absent on
     * every invoice that was never a quote, and a non-null Kotlin setter meeting
     * a null under `toObject()` blanks the whole invoice query rather than one
     * row. Read through `domain.invoiceQuoteDecision`, which verifies the value
     * rather than trusting it.
     *
     * NOT redundant with [status]. An accepted quote is stamped `open` and is
     * otherwise indistinguishable from an ordinary invoice; a DECLINED quote
     * keeps `status = "quote"` on purpose, since `cancelled` would mean the
     * operator withdrew it rather than the household turning it down.
     */
    var quoteDecision: String? = null,
    /**
     * When the household was last reminded about this invoice (ms epoch), written
     * by the `sendInvoiceReminder` callable and the daily reminder cron, never by
     * this app (#832).
     *
     * NULLABLE per the Class B decode rule above: absent on every invoice never
     * reminded, and an explicit null when a failed send released its claim. A
     * non-null setter meeting that null would blank the whole invoice query.
     * No edit screen writes an Invoice model back, so no save can wipe it; the
     * view models only ever `copy` it forward from the server's answer.
     */
    var reminderNotifiedAtMs: Long? = null,
    var viewed: String = "",
    // Attribution fields written by backfill_structural_links.py
    var sessionIds: List<String> = emptyList(),
    @get:PropertyName("_attribution") @set:PropertyName("_attribution") var attribution: String = "",
    @get:PropertyName("_attributionAt") @set:PropertyName("_attributionAt") var attributionAt: String = "",

    /**
     * Set by the `archiveInvoice` callable, cleared to NULL by `unarchiveInvoice`.
     *
     * NULLABLE `Any?`, ON PURPOSE, TWICE OVER. It is nullable because
     * `unarchiveInvoice` writes an explicit null rather than deleting the field,
     * and a non-null Kotlin setter THROWS under `toObject()` on a null value,
     * which in a batched `toObjects()` blanks the entire invoice query rather
     * than one row. That is the Class B decode crash `paymentsHistory` above
     * records. It is `Any?` rather than `Timestamp?` because only its PRESENCE
     * is ever read (see `invoiceIsArchived`), and typing it invites someone to
     * start formatting a value whose shape the server does not promise.
     */
    var archivedAt: Any? = null,
    var archivedBy: String? = null,

    /**
     * The itemization, held RAW and decoded on read through
     * `domain.decodeInvoiceLineItems`.
     *
     * This is the Class A pattern the tag vocabulary uses (`decodeTagDefs`), and
     * the reason is the same: `firestore.rules` grants `allow update: if
     * isAuntie()` over the whole invoices collection and `postInvoiceEvent`
     * merges an arbitrary payload, so this field can genuinely hold something
     * that is not a list of line items. A typed `List<InvoiceLineItem>` here
     * would make Firestore throw on such a document and take down the whole
     * invoice list with it. Raw plus a tolerant decoder drops the bad row instead.
     *
     * ABSENT IS NOT EMPTY. Null means nobody ever itemized this invoice, which
     * is every invoice created before Task 5.1; an empty list means somebody
     * itemized it as billing nothing. The server's `updateInvoice` refuses to
     * recompute an un-itemized invoice precisely on that distinction, so nothing
     * here may flatten the two.
     */
    var lineItems: Any? = null,
    var invoiceDiscountCents: Long = 0L,
    var subtotalCents: Long = 0L,
    var totalCents: Long = 0L,
    var amountDueCents: Long = 0L,

    /**
     * WHERE THE CHARGEBACK CONTEST STANDS, mirrored from Stripe's own Dispute
     * `status` by `functions/src/billing/stripeDispute.ts`: `needs_response`,
     * `under_review`, `won`, `lost`, and whatever else Stripe adds later.
     *
     * NULLABLE, and that is the Class B decode rule rather than a style choice.
     * The lifecycle write sets this field UNCONDITIONALLY, so a dispute event
     * that carried no status leaves an explicit `null` on the document, and a
     * non-null Kotlin setter meeting a null under `toObject()` throws — which in
     * a batched `toObjects()` blanks the WHOLE invoice query, not the one row.
     * Same trap `paymentsHistory` and `archivedAt` above record.
     *
     * `String?` rather than an enum for the same reason the web side types it
     * `string`: this is Stripe's vocabulary, it grows without asking, and a
     * value we cannot interpret has to survive to the screen where it is shown
     * raw. Read it through `domain.invoiceDisputeOrNull`.
     *
     * NOTHING EVER CLEARS IT — the contest did happen — so an invoice disputed
     * once carries this forever. No screen may read "non-empty" as "on fire".
     */
    var disputeStatus: String? = null,
    /**
     * WHETHER THE MONEY ACTUALLY MOVED (`withdrawn` / `reinstated`), written by
     * the funds lane. A different fact from [disputeStatus] and one that
     * routinely disagrees with it: a dispute sits at `needs_response` for weeks
     * with the balance already debited, and a `won` dispute is not reinstated at
     * the instant it closes.
     *
     * The funds lane writes this WITHOUT a status, and Stripe promises no
     * ordering between the two lanes, so a document really can hold a withdrawal
     * and no status at all.
     */
    var disputeFundsState: String? = null,
    /**
     * The DISPUTED amount in integer cents (Stripe's `Dispute.amount`).
     *
     * `Long?`, never `Long = 0L`, twice over: the webhook writes null when the
     * event carried no number, so a non-null setter would throw on decode, and a
     * zero here would claim the bank pulled nothing back.
     *
     * IT IS NOT THE DEBIT. What leaves the Stripe balance is this plus Stripe's
     * dispute fee, and the fee is not on the object, so nothing may add the two
     * together or present this as the sum that left.
     */
    var disputeAmountCents: Long? = null,
    /** Stripe's `dp_…` id, the key of the `stripeDisputes/{id}` operator record. */
    var disputeId: String? = null,
    /**
     * WHEN THE EVIDENCE IS DUE, epoch MILLISECONDS, or null for "there is none".
     *
     * The time-critical fact of the whole dispute feature: a chargeback nobody
     * answers by this moment is lost by default.
     *
     * MILLISECONDS, not seconds. `stripeDispute.ts#evidenceDueByMsOf` multiplies
     * Stripe's epoch-seconds `due_by` by 1000 before storing, matching
     * `lastEventCreatedMs`. Nothing here divides it back; read it with
     * `Instant.ofEpochMilli`.
     *
     * `Long?`, never `Long = 0L`, and that is the Class B decode rule twice
     * over. The lifecycle write sets the field unconditionally, so a dispute
     * with no deadline leaves an explicit null that a non-null setter would
     * throw on under `toObject()` — blanking the WHOLE invoice query rather
     * than the one row. And a 0 default would be the exact value Stripe uses to
     * mean "the issuing bank allows no response at all" (pinned SDK,
     * Disputes.d.ts:210), rendered as 1 January 1970.
     */
    var disputeEvidenceDueByMs: Long? = null,
    /**
     * WHY THE CARDHOLDER IS DISPUTING, Stripe's raw snake_case token.
     *
     * `String?` rather than an enum for the same reason [disputeStatus] is: the
     * SDK types `Dispute.reason` as a plain `String` (Disputes.d.ts:89), the
     * docstring's category list is prose rather than a type, and Stripe adds
     * categories on its own schedule. The webhook stores whatever arrived with
     * no allowlist, so a category this build has never heard of has to survive
     * to the screen and be shown as sent. Read it through
     * `domain.invoiceDisputeReasonGloss`.
     */
    var disputeReason: String? = null,
)

/**
 * One billed line, in integer cents. Mirrors the server's zod schema
 * (`mytribe/functions/src/admin/updateInvoice.ts`) field for field.
 *
 * There is NO stored per-line amount, deliberately. It is derived through
 * `domain.lineAmountCents`, so the lines shown and the total shown obey one rule.
 *
 * NOT decoded by Firestore directly, see `Invoice.lineItems` above; this is the
 * shape `decodeInvoiceLineItems` produces.
 */
@Keep
data class InvoiceLineItem(
    val description: String = "",
    /** Units billed. May be fractional (2.5 hours). */
    val qty: Double = 0.0,
    /** Price per unit, an INTEGER count of cents. */
    val unitCents: Long = 0L,
    /** Optional per-line reduction, integer cents. */
    val discountCents: Long = 0L,
    /**
     * The visit this line bills for, or `""` on a line somebody typed.
     *
     * A BOUND LINE, and the difference matters on every surface that renders one
     * (issue #408). A line carrying a session id is not a description that
     * happens to mention a date: its money came from the rate card by way of the
     * visit, so the way to change the money is to change the visit, and the
     * invoice follows. Every screen showing one offers the route to that visit
     * instead of a field to type over it with.
     *
     * `""` rather than null, matching this model's other string fields: an
     * absent key means nobody bound this line, which is true of every line
     * written before #408.
     */
    val sessionId: String = "",
)

@Keep
data class Payment(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var client: String = "",
    var address: String = "",
    var date: String = "",
    var paymentMethod: String = "",
    var referenceNumber: String = "",
    var email: String = "",
    /**
     * The GROSS tip: what the client actually tipped, BEFORE the processor fee.
     *
     * THE MEANING OF THIS FIELD CHANGED on 2026-08-04, which is why [tipBasis]
     * exists beside it. The previous system stored the NET tip and the migration
     * into Firestore dropped the fee, so invoice #1029 reads Amount $137.50,
     * Applied $127.50, Tip $7.29 and cannot be made to add up: $2.71 is a
     * processor fee nothing recorded. Operator ruling: "store both, and display
     * the latter. itll help with taxes": the gross tip is income and the fee is
     * a deductible expense, so a net-only record loses both numbers.
     */
    var tip: Double = 0.0,
    /**
     * The processor's cut, deducted from what the business receives. NOT part of
     * [amount]: the client paid [amount], the business banks `amount - fee`.
     */
    var fee: Double = 0.0,
    /**
     * Which convention [tip] follows: `"gross"`, `"net"`, or absent.
     *
     * ABSENT READS AS UNKNOWN, never as net. Rows in this collection were
     * written by a legacy migration, by the Stripe webhook and by this client
     * before the fee existed, so absence is not evidence of anything. See
     * `domain/PaymentMoney.kt`.
     */
    var tipBasis: String = "",
    /** The whole sum collected from the client, the gross tip included. */
    var amount: Double = 0.0,
    /** STAFF ONLY. Never rendered on a kinfolk-facing surface. */
    // Nullable per the Class B decode rule: migrated payments store `notes`
    // as an explicit null, and a non-null String setter throws under
    // toObject(), blanking the whole payments query (AUNTIEOS-ADMIN-1S).
    var notes: String? = "",
    // Confident payment->invoice link (parity with web Payment). Populated by the
    // Record-Payment-on-invoice-detail flow + match_payments_to_invoices.py.
    var invoiceId: String = "",
    var invoiceNumber: String = "",
    /**
     * "Will automatically apply any Unapplied amount to FUTURE invoices."
     *
     * When set, the server moves the leftover into the household's EXISTING
     * account credit (`families/{id}.accountBalanceCents`) and spends it on the
     * next invoice that becomes collectable.
     */
    var autoApply: Boolean = false,
    /** Ask the server to send the household the payment confirmation. Not stored. */
    var sendConfirmationEmail: Boolean = false
)

@Keep
data class VisitLog(
    @DocumentId val id: String = "",
    var journalId: String = "",
    var submitted: String = "",
    var serviceType: String = "",
    // Nullable: 8 of the 83 live visit_logs store arrival as null (Class B decode
    // crash - one null blanks the whole toObjects(VisitLog) batch).
    var arrival: String? = "",
    var departure: String = "",
    var kinfolkId: String = "",
    var auntieNotes: String = "",
    var rawStagingRef: String = ""
)

@Keep
data class TrainingDocument(
    @DocumentId val id: String = "",
    var title: String = "",
    var content: String = "",
    var communicationType: String = "",
    var kinfolkRef: String = "",
    var uploadedAt: String = "",
    var notes: String = "",
    // Phase 12 / spec 23 Tribal Intel write fields. targetType is KINFOLK or KIN.
    var targetType: String = "",
    var targetKinfolkId: String = "",
    var targetKinId: String = "",
    var attachments: List<TrainingDocAttachment> = emptyList(),
    var reconcileStatus: String = "",
    var reconcileNotes: String = ""
)

@Keep
data class TrainingDocAttachment(
    var storageUrl: String = "",
    var cloudinaryPublicId: String = "",
    var fileType: String = "",
    var mimeType: String = "",
    var fileName: String = ""
)

/**
 * Assignment fields of one MyTribe kinCare visit doc
 * (families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}). Assignment is
 * never mirrored onto kin_care_sessions, so it is read off the visit doc
 * directly. Both null on an unassigned visit.
 */
@Keep
data class KinCareAssignment(
    val assignedAuntieUid: String? = null,
    val auntieDisplayName: String? = null,
)

@Keep
data class KinCareSession(
    @DocumentId val id: String = "",
    var kinId: String = "",
    var kinfolkId: String = "",
    var kinIds: List<String> = emptyList(), // multiple kin per session (whole household)
    var kinfolkName: String = "",
    var sourceBookingId: String = "",      // FK -> enhanced_bookings/{id} when session originates from booking approval
    // MyTribe booking-envelope FK (separate from sourceBookingId, which points at enhanced_bookings).
    // When a session originates from an incoming MyTribe kinCare request, these locate the originating
    // doc at families/{kinfolkId}/bookings/{kinCareBatchId}/kinCares/{kinCareVisitId} so status +
    // lifecycle can be patched back for the kinfolk's live view. Null/blank for AuntieOS-native sessions.
    var kinCareBatchId: String? = null,    // -> families/{kinfolkId}/bookings/{batchId}
    var kinCareVisitId: String? = null,    // -> .../kinCares/{visitId}
    var invoiceId: String = "",            // FK -> invoices/{id} when session is attributed to an invoice
    var startTime: String = "",   // scheduled start (ISO)
    var endTime: String = "",     // scheduled end (ISO)
    var serviceType: String = "",
    var serviceDurationMinutes: Int = 0,
    var notes: String = "",                  // pre-visit notes (admin)
    var kinfolkNotes: String = "",           // pre-visit notes from kinfolk
    var status: String = VisitStatus.SCHEDULED.name,

    // Lifecycle timestamps (ISO). Nullable: legacy / optional docs (and some
    // MyTribe writers) store these as null. A non-null String setter throws
    // under Firestore toObject() and blanks the whole query (Class B decode
    // crash), so they are String? and every read site is null-safe.
    var onMyWayAt: String? = "",
    var arrivedAt: String? = "",
    var departedAt: String? = "",
    var completedAt: String? = "",

    // GPS
    var visitRouteId: String = "",        // FK -> visit_routes/{id}, set on Arrived
    var etaMinutesAway: Int = 0,          // value chosen for "On My Way"
    var gpsSummary: GpsSummary? = null,   // baked on DEPARTED via saveSessionGpsSummary; KinTale composer reads route for the GPS card

    // KinTales (visit reports) tracking
    var reportIds: List<String> = emptyList(),
    var sentReportCount: Int = 0,         // bumps when a KinTale is sent to kinfolk
    var autoCompleteEligible: Boolean = false, // set true when departed AND >=1 sent

    // createdAt/updatedAt hold EITHER a Firestore server Timestamp (MyTribe
    // callables write FieldValue.serverTimestamp()) OR an ISO-8601 String
    // (AuntieOS Android writes ISO). Typed Any? so toObject() tolerates both
    // shapes instead of throwing on the mixed data (Class A decode crash). Read
    // via createdAtIso()/updatedAtIso(), never as a raw String.
    var createdAt: Any? = null,
    var updatedAt: Any? = null,

    // Phase 14: answers to admin-authored form_schemas. A booking-create field
    // (appliesTo == "BOOKING") and a visit-day field (appliesTo == "SESSION") both
    // persist into this one map, keyed by field id. Mirrors the web KinCareSession.
    var formValues: Map<String, String> = emptyMap(),
)

enum class VisitStatus {
    SCHEDULED,
    ON_MY_WAY,
    ARRIVED,
    DEPARTED,
    COMPLETED,
    CANCELLED
}

/**
 * Normalize a Firestore "timestamp-ish" value to an ISO-8601 String. A field
 * written by `FieldValue.serverTimestamp()` decodes as a [com.google.firebase.Timestamp]
 * (or a [java.util.Date]); a field written by AuntieOS Android decodes as an
 * ISO String. Mirrors the web FirestoreInstantStringSerializer so both platforms
 * render the same instant.
 *  - Timestamp / Date -> ISO-8601 (e.g. 2026-06-27T17:07:24.579Z)
 *  - already-ISO String -> passed through unchanged
 *  - null / anything else -> "" (matches the model defaults)
 */
fun firestoreInstantToIso(value: Any?): String = when (value) {
    is String -> value
    is com.google.firebase.Timestamp -> value.toDate().toInstant().toString()
    is java.util.Date -> value.toInstant().toString()
    else -> ""
}

/** ISO-8601 view of [KinCareSession.createdAt] (Timestamp OR String OR null). */
fun KinCareSession.createdAtIso(): String = firestoreInstantToIso(createdAt)

/** ISO-8601 view of [KinCareSession.updatedAt] (Timestamp OR String OR null). */
fun KinCareSession.updatedAtIso(): String = firestoreInstantToIso(updatedAt)

/** ISO-8601 view of [Kin.updatedAt] (Timestamp on every live kin, but String-tolerant). */
fun Kin.updatedAtIso(): String = firestoreInstantToIso(updatedAt)

/** ISO-8601 view of [Kinfolk.updatedAt] (String on live kinfolk, but Timestamp-tolerant). */
fun Kinfolk.updatedAtIso(): String = firestoreInstantToIso(updatedAt)

/** ISO-8601 view of [VetClinic.createdAt] (Timestamp when portal-submitted, String when admin-created). */
fun VetClinic.createdAtIso(): String = firestoreInstantToIso(createdAt)

/** ISO-8601 view of [VetClinic.updatedAt] (Timestamp when portal-submitted, String when admin-created). */
fun VetClinic.updatedAtIso(): String = firestoreInstantToIso(updatedAt)

/** ISO-8601 view of [UserProfile.createdAt] (Timestamp once an avatar is set, else String). */
fun UserProfile.createdAtIso(): String = firestoreInstantToIso(createdAt)

/** ISO-8601 view of [UserProfile.updatedAt] (Timestamp once an avatar is set, else String). */
fun UserProfile.updatedAtIso(): String = firestoreInstantToIso(updatedAt)

// KinCareReport (a "KinTale") - visit recap sent to the kinfolk after a session.
// One session can have many KinTales (multi-day visits, midway updates).
@Keep
data class KinCareReport(
    @DocumentId val id: String = "",
    var sessionId: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var authorId: String = "",
    var authorDisplayName: String = "",
    var kinIds: List<String> = emptyList(),

    // Auto-prefilled from the session (so the report is self-contained)
    // Nullable per the Class B decode rule: reports created before the
    // session prefill store `serviceType` as null, and a non-null String
    // setter throws under toObject() (AUNTIEOS-ADMIN-1R).
    var serviceType: String? = "",
    var visitDate: String = "",
    // Nullable: prefilled from the session, which may be null (Class B decode crash).
    var arrivedAt: String? = "",
    var departedAt: String? = "",
    var visitRouteId: String = "",

    // Template that drives the dynamic fields. Empty = built-in default template.
    var templateId: String = "",

    // Auntie-authored cover headline. Blank means the cover falls back to the
    // "From {author} for {kinfolk}" line; never auto-filled with a derived value.
    var title: String = "",

    // Auntie's narrative
    var bodyCopy: String = "",

    // Dynamic field responses keyed by "kinId|fieldKey" (kinId blank for non-perKin fields).
    var fieldResponses: Map<String, FieldResponse> = emptyMap(),

    // Pet mood per kin (kinId -> moodOption.key from the active template).
    var petMoodSelections: Map<String, String> = emptyMap(),

    // Media: list of MediaFile IDs (uploaded via MediaUploadManager)
    var mediaFileIds: List<String> = emptyList(),

    // Draft / send lifecycle
    var status: String = ReportStatus.DRAFT.name,
    // Nullable: unsent drafts store sentAt as null (Class B decode crash).
    var sentAt: String? = "",
    var sentVia: String = "",          // "sms" / "email" / "fcm"
    var deliveryReceiptId: String = "", // n8n message id / SMS sid / etc.

    // Orphan triage state. After the May 17 migration, 7 pre-cutover visit_logs
    // were imported with empty `kinfolkId` and `sentVia="legacy_visit_logs"`
    // (formerly `legacy_orphan`). Admins triage these via the KinTale Logs
    // screen - either assigning a kinfolk, marking as a duplicate of an
    // existing canonical report, or archiving as bad data. Triaged reports
    // are filtered out of the normal Draft / Sent / Failed buckets so admins
    // see them exactly once.
    var triageStatus: String = "",           // "" | assigned | duplicate | archived_bad_data
    var triagedAt: String = "",              // ISO-8601 timestamp
    var triagedBy: String = "",              // admin uid (auth.currentUser.uid)
    var duplicateOfReportId: String = "",    // set when triageStatus == "duplicate"
    var archiveReason: String = "",          // set when triageStatus == "archived_bad_data"

    var createdAt: String = "",
    var updatedAt: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on KINTALE
    // (appliesTo == "KINTALE"), keyed by field id. DISTINCT from [fieldResponses]
    // (KinTale-template answers). Mirrors the web KinCareReport.
    var formValues: Map<String, String> = emptyMap(),
)

/**
 * True when this report is one of the post-migration orphans that has not yet
 * been triaged by an admin. Used by the KinTale Logs screen to lift the row
 * into the dedicated "Needs Triage" section and exclude it from the regular
 * Drafts / Sent / Failed buckets.
 *
 * Conditions:
 *  - `kinfolkId` is blank (we couldn't auto-link during migration)
 *  - `triageStatus` is blank (admin hasn't acted yet)
 *  - `sentVia` is one of the migration sentinel values:
 *      • "legacy_orphan"      - Pass 1 import label
 *      • "legacy_visit_logs"  - Pass 2 rename (current production label)
 */
fun KinCareReport.isUntriagedOrphan(): Boolean =
    kinfolkId.isBlank() &&
    triageStatus.isBlank() &&
    sentVia in setOf("legacy_orphan", "legacy_visit_logs")

enum class ReportStatus {
    DRAFT,
    SENT,
    FAILED
}

// --- Communications: four channel-specific log collections ---
//
// Each log is its own Firestore collection so screens can query independently
// and the reconcile pipeline can fan-in by channel. Common provenance fields
// (reconcileStatus, reconciledAt, reconcileNotes) live on every entry so the
// merge step can mark which messages have been folded into a kinfolk's
// Dossier / Kin411, which were skipped (spam, system noise), and which failed.

/** Firestore collection: voicemails */
@Keep
data class VoicemailLog(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var callerNumber: String = "",
    var transcript: String = "",
    var audioUrl: String = "",
    var durationSec: Int = 0,
    var direction: String = "inbound",   // voicemails are inbound by definition; kept for shape parity
    var timestamp: String = "",          // ISO-8601
    var twilioCallSid: String = "",

    // Reply state - voicemails are responded to via SMS/email/call from the screen.
    var replyStatus: String = "unread",  // unread | read | replied | dismissed
    var repliedAt: String = "",
    var replyLogId: String = "",         // points at the SmsMessage / EmailMessage / CallLog created in response

    // Reconciliation provenance.
    var reconcileStatus: String = "pending", // pending | applied | skipped | failed
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: calls_log */
@Keep
data class CallLog(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var counterpartNumber: String = "",  // the other party's number, regardless of direction
    var direction: String = "inbound",   // inbound | outbound
    var status: String = "",             // answered | missed | declined | voicemail
    var transcript: String = "",
    var recordingUrl: String = "",
    var durationSec: Int = 0,
    var timestamp: String = "",
    var twilioCallSid: String = "",
    var voicemailLogId: String = "",     // set when status=voicemail; points back at VoicemailLog

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: sms_messages - covers SMS, MMS, RCS via [subType]. */
@Keep
data class SmsMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var counterpartNumber: String = "",
    var direction: String = "inbound",   // inbound | outbound
    var subType: String = "sms",         // sms | mms | rcs
    var body: String = "",
    var mediaUrls: List<String> = emptyList(),
    var threadId: String = "",           // groups a kinfolk's back-and-forth
    var timestamp: String = "",
    var twilioMessageSid: String = "",
    var status: String = "",             // delivered | failed | queued | received

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: emails */
@Keep
data class EmailMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var fromAddress: String = "",
    var toAddresses: List<String> = emptyList(),
    var ccAddresses: List<String> = emptyList(),
    var subject: String = "",
    var body: String = "",               // plaintext rendition
    var bodyHtml: String = "",           // optional HTML body (for richer reply quoting)
    var attachmentUrls: List<String> = emptyList(),
    var threadId: String = "",
    var direction: String = "inbound",   // inbound | outbound
    var timestamp: String = "",
    var providerMessageId: String = "",  // gmail/sendgrid/etc id
    var status: String = "",             // delivered | bounced | queued | received

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: fcm_messages - outbound push notifications from Auntie OS to a kinfolk's MyTribe app. */
@Keep
data class FcmMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var uid: String = "",                // recipient firebase auth uid (fcm_tokens doc id)
    var title: String = "Auntie",
    var body: String = "",
    var direction: String = "outbound",  // outbound only for now; inbound n/a for FCM
    var timestamp: String = "",
    var fcmMessageName: String = "",     // FCM v1 response "name" field
    var status: String = "",             // delivered | failed | queued
    var errorMessage: String = "",       // populated when status=failed

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

// --- Legacy in-memory comms model (no Firestore collection currently writes here) ---

@Keep
data class CommunicationLog(
    @DocumentId val id: String = "",
    var callSid: String = "",
    var messageSid: String = "",
    var type: String = "", 
    var status: String = "",
    var callerNumber: String = "",
    var transcript: String = "",
    var recordingUrl: String = "",
    var kinfolkId: String? = null,
    var timestamp: String = "",
    var direction: String = "inbound"
)

@Keep
data class MessageEvent(
    val messageSid: String,
    val body: String,
    val senderNumber: String,
    val type: String,
    val timestamp: Long = System.currentTimeMillis(),
    val direction: String = "inbound",
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

@Keep
data class VoicemailEvent(
    val callerNumber: String,
    val transcript: String,
    val playUrl: String,
    val timestamp: Long = System.currentTimeMillis(),
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

@Keep
data class CallEvent(
    val callSid: String,
    val callerNumber: String,
    val transcript: String,
    val popupUrl: String,
    val timestamp: Long = System.currentTimeMillis(),
    var actionTaken: String = "no_response",
    var recordingUrl: String = "",
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

// --- API Models ---


@Keep
data class SendMessageRequest(
    val recipient_phone: String,
    val recipient_email: String? = null,
    val message_body: String,
    val kinfolk_id: String?,
    val channel: String = "sms"
)

@Keep
data class SendMessageResponse(
    val receiptId: String = ""
)

/** Firestore collection: generated_drafts - outputs from the Generate n8n workflow,
 *  approved/edited via the AdminDashboard, then triggers the Update Profiles workflow.
 *
 *  WRITER MISMATCH (do not silently trust field names): these camelCase fields
 *  match the n8n/migrated docs (which Android's recent-drafts list reads, ordered
 *  by `createdOn`). The newer web/functions/generate.js Cloud Function writes the
 *  SAME collection in snake_case (`kinfolk_id`, `kinfolk_name`, `generated_copy`,
 *  `communication_type`, `generated_at`) with status `"generated"`, so those docs
 *  read blank here and are excluded from the createdOn-ordered query entirely.
 *  Fixing that convergence belongs in generate.js (write camelCase, or mirror
 *  fields) - a @PropertyName alias can only bind ONE name and would break the
 *  migrated path. Left as-is; the fields below are only made null-safe so a null
 *  value can't crash toObject(). TODO(generate.js): converge on camelCase. */
@Keep
data class Draft(
    @DocumentId val id: String = "",
    var status: String = "pending",                  // pending | approved | rejected
    var generatedCopy: String = "",
    var communicationType: String = "",
    // Nullable: migrated/approve-flow docs store these as null (Class B decode crash).
    var kinfolkId: String? = "",
    var kinfolkName: String? = "",
    var rawNotes: String = "",
    var toneHint: String = "",
    var maxLength: String = "",
    var model: String = "",
    var createdOn: String = "",                      // ISO-8601 (legacy field name kept)
    var approvedAt: String? = "",
    var approvedBy: String = "",                     // uid
)

@Keep
data class GenerateResponse(
    @SerializedName("generated_copy") val generatedCopy: String = "",
    @SerializedName("draft_id") val draftId: String? = null,
    @SerializedName("kinfolk_id") val kinfolkId: String? = null,
    @SerializedName("kinfolk_name") val kinfolkName: String = "",
    @SerializedName("communication_type") val communicationType: String = "",
    val model: String = "",
    val error: String? = null
)

@Keep
data class GenerateRequest(
    val communication_type: String,
    /**
     * Display name of the household. Still sent, for the draft doc and the
     * server's 404 copy, but no longer what decides WHICH household the model
     * reads about. See [kinfolk_id].
     */
    val recipient: String,
    /**
     * The real `kinfolk` doc id the picker resolved.
     *
     * Without it, the server re-derives the household from [recipient] by
     * case-folded compares against firstName / lastName / "First Last" and then
     * a startsWith fallback. Two households named Dana, or one entered as
     * "Dana M.", and the wrong dossier, kin and 411s feed the model. The picker
     * has held the real object the whole time and threw the id away; the
     * `RecipientPicker` doc claiming "a kinfolk_id is chosen client-side, not
     * fuzzy-matched" was aspirational until this field existed.
     *
     * Null for the recipient-less types (blog, social), where there is no
     * household to name.
     */
    val kinfolk_id: String? = null,
    val raw_notes: String,
    val tone_hint: String,
    val max_length: String,
    /** On regenerate: an opener the reader rejected; the generator must not reuse it. */
    val avoid_opening: String? = null,
)

@Keep
data class ApproveRequest(
    val trigger_source: String = "generated_draft",
    val row_id: String = "",
    val kinfolk_id: String? = null
)

/** Run-4 #6: dog + cat breed name banks from the getBreeds callable. */
@Keep
data class BreedBank(
    val dogBreeds: List<String> = emptyList(),
    val catBreeds: List<String> = emptyList(),
)

/**
 * Shared `vet_clinics` Firestore collection. Both Android + web write to this
 * single catalog so the chip selector on Kinfolk Edit can autocomplete from a
 * common pool. New entries land here when an admin types a clinic name not
 * already in the list and taps "Add new".
 */
@Keep
data class VetClinic(
    @DocumentId var id: String = "",
    var name: String = "",
    var phone: String = "",
    var address: String = "",
    var notes: String = "",   // parity with web VetClinic.notes
    var website: String = "",          // clinic homepage (optional)
    var googleMapsUrl: String = "",    // deep-link to the Maps listing (optional)
    var isEmergency: Boolean = false,  // 24hr / emergency / urgent-care
    // Approval gate for the kinfolk vet bank. Admin-authored = true; a kinfolk
    // submitVetClinic lands false (pending) and is hidden from other households
    // until the operator approves. Missing (legacy) reads as approved -> default true.
    var verified: Boolean = true,
    var submittedBy: String = "",      // uid of the kinfolk who submitted a pending entry
    // Opening hours, e.g. "Mon to Fri 8a to 6p". Lives on the CLINIC, not on the
    // household that picked it: every household using a practice shares its
    // hours, so `household_data.primaryVetHours` stored one clinic's hours N
    // times and corrected them zero times. See the A2 migration script.
    var hours: String = "",
    // Retired from the bank by `archiveVetClinic`. NOT a delete: a household
    // points at a clinic by id with no referential integrity, so removing the
    // row would strand those households outside updateVetClinic's fan-out and
    // destroy the record of what they were told to dial. Missing (legacy) reads
    // as active -> default false. An archived clinic is hidden from the pickers
    // but never from a household already linked to it, which keeps its own copy
    // of the name, phone and address.
    var archived: Boolean = false,
    // Held raw (Class A, same as Kinfolk/Kin/KinCareSession): this app writes an
    // ISO String, but portal `submitVetClinic` writes serverTimestamp(), so a
    // typed String throws on decode for every kinfolk-submitted clinic and takes
    // down the whole snapshot listener. Read via createdAtIso()/updatedAtIso().
    var createdAt: Any? = null,
    var updatedAt: Any? = null,
)

/**
 * `observeVetClinicsOrFail`'s emission: the catalog list, PLUS whether the last
 * listener callback was a failure. A load failure keeps whatever [clinics] it
 * last held rather than clearing it, so a transient blip does not blank a
 * picker that was already showing a good list; [failed] is the separate signal
 * a screen discloses instead of guessing from an empty list, which is also
 * what a genuinely empty (but healthy) catalog looks like.
 */
data class VetClinicsSnapshot(
    val clinics: List<VetClinic> = emptyList(),
    val failed: Boolean = false,
)

/**
 * `submitVetClinic`'s full callable response (`mytribe/functions/src/portal/
 * submitVetClinic.ts`'s `{ clinicId, created, pending }`). [created] is false
 * on a DEDUPE hit (the callable matched an existing clinic by normalized name
 * instead of writing a new one), which is what lets a caller disclose "already
 * in the catalog" rather than the create silently resolving to someone else's
 * record. [pending] is true only for a kinfolk-submitted clinic awaiting
 * approval; a staff/operator submission is never pending.
 */
/** One clinic offered as a possible match, for the operator to choose between. */
data class VetClinicCandidate(
    val id: String = "",
    val name: String = "",
    val address: String = "",
    val phone: String = "",
    val isEmergency: Boolean = false,
    /** False for a submission still awaiting operator approval. */
    val verified: Boolean = true,
)
data class SubmitVetClinicResult(
    val clinicId: String,
    val created: Boolean,
    val pending: Boolean,
    /**
     * True when the callable found near-matches and wrote NOTHING. [candidates]
     * must be shown and the operator must choose (operator ruling 2026-08-01).
     */
    val needsChoice: Boolean = false,
    val candidates: List<VetClinicCandidate> = emptyList(),
)

/**
 * Single doc per Firebase Auth uid in the `users` Firestore collection.
 * Mirrors the web `UserProfile` shape so admin profile state stays in sync
 * across web + Android. Photo upload goes through MediaUploadManager →
 * Cloudinary; the resulting Cloudinary URL is stored in [photoUrl].
 */
@Keep
data class UserProfile(
    @DocumentId var id: String = "",
    var uid: String = "",
    var email: String = "",
    var displayName: String = "",
    var firstName: String = "",
    var lastName: String = "",
    var phone: String = "",
    var title: String = "",
    var photoUrl: String = "",
    var bio: String = "",
    var dashboardWidgets: List<String> = emptyList(),
    // 17.4 Nav editor: per-operator nav customization, ordered tokens "key" or
    // "key|Custom Label" (key = nav destination name). Absent known key = hidden; empty
    // = shipped default. Wire name matches web UserProfile.navConfig byte-for-byte.
    var navConfig: List<String> = emptyList(),
    // Per-operator UI theme preference: "LIGHT"/"DARK"/"SYSTEM"; blank falls back to the
    // app default. Shared with web/desktop on users/{uid}; kept here so an Android profile
    // save never drops the theme another platform wrote (0A).
    var themeMode: String = "",
    // 17.1 personalization keys (blank on legacy docs -> app default). accentColor:
    // "TEAL".."CORAL"; density: "COMPACT"/"NORMAL"/"ROOMY"; fontScale: "SMALL"/
    // "MEDIUM"/"LARGE". Shared with web/desktop on users/{uid}.
    var accentColor: String = "",
    var density: String = "",
    var fontScale: String = "",
    // Held raw (Class A, same as VetClinic above): this app writes an ISO String,
    // but `setMediaProfilePhoto` merges serverTimestamp() into users/{uid} when an
    // operator sets an avatar, so a typed String throws on decode from then on,
    // including at every cold start. Read via createdAtIso()/updatedAtIso().
    var createdAt: Any? = null,
    var updatedAt: Any? = null,
) {
    val displayLabel: String
        get() = when {
            displayName.isNotBlank() -> displayName
            firstName.isNotBlank() && lastName.isNotBlank() -> "$firstName $lastName"
            firstName.isNotBlank() -> firstName
            lastName.isNotBlank()  -> lastName
            email.isNotBlank() -> email
            else -> "Unnamed User"
        }
}
// ── Dashboard widget models (AO-35/39/40/41) ─────────────────────────────────
// Callable-backed read models for the hidden-by-default Home dashboard widgets.
// These arrive from admin-gated MyTribe callables as decoded maps (not Firestore
// toObject targets), so they carry no @DocumentId; the repo decodes them by hand.
/** AO-39 expiration-countdown row (expirations collection, via listExpirations). */
@Keep
data class ExpirationItem(
    val id: String = "",
    val label: String = "",
    val dateIso: String = "",   // YYYY-MM-DD
    val kinfolkId: String = "",
    val kind: String = "",      // gateCode|vetRecord|card|license|other
)
/** AO-40 expense-quick-log row (expenses collection, via listExpenses). */
@Keep
data class Expense(
    val id: String = "",
    val kind: String = "",      // gas|parking|supplies|other
    val amountCents: Int = 0,
    val note: String = "",
    val occurredAt: String = "", // ISO instant
)
/** AO-40 listExpenses envelope: the rows plus server-computed week/month totals. */
@Keep
data class ExpenseSummary(
    val expenses: List<Expense> = emptyList(),
    val weekTotalCents: Int = 0,
    val monthTotalCents: Int = 0,
)
/** AO-41 supplies-tracker row (supplies collection, via listSupplies). */
@Keep
data class Supply(
    val id: String = "",
    val name: String = "",
    val onHand: Int = 0,
    val par: Int = 0,           // reorder threshold; low when onHand <= par
    val unit: String = "",
)
/** AO-41 listSupplies envelope: the rows plus the low count (onHand <= par). */
@Keep
data class SuppliesResult(
    val supplies: List<Supply> = emptyList(),
    val lowCount: Int = 0,
)
/** AO-35 one routed stop, in arrival order, from optimizeRoute. */
@Keep
data class RouteStop(
    val order: Int = 0,
    val sessionId: String = "",
    val kinfolkId: String = "",
    val household: String = "",
    val address: String = "",
    val arrivalEta: String = "", // HH:MM
)
/** AO-35 a stop that could not be routed (household with no serviceAddress). */
@Keep
data class UnroutableStop(
    val sessionId: String = "",
    val household: String = "",
    val reason: String = "",
)
/** AO-35 optimizeRoute envelope: ordered stops, totals, and fail-loud unroutables. */
@Keep
data class RouteResult(
    val stops: List<RouteStop> = emptyList(),
    val totalMiles: Double = 0.0,
    val totalMinutes: Int = 0,
    val unroutable: List<UnroutableStop> = emptyList(),
)
