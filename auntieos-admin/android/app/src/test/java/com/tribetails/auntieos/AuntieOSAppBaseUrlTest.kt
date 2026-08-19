package com.tribetails.auntieos

import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.util.baseUrlFlow
import com.tribetails.auntieos.util.dataStore
import com.tribetails.auntieos.util.PrefKeys
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Which base URL the app's repository is built from, and WHEN that is decided.
 *
 * `onCreate` used to build the repository from the default URL and then launch a
 * coroutine on the never-cancelled `appScope` that read the stored URL and
 * reassigned the field. Everything that read `repository` in between — starting
 * with `onCreate` itself — held an instance the app had already decided against.
 * Nothing was visibly broken, because the one in-window reader did not use the
 * n8n binding; the safety was an argument in a comment, and arguments in
 * comments do not survive the next caller.
 *
 * These tests pin the ordering instead of the symptom: the stored URL is
 * resolved by the first read, so there is no window in which a stale instance
 * can be handed out. The last test is about the coroutine rather than the URL.
 * The startup swap ran on `appScope` in every Robolectric test too, writing into
 * a field of an Application that Robolectric replaces per test method — the same
 * shape as the leak fixed in #425 — and removing it means no startup coroutine
 * outlives the Application at all.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieOSAppBaseUrlTest {

    private val app get() = RuntimeEnvironment.getApplication() as AuntieOSApp

    private fun storeBaseUrl(url: String) = runBlocking {
        app.applicationContext.dataStore.edit { it[PrefKeys.BASE_URL] = url }
    }

    @After
    fun clearStoredBaseUrl() = runBlocking {
        // DataStore is a process-wide singleton and this suite is one JVM, so a
        // URL left behind here would be another test class's startup URL.
        app.applicationContext.dataStore.edit { it.remove(PrefKeys.BASE_URL) }
        Unit
    }

    @Test
    fun the_repository_is_built_from_the_stored_url_on_its_very_first_read() {
        storeBaseUrl("https://tunnel.example.com/")

        // The first read of the repository is the one that resolves the URL, so
        // this instance is already the right one rather than a placeholder some
        // later coroutine intends to replace.
        val repository = app.repository

        assertEquals("https://tunnel.example.com/", app.activeBaseUrl)
        assertSame(
            "the repository must not be swapped after it has been handed out",
            repository,
            app.repository,
        )
    }

    @Test
    fun a_stale_legacy_url_is_migrated_before_the_repository_exists() {
        storeBaseUrl("https://${RetrofitClient.LEGACY_N8N_HOST}/")

        app.repository

        assertEquals(RetrofitClient.DEFAULT_BASE_URL, app.activeBaseUrl)
        assertEquals(
            "the migration must be persisted, not re-decided on every launch",
            RetrofitClient.DEFAULT_BASE_URL,
            runBlocking { app.applicationContext.baseUrlFlow().first() },
        )
    }

    @Test
    fun with_nothing_stored_the_app_uses_the_default_url() {
        assertEquals(RetrofitClient.DEFAULT_BASE_URL, app.activeBaseUrl)
    }

    @Test
    fun the_operator_changing_the_url_in_settings_still_swaps_the_repository() {
        val before = app.repository

        // What SettingsViewModel.saveBaseUrl does once the entry validates.
        app.rebuildRepository("https://tunnel.example.com/")

        assertEquals("https://tunnel.example.com/", app.activeBaseUrl)
        assertNotSame(before, app.repository)
    }

    @Test
    fun startup_leaves_no_coroutine_running_on_the_application_scope() {
        // `appScope` has no cancellation, so anything started from onCreate runs
        // until the process ends — which under Robolectric means until some
        // later, unrelated test is running. Startup now launches nothing.
        val running = app.appScope.coroutineContext.job.children.toList()
        assertTrue(
            "app startup left $running running on a scope nothing cancels",
            running.isEmpty(),
        )
    }
}
