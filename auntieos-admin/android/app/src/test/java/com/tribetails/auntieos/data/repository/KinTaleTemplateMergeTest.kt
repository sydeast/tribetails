package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.MoodOption
import com.tribetails.auntieos.data.model.kinTaleTemplateFieldChanges
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The android app is not the author of `kintale_templates/{id}.deleted`, and
 * must not be able to delete it - nor to write back a whole template it read
 * minutes ago over the web admin's edit.
 *
 * `updateKinTaleTemplate` used to write the whole [KinTaleTemplate] with a bare
 * `.set()` - no merge option, a full document REPLACE. This collection has
 * ALREADY PAID for that shape once: `ChecklistItem.required` was stripped from
 * every template for as long as the field was missing from this Kotlin model
 * (see the note on `ChecklistItem` in `KinTaleTemplate.kt`).
 *
 * Three other writers share these documents and all of them patch: the React
 * admin's `saveKinTaleTemplate` (complete field set, `{ merge: true }`), the
 * same module's `batch.update(ref, { isDefault: false })` sibling demotion, and
 * the desktop admin's `platformDeleteKinTaleTemplate`, which soft-deletes by
 * patching `deleted: true` - a field this model has never declared.
 * `KinTaleTemplateDiff.kt` sets out what the whole-model write cost each of
 * them, and why declaring `deleted` would be the wrong fix.
 *
 * The write mode is not asserted for its own sake. Each test replays the
 * recorded write against a stored document using Firestore's real semantics -
 * `set(obj)` REPLACES the document, `set(obj, merge())` overlays only the keys
 * the payload carries - and asserts on what survives. A test that merely counted
 * `SetOptions.merge()` calls would pass just as happily if merge stopped
 * preserving anything.
 *
 * No Robolectric: the Firestore write surface is mockk-stubbed and the returned
 * Tasks are already complete, so `await()` resolves inline on the JVM. Same
 * shape as `UserProfileMergeTest` and `KinCareReportReconcileMergeTest`.
 */
class KinTaleTemplateMergeTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** The write the repo actually issued, and whether it asked Firestore to merge. */
    private data class RecordedWrite(val payload: Any, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    private fun repo(templateId: String = TEMPLATE_ID): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        every { firestore.collection("kintale_templates") } returns collection
        every { collection.document(templateId) } returns docRef
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any(), any<SetOptions>()) } answers {
            recorded = RecordedWrite(firstArg(), merge = true)
            Tasks.forResult<Void>(null)
        }
        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = gate,
            functionsOverride = mockk(), // lazy; never resolved on a write path
            firestoreProvider = { firestore },
        )
    }

    /**
     * The keys the recorded payload puts on the wire. A field-map write carries
     * exactly its own keys; a POJO write carries every declared property of the
     * data class - and, by omission, exactly the set of sibling-written fields a
     * bare `set()` destroys.
     */
    private fun writtenKeys(): Set<String> {
        val payload = requireNotNull(recorded) { "the repository issued no document write at all" }.payload
        return if (payload is Map<*, *>) {
            payload.keys.map { it.toString() }.toSet()
        } else {
            payload.javaClass.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet()
        }
    }

    private fun payloadMap(): Map<*, *> =
        requireNotNull(recorded) { "the repository issued no document write at all" }.payload as Map<*, *>

    /**
     * Replays the recorded write against a stored document, as Firestore would.
     * `set(obj)` REPLACES the whole document; `set(obj, merge())` overlays only
     * the keys the payload carries and leaves every other stored key alone.
     */
    private fun serverDocAfterWrite(stored: Map<String, Any>): Map<String, Any> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val incoming = writtenKeys().associateWith { "written-by-client" as Any }
        return if (write.merge) stored + incoming else incoming
    }

    /**
     * The template as the OTHER admins actually leave it: the React editor's
     * field set, plus the desktop admin's soft-delete flag.
     */
    private fun storedTemplateDoc(): Map<String, Any> = mapOf(
        "name" to "Daily Walk Recap",
        "description" to "The standard dog-walk recap",
        "isDefault" to true,
        "checklistItems" to listOf(mapOf("key" to "fed", "text" to "Fed breakfast", "order" to 0)),
        // Patched by the desktop admin's platformDeleteKinTaleTemplate.
        // Not on KinTaleTemplate, by design.
        "deleted" to true,
    )

    private val loaded = KinTaleTemplate(
        id = TEMPLATE_ID,
        name = "Daily Walk Recap",
        description = "The standard dog-walk recap",
        serviceTypeKeys = listOf("dog_walk"),
        checklistItems = listOf(
            ChecklistItem(key = "fed", text = "Fed", order = 0),
            ChecklistItem(key = "meds_given", text = "Medications given", order = 1),
        ),
        moodOptions = listOf(MoodOption(key = "happy", label = "Happy", emoji = "😊", order = 0)),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-08-01T00:00:00",
    )

    private fun save(edited: KinTaleTemplate, from: KinTaleTemplate = loaded) = runBlocking {
        repo().updateKinTaleTemplateFields(from.id, kinTaleTemplateFieldChanges(from, edited))
    }

    // ── the premise: the client cannot name this field ────────────────────────

    @Test
    fun `KinTaleTemplate declares none of the sibling-written fields`() {
        val keys = KinTaleTemplate::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()
        // If this ever fails the fix went the wrong way: this editor has no
        // delete-state concept, so it could only ever write `false` over the
        // desktop admin's `true`.
        assertTrue("deleted" !in keys)
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("checklistItems" in keys)
        assertTrue("isDefault" in keys)
    }

    // ── the defect ────────────────────────────────────────────────────────────

    @Test
    fun `renaming a template does not erase the desktop admin's soft delete`() {
        val result = save(loaded.copy(name = "Morning Walk Recap"))

        assertTrue(result.isSuccess)
        assertEquals(true, serverDocAfterWrite(storedTemplateDoc())["deleted"])
    }

    /**
     * The second loss, the one merge alone would leave open. The web admin
     * renames a checklist row; the phone, holding the template it loaded before
     * that, toggles a section. The phone's whole-model write put the old row
     * text back - and `getMyKinTales.parseTemplateChecklistItems` DROPS a
     * checked key it cannot resolve in the template, so the row the Auntie
     * really ticked simply vanished from the family's recap.
     */
    @Test
    fun `toggling a section writes only that toggle`() {
        save(loaded.copy(petMoodEnabled = false)).getOrThrow()

        assertEquals(setOf("petMoodEnabled", "updatedAt"), writtenKeys())
        // The web's checklist rename survives untouched.
        assertEquals(
            listOf(mapOf("key" to "fed", "text" to "Fed breakfast", "order" to 0)),
            serverDocAfterWrite(storedTemplateDoc())["checklistItems"],
        )
    }

    /**
     * `demoteOtherDefaults` reaches for a SIBLING template the operator never
     * opened, purely to clear one boolean. The React admin does exactly this
     * with `batch.update(ref, { isDefault: false })`; the phone used to
     * re-assert a whole stale sibling, which both clobbered whatever had changed
     * on it and, when the read was stale, could put a second `isDefault: true`
     * back - the ambiguity `getActiveTemplateForService` resolves by snapshot
     * order, i.e. arbitrarily.
     */
    @Test
    fun `demoting a sibling default writes only the flag`() {
        val sibling = loaded.copy(isDefault = true)

        save(sibling.copy(isDefault = false), from = sibling).getOrThrow()

        assertEquals(setOf("isDefault", "updatedAt"), writtenKeys())
        assertEquals(true, serverDocAfterWrite(storedTemplateDoc())["deleted"])
    }

    @Test
    fun `a description cleared by the operator still reaches the server as cleared`() {
        // The diff must not become a way to silence a real edit.
        save(loaded.copy(description = "")).getOrThrow()

        assertEquals("", payloadMap()["description"])
    }

    @Test
    fun `the save stamps updatedAt rather than round-tripping the read value`() {
        save(loaded.copy(name = "Morning Walk Recap")).getOrThrow()

        val stamp = payloadMap()["updatedAt"] as String
        assertTrue(stamp != "2026-08-01T00:00:00")
    }

    // ── the refusals ──────────────────────────────────────────────────────────

    /**
     * An empty change set could only move the stamp, claiming an edit that never
     * happened. The ViewModel skips the call outright; reaching the repository
     * with nothing to say is a caller bug.
     */
    @Test
    fun `a write with no changed fields is refused rather than stamping`() {
        val result = runBlocking { repo().updateKinTaleTemplateFields(TEMPLATE_ID, emptyMap()) }

        assertTrue(result.isFailure)
        assertNull(recorded)
    }

    @Test
    fun `a blank template id is refused rather than written to a document named empty`() {
        val result = runBlocking { repo("").updateKinTaleTemplateFields("", mapOf("name" to "x")) }

        assertTrue(result.isFailure)
        assertNull(recorded)
    }

    private companion object {
        const val TEMPLATE_ID = "tmpl-1"
    }
}
