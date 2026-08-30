package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The settings differ itself, away from any ViewModel.
 *
 * `business_settings/business_settings` is one document with many editors: four
 * android screens each own a slice, and the React admin patches it per section
 * (`auntieos-admin/src/api/settingsWrite.ts`). Whole-model writes from the phone
 * therefore reverted whatever the web had changed since the phone loaded it.
 */
class BusinessSettingsDiffTest {

    private val loaded = BusinessSettings(
        businessName = "Tribe Tails",
        calendarSyncId = "old@group.calendar.google.com",
        venmoHandle = "@old-venmo",
        weatherLocation = "Austin, TX",
        trackingAccuracy = TrackingAccuracy.HIGH,
        updatedAt = "2026-01-01T00:00:00Z",
        updatedBy = "admin",
    )

    @Test
    fun `an unchanged document diffs to nothing`() {
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `only the changed field appears`() {
        val changes = businessSettingsFieldChanges(loaded, loaded.copy(venmoHandle = "@new-venmo"))
        assertEquals(mapOf("venmoHandle" to "@new-venmo"), changes)
    }

    /** Clearing a handle is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a field cleared to blank is written as blank`() {
        val changes = businessSettingsFieldChanges(loaded, loaded.copy(venmoHandle = ""))
        assertEquals(mapOf("venmoHandle" to ""), changes)
    }

    /** The stamps and the document identity are the repository's business, never the diff's. */
    @Test
    fun `stamps and identity never enter the diff`() {
        val changes = businessSettingsFieldChanges(
            loaded,
            loaded.copy(id = "other", updatedAt = "later", updatedBy = "someone else"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /** Booleans and ints diff by value, so a toggle flipped back to its old value is not a write. */
    @Test
    fun `a toggle returned to its loaded value is not a change`() {
        val flipped = loaded.copy(snapRescheduleTo15Min = true)
        assertEquals(
            mapOf<String, Any?>("snapRescheduleTo15Min" to true),
            businessSettingsFieldChanges(loaded, flipped),
        )
        assertEquals(
            emptyMap<String, Any?>(),
            businessSettingsFieldChanges(loaded, flipped.copy(snapRescheduleTo15Min = false)),
        )
    }

    /**
     * #517: "Block bookings during busy events" is now a real row on the admin
     * Settings screen (`AdminSettingsScreen`'s BookingBehaviorPanel), and the
     * server reads the field it writes before every booking. Turning it OFF is
     * the edit that matters -- the model default is `true`, so an off-switch that
     * did not reach the diff would leave the gate armed while the UI said it was
     * not.
     */
    @Test
    fun `turning the busy-block gate off is a real write, and so is turning it back on`() {
        val off = loaded.copy(enableConflictDetection = false)
        assertEquals(
            mapOf<String, Any?>("enableConflictDetection" to false),
            businessSettingsFieldChanges(loaded, off),
        )
        assertEquals(
            mapOf<String, Any?>("enableConflictDetection" to true),
            businessSettingsFieldChanges(off, off.copy(enableConflictDetection = true)),
        )
        assertEquals(
            emptyMap<String, Any?>(),
            businessSettingsFieldChanges(off, off.copy()),
        )
    }

    /** The enum goes out as its NAME, which is what the old whole-object write produced. */
    @Test
    fun `tracking accuracy is written as the enum name`() {
        val changes = businessSettingsFieldChanges(
            loaded,
            loaded.copy(trackingAccuracy = TrackingAccuracy.LOW),
        )
        assertEquals(mapOf<String, Any?>("trackingAccuracy" to "LOW"), changes)
    }

    // ── Tag vocabularies: compared decoded, written raw ───────────────────────

    private val vocab = listOf(
        TagDef(name = "VIP", color = TagColor(token = "accent", css = "var(--color-accent)"), icon = "*"),
    )

    /**
     * A doc that has never held a vocabulary decodes to null. The Tags panel
     * re-encodes BOTH scopes on every save, so it offers `[]` for the scope the
     * operator did not touch. That is not a change, and writing it would put an
     * empty array over "never configured".
     */
    @Test
    fun `re-encoding an absent vocabulary is not a change`() {
        val edited = loaded.withPetTagDefs(emptyList())   // petTags: null -> []
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(loaded, edited))
    }

    @Test
    fun `a real vocabulary edit writes the raw encoded rows`() {
        val edited = loaded.withHouseholdTagDefs(vocab)
        val changes = businessSettingsFieldChanges(loaded, edited)
        assertEquals(setOf("householdTags"), changes.keys)
        assertEquals(encodeTagDefs(vocab), changes["householdTags"])
    }

    /**
     * Editing ONE vocabulary must leave the other alone, which is the whole point
     * on a profile's inline tag promotion: it grows the household bank and must
     * not touch the pet bank the React admin may have just edited.
     */
    @Test
    fun `editing the household vocabulary leaves the pet vocabulary out of the write`() {
        val stored = loaded.withPetTagDefs(vocab)
        val edited = stored.withHouseholdTagDefs(vocab)
        assertEquals(setOf("householdTags"), businessSettingsFieldChanges(stored, edited).keys)
    }

    /**
     * A legacy row carrying a key the model does not model survives, because the
     * comparison runs on the decoded vocabulary: re-encoding it is not a change,
     * so nothing is written and the stored row keeps its extra key.
     */
    @Test
    fun `re-encoding a legacy row with an unmodelled key writes nothing`() {
        val legacy = loaded.copy(
            householdTags = listOf(
                mapOf(
                    "name" to "VIP",
                    "color" to mapOf("token" to "accent", "css" to "var(--color-accent)"),
                    "icon" to "*",
                    "legacyOrder" to 3L,
                )
            )
        )
        val edited = legacy.withHouseholdTagDefs(legacy.householdTagDefs())
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(legacy, edited))
    }

    // ── MyTribe portal Home layout (issue #397 M10): compared decoded, written raw ──

    /**
     * Re-encoding an unchanged Home layout is not a change, the same rule the
     * tag vocabularies rely on above: opening the Home layout panel and
     * pressing Save with nothing touched must never fire a write.
     */
    @Test
    fun `re-encoding an unchanged Home layout is not a change`() {
        val withLayout = loaded.withHomeSections(listOf(PortalHomeSection("upNext", true, 5)))
        val edited = withLayout.withHomeSections(withLayout.homeSections())
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(withLayout, edited))
    }

    @Test
    fun `a real Home layout edit writes the raw mytribePortal object`() {
        val edited = loaded.withHomeSections(listOf(PortalHomeSection("upNext", true, 5)))
        val changes = businessSettingsFieldChanges(loaded, edited)
        assertEquals(setOf("mytribePortal"), changes.keys)
        assertEquals(edited.mytribePortal, changes["mytribePortal"])
    }

    /**
     * THE DIFF-NOT-REBUILD CASE, pinned at the differ level: android's write
     * must carry every sibling `mytribePortal` key forward untouched, so a
     * layout edit here can never be the write that quietly drops the React
     * admin's logo, theme, banner, or chat configuration.
     */
    @Test
    fun `a Home layout edit preserves sibling mytribePortal keys the React admin owns`() {
        val stored = loaded.copy(
            mytribePortal = mapOf(
                "logoUrl" to "https://example.com/logo.png",
                "themeId" to "sunset",
                "banner" to mapOf("enabled" to true, "message" to "Closed for the holiday"),
                "home" to mapOf("sections" to emptyList<Any>()),
            )
        )
        val edited = stored.withHomeSections(listOf(PortalHomeSection("upNext", true, 0)))
        val changes = businessSettingsFieldChanges(stored, edited)
        val written = changes["mytribePortal"] as Map<*, *>
        assertEquals("https://example.com/logo.png", written["logoUrl"])
        assertEquals("sunset", written["themeId"])
        assertEquals(mapOf("enabled" to true, "message" to "Closed for the holiday"), written["banner"])
    }

    @Test
    fun `reordering two already-configured sections is a real, writable change`() {
        val stored = loaded.withHomeSections(
            listOf(PortalHomeSection("upNext", true, 0), PortalHomeSection("roster", true, 0))
        )
        val reordered = stored.withHomeSections(
            listOf(PortalHomeSection("roster", true, 0), PortalHomeSection("upNext", true, 0))
        )
        val changes = businessSettingsFieldChanges(stored, reordered)
        assertEquals(setOf("mytribePortal"), changes.keys)
        assertEquals(listOf("roster", "upNext"), reordered.homeSections().map { it.id })
    }

    // ── One-way-door guard (issue #397 M10 follow-up) ──────────────────────────
    //
    // `HomeLayoutPanel` (AdminSettingsScreen.kt) seeds its draft from the RAW
    // `settings.homeSections()`, never from `effectiveHomeSections(...)` (that
    // materialized list is for DISPLAY only, computed fresh every recomposition
    // and never assigned into the draft). These pin that split at the layer
    // that actually decides whether Firestore gets written: simulating the
    // panel's own "open", "reset", and "real edit" paths end to end through
    // `withHomeSections` + `businessSettingsFieldChanges`, exactly as the panel
    // would produce them.

    /**
     * PIN 1: opening a stored (non-default) layout and pressing Save with
     * nothing touched leaves the stored value unchanged. The panel's draft
     * starts identical to `settings.homeSections()` -- re-encoding that same,
     * untouched list must diff to nothing, whatever it contains.
     */
    @Test
    fun `opening a custom layout and saving with no edits writes nothing`() {
        val stored = loaded.withHomeSections(
            listOf(
                PortalHomeSection("liveVisit", true, 0),
                PortalHomeSection("upNext", false, 0),
                PortalHomeSection("tales", true, 0),
                PortalHomeSection("roster", true, 0),
                PortalHomeSection("quickStart", true, 0),
            )
        )
        val untouchedDraft = stored.homeSections() // exactly HomeLayoutPanel's `baseline`/initial `rows`
        val edited = stored.withHomeSections(untouchedDraft)
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(stored, edited))
    }

