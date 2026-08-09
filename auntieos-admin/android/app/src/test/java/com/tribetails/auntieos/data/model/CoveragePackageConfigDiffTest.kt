package com.tribetails.auntieos.data.model

import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.Duration
import org.junit.Assert.assertEquals
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The coverage-config differ itself, away from any ViewModel.
 *
 * `coverage_package_config/config` is one operator-global document with two
 * writers: this app and the React Coverage Package Builder
 * (`auntieos-admin/src/api/coveragePackageWrite.ts`). The android side used to
 * hand it `.set(wholeModel, merge())`, the shape PRs #312, #315 and #327 removed
 * from `household_data`, `kinfolk`/`kin` and `business_settings`.
 *
 * THE DRIFT GUARD AT THE BOTTOM IS THE LOAD-BEARING TEST HERE, which is unusual
 * and worth saying out loud. This model has exactly ONE writable field, so there
 * is no sibling for a stale copy to revert and the reversion #327 fixed has no
 * surface on this document today. The guard is what keeps that a checked property
 * rather than an accident: the day someone adds a second field, the whole-model
 * shape would have reverted it on every menu save, silently.
 */
class CoveragePackageConfigDiffTest {

    /** The document as it stood when the phone read it. */
    private val loaded = CoveragePackageConfig(
        durations = DEFAULT_DURATIONS,
        updatedAt = "2026-01-01T00:00:00Z",
        updatedBy = "web@tribetails.com",
    )

    @Test
    fun `an unchanged document diffs to nothing`() {
        assertEquals(emptyMap<String, Any?>(), coveragePackageConfigFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `an edited visit menu is the only thing written`() {
        val edited = loaded.copy(durations = loaded.durations + Duration("d9", "3-hour visit", 180.0, 95.0, "visit"))
        val changes = coveragePackageConfigFieldChanges(loaded, edited)
        assertEquals(setOf("durations"), changes.keys)
        assertEquals(edited.durations, changes["durations"])
    }

    /** Emptying the menu is an edit, not a no-op: the empty list must be written. */
    @Test
    fun `a menu cleared to empty is written as empty`() {
        val changes = coveragePackageConfigFieldChanges(loaded, loaded.copy(durations = emptyList()))
        assertEquals(mapOf<String, Any?>("durations" to emptyList<Duration>()), changes)
    }

    /**
     * The stamps and the document identity are the repository's business, never the
     * diff's. Round-tripping the loaded `updatedAt` is the specific way a stamp
     * starts lying about when the document last changed.
     */
    @Test
    fun `stamps and identity never enter the diff`() {
        val changes = coveragePackageConfigFieldChanges(
            loaded,
            loaded.copy(id = "other", updatedAt = "later", updatedBy = "someone else"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /** A menu edited and then put back is not a write; the durations compare by value. */
    @Test
    fun `a menu returned to its loaded value is not a change`() {
        val edited = loaded.copy(durations = loaded.durations.drop(1))
        assertEquals(setOf("durations"), coveragePackageConfigFieldChanges(loaded, edited).keys)
        assertEquals(
            emptyMap<String, Any?>(),
            coveragePackageConfigFieldChanges(loaded, edited.copy(durations = loaded.durations)),
        )
    }

    // ── Drift guard ──────────────────────────────────────────────────────────

    /**
     * DRIFT GUARD, and the reason this file exists at all.
     *
     * Two failure modes, one test. A field added to [CoveragePackageConfig] and not
     * added here would silently stop saving - the quiet loss the fix would have
     * introduced itself. A field added here and not to the model cannot be read.
     * And the field that matters most is the SECOND writable field, whenever it
     * arrives: under the old whole-model write it would have been reverted on every
     * visit-menu save with no concurrent editor required, which is exactly what
     * `business_settings` did with 46 of them.
     */
    @Test
    fun `every model field is covered by the differ`() {
        val modelled = CoveragePackageConfig::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .filterNot { it in COVERAGE_PACKAGE_CONFIG_SERVER_OWNED }
            .toSet()

        assertEquals(
            "CoveragePackageConfig gained or lost a field; update COVERAGE_PACKAGE_CONFIG_DIFF_FIELDS",
            modelled,
            COVERAGE_PACKAGE_CONFIG_DIFF_FIELDS.keys,
        )
    }
}
