package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The base-service differ itself, away from any ViewModel.
 *
 * `base_services/{id}` used to take a BARE `.set(wholeModel)` - no merge option
 * at all, so the write REPLACED the document. That is a step worse than the
 * `.set(model, merge())` PRs #312, #315, #327 and #332 removed elsewhere:
 * merge left an unmodelled field alone, and a bare set deletes it.
 * `BaseServiceDiff.kt` names the seven server-read fields that were being
 * deleted and what each costs.
 *
 * The drift guard at the bottom is what keeps this fixed. The failure it
 * catches is quiet in both directions, and one of those directions is the
 * temptation this whole change has to resist: someone "completing the model" by
 * adding `priceCents` to [BaseService] so the app can edit the portal price.
 * That would make this client an owner of the server-trusted amount, and a save
 * racing an edit elsewhere would write the stale price back over the real one.
 * The guard forces that to be a decision recorded in
 * [BASE_SERVICE_PORTAL_OWNED], not a field that quietly appears.
 */
class BaseServiceDiffTest {

    /** The service as it stood when the phone read it. */
    private val loaded = BaseService(
        id = "svc-1",
        title = "Dog Walk",
        description = "A brisk half-hour",
        durationMinutes = 30,
        basePrice = 25.0,
        isActive = true,
        category = "Dog Walking",
        tags = listOf("popular"),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-01-01T00:00:00",
    )

    @Test
    fun `an unchanged service diffs to nothing`() {
        assertEquals(emptyMap<String, Any?>(), baseServiceFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `a renamed service writes the title and nothing else`() {
        val changes = baseServiceFieldChanges(loaded, loaded.copy(title = "Dog Walk (30 min)"))
        assertEquals(setOf("title"), changes.keys)
        assertEquals("Dog Walk (30 min)", changes["title"])
    }

    /** Clearing a field is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a field cleared to blank is written as blank`() {
        val changes = baseServiceFieldChanges(loaded, loaded.copy(description = ""))
        assertEquals(mapOf<String, Any?>("description" to ""), changes)
    }

    /** Emptying the tag list is an edit too, and `[]` is the only way to say it. */
    @Test
    fun `tags cleared to empty are written as empty`() {
        val changes = baseServiceFieldChanges(loaded, loaded.copy(tags = emptyList()))
        assertEquals(mapOf<String, Any?>("tags" to emptyList<String>()), changes)
    }

    /**
     * The stamps and the document identity are the repository's business, never
     * the diff's. Round-tripping the loaded `updatedAt` is the specific way a
     * stamp starts lying about when the service last changed, and round-tripping
     * `createdAt` is how the original creation date gets lost.
     */
    @Test
    fun `stamps and identity never enter the diff`() {
        val changes = baseServiceFieldChanges(
            loaded,
            loaded.copy(id = "other", createdAt = "2026-08-09T00:00:00", updatedAt = "later"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /** A value edited and then put back is not a write; nested rules compare by value. */
    @Test
    fun `a nested business rule returned to its loaded value is not a change`() {
        val edited = loaded.copy(businessRules = loaded.businessRules.copy(requiresApproval = true))
        assertEquals(setOf("businessRules"), baseServiceFieldChanges(loaded, edited).keys)
        assertEquals(
            emptyMap<String, Any?>(),
            baseServiceFieldChanges(loaded, edited.copy(businessRules = loaded.businessRules)),
        )
    }

    /**
     * A soft delete flips `isActive` on the server. A screen that loaded the row
     * beforehand and then renames it must not carry its stale `isActive: true`
     * along and undo that.
     */
    @Test
    fun `renaming a service does not carry a stale isActive along`() {
        val changes = baseServiceFieldChanges(loaded, loaded.copy(title = "Renamed"))
        assertTrue("isActive" !in changes.keys)
    }

    // ── Drift guard ──────────────────────────────────────────────────────────

    /**
     * DRIFT GUARD, and the reason this file exists at all.
     *
     * Two failure modes, one test. A field added to [BaseService] and not added
     * to [BASE_SERVICE_DIFF_FIELDS] would silently stop saving - the quiet loss
     * this fix would otherwise have introduced itself. A field named here and
     * not on the model cannot be read.
     */
    @Test
    fun `every model field is covered by the differ`() {
        val modelled = BaseService::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .filterNot { it in BASE_SERVICE_SERVER_OWNED }
            .toSet()

        assertEquals(
            "BaseService gained or lost a field; update BASE_SERVICE_DIFF_FIELDS",
            modelled,
            BASE_SERVICE_DIFF_FIELDS.keys,
        )
    }

    /**
     * The other half of the guard, and the one that protects money. The portal's
     * server-read names must stay OFF this model: only a write that cannot name
     * a field can be trusted not to change it. If this fails because someone
     * added `priceCents`, the fix is to remove it again, not to relax the list.
     */
    @Test
    fun `the portal's server-read fields stay off the model and out of the differ`() {
        val modelled = BaseService::class.java.declaredFields.map { it.name }.toSet()
        for (field in BASE_SERVICE_PORTAL_OWNED) {
            assertTrue("BaseService must not declare portal field $field", field !in modelled)
            assertTrue("the differ must never write portal field $field", field !in BASE_SERVICE_DIFF_FIELDS)
        }
    }
}