    /** Same PIN 1, for the already-default (never configured) starting point. */
    @Test
    fun `opening an already-default layout and saving with no edits writes nothing`() {
        val untouchedDraft = loaded.homeSections() // `[]`
        val edited = loaded.withHomeSections(untouchedDraft)
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(loaded, edited))
    }

    /**
     * PIN 2: "Reset to default layout" returns the document to the empty array
     * the portal reads as its own implicit default, and it is a REAL, writable
     * change when the stored layout is not already that.
     */
    @Test
    fun `Reset to default layout writes the empty array, not a canonical list dressed up to look like it`() {
        val stored = loaded.withHomeSections(listOf(PortalHomeSection("upNext", true, 5)))
        val edited = stored.withHomeSections(emptyList())
        val changes = businessSettingsFieldChanges(stored, edited)
        assertEquals(setOf("mytribePortal"), changes.keys)
        assertEquals(emptyList<PortalHomeSection>(), edited.homeSections())
    }

    /**
     * The flip side of PIN 2: resetting a layout that is ALREADY the default
     * must not itself register as a change -- otherwise the operator would see
     * "unsaved changes" for pressing a button that did nothing.
     */
    @Test
    fun `resetting an already-default layout is not a change`() {
        val edited = loaded.withHomeSections(emptyList())
        assertEquals(emptyMap<String, Any?>(), businessSettingsFieldChanges(loaded, edited))
    }

    /**
     * PIN 3: a real edit (materialized, then patched, exactly as
     * `HomeLayoutPanel` reassigns its draft on a toggle/limit/reorder) still
     * persists -- the one-way-door fix must not have made genuine edits inert.
     */
    @Test
    fun `a real edit made from the materialized display rows still persists`() {
        // The five canonical ids, standing in for what `effectiveHomeSections`
        // would have materialized from an empty starting draft -- this test
        // does not depend on `ui.admin.HOME_SECTION_CATALOG` (a different
        // package/layer), only on the shape a materialized-then-edited row
        // list takes.
        val canonicalIds = listOf("liveVisit", "upNext", "tales", "roster", "quickStart")
        val materializedThenToggled = canonicalIds.map { id ->
            PortalHomeSection(id, enabled = id != "roster", limit = 0)
        }
        val edited = loaded.withHomeSections(materializedThenToggled)
        val changes = businessSettingsFieldChanges(loaded, edited)
        assertEquals(setOf("mytribePortal"), changes.keys)
        val roster = edited.homeSections().first { it.id == "roster" }
        assertEquals(false, roster.enabled)
    }

    // ── Drift guard ──────────────────────────────────────────────────────────

    /**
     * DRIFT GUARD. A hand-written field list silently stops saving any field added
     * to [BusinessSettings] later, which would be a new quiet data-loss mode
     * introduced by the fix itself. Every declared field except the id and the two
     * stamps must be diffed, and nothing else may be.
     */
    @Test
    fun `every model field is covered by the differ`() {
        val modelled = BusinessSettings::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .filterNot { it in BUSINESS_SETTINGS_SERVER_OWNED }
            .toSet()

        assertEquals(
            "BusinessSettings gained or lost a field; update BUSINESS_SETTINGS_DIFF_FIELDS",
            modelled,
            BUSINESS_SETTINGS_DIFF_FIELDS.keys,
        )
    }

    /**
     * The calendar-sync receipt is unreachable from here BY CONSTRUCTION, which is
     * the promise `CalendarSyncId.kt` makes when it keeps `CalendarSyncRun` off
     * this model. A settings write may only name a field this list names, so no
     * android save can put a stale receipt over the server's.
     */
    @Test
    fun `the calendar sync receipt fields are not writable from this client`() {
        val receipt = setOf(
            "calendarSyncLastRunAt",
            "calendarSyncLastStatus",
            "calendarSyncLastImported",
            "calendarSyncLastError",
        )
        assertTrue(
            "a sync receipt field reached BUSINESS_SETTINGS_DIFF_FIELDS: " +
                "${BUSINESS_SETTINGS_DIFF_FIELDS.keys.intersect(receipt)}",
            BUSINESS_SETTINGS_DIFF_FIELDS.keys.intersect(receipt).isEmpty(),
        )
    }
}
