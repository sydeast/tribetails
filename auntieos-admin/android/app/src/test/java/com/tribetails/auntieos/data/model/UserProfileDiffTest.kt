package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The profile differ itself, away from any ViewModel.
 *
 * `users/{uid}` is the one document every per-operator preference shares across
 * android, the React admin and two callables. The android side used to write all
 * eighteen of its modelled fields on every save, through a BARE `.set()` that
 * also deleted the one field none of them models. `UserProfileDiff.kt` names the
 * writers and what each lost.
 *
 * The drift guard at the bottom is what keeps this fixed, in both directions:
 * a field added to [UserProfile] and not to [USER_PROFILE_DIFF_FIELDS] would
 * silently stop saving, and `dashboardWidgetsUpdatedAt` appearing ON the model
 * would put this client back in charge of a server stamp it has no clock for.
 */
class UserProfileDiffTest {

    /** The document as it stood when the phone read it. */
    private val loaded = UserProfile(
        id = "u1",
        uid = "u1",
        email = "nia@tribetails.com",
        displayName = "Nia Okafor",
        themeMode = "DARK",
        navConfig = listOf("home", "schedule"),
        dashboardWidgets = listOf("today:wide"),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-08-01T00:00:00",
    )

    @Test
    fun `an unchanged profile diffs to nothing`() {
        assertEquals(emptyMap<String, Any?>(), userProfileFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `a theme change writes the theme and nothing else`() {
        val changes = userProfileFieldChanges(loaded, loaded.copy(themeMode = "LIGHT"))
        assertEquals(setOf("themeMode"), changes.keys)
        assertEquals("LIGHT", changes["themeMode"])
    }

    /**
     * The reversion this fix exists for. The operator arranged their Home board
     * on the web; the phone still holds the old order. A theme save must not
     * carry that stale array along.
     */
    @Test
    fun `a theme change does not carry a stale dashboard layout along`() {
        val changes = userProfileFieldChanges(loaded, loaded.copy(themeMode = "LIGHT"))
        assertTrue("dashboardWidgets" !in changes.keys)
    }

    /** Clearing a field is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a field cleared to blank is written as blank`() {
        val changes = userProfileFieldChanges(loaded, loaded.copy(title = ""))
        assertEquals(emptyMap<String, Any?>(), changes) // already blank, so no change
        assertEquals(
            mapOf<String, Any?>("displayName" to ""),
            userProfileFieldChanges(loaded, loaded.copy(displayName = "")),
        )
    }

    /** Hiding every nav destination is an edit, and `[]` is the only way to say it. */
    @Test
    fun `navConfig cleared to empty is written as empty`() {
        val changes = userProfileFieldChanges(loaded, loaded.copy(navConfig = emptyList()))
        assertEquals(mapOf<String, Any?>("navConfig" to emptyList<String>()), changes)
    }

    /**
     * The stamps and the document identity are the repository's business, never
     * the diff's. `createdAt` in particular: round-tripping it through a save is
     * how an account's real sign-up date gets replaced by a later one.
     */
    @Test
    fun `stamps and identity never enter the diff`() {
        val changes = userProfileFieldChanges(
            loaded,
            loaded.copy(id = "other", createdAt = "2026-08-09T00:00:00", updatedAt = "later"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    // ── Drift guard ──────────────────────────────────────────────────────────

    @Test
    fun `every model field is covered by the differ`() {
        val modelled = UserProfile::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .filterNot { it in USER_PROFILE_SERVER_OWNED }
            .toSet()

        assertEquals(
            "UserProfile gained or lost a field; update USER_PROFILE_DIFF_FIELDS",
            modelled,
            USER_PROFILE_DIFF_FIELDS.keys,
        )
    }

    /**
     * The other half of the guard. The server's stamp must stay OFF this model:
     * only a write that cannot name a field can be trusted not to change it. If
     * this fails because someone added `dashboardWidgetsUpdatedAt`, the fix is to
     * remove it again, not to relax the list.
     */
    @Test
    fun `the server's own stamp stays off the model and out of the differ`() {
        val modelled = UserProfile::class.java.declaredFields.map { it.name }.toSet()
        for (field in USER_PROFILE_SERVER_WRITTEN) {
            assertTrue("UserProfile must not declare server field $field", field !in modelled)
            assertTrue("the differ must never write server field $field", field !in USER_PROFILE_DIFF_FIELDS)
        }
    }
}
