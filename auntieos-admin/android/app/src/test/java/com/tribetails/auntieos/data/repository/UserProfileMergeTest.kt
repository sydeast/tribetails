package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.model.createdAtIso
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The android app is not the author of `users/{uid}.dashboardWidgetsUpdatedAt`,
 * and must not be able to delete it.
 *
 * `mytribe/functions/src/admin/saveDashboardLayout.ts` stamps that field with a
 * `FieldValue.serverTimestamp()` every time an operator rearranges their Home
 * board, on any surface. [UserProfile] has never declared it, so the bare
 * `.set(profile)` this replaced - no merge option, a full document REPLACE -
 * deleted it on every theme change, nav-bar rearrangement and avatar upload made
 * on the phone.
 *
 * Three writers share this document and the other two both merge: the React
 * account editor (`auntieos-admin/src/api/accountWrite.ts`, six fields), the
 * dashboard callable, and `setMediaProfilePhoto` (`photoUrl` plus a
 * serverTimestamp `updatedAt`). `UserProfileDiff.kt` sets out what the
 * whole-model write cost each of them.
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
 * shape as KinCareReportReconcileMergeTest.
 */
class UserProfileMergeTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** The write the repo actually issued, and whether it asked Firestore to merge. */
    private data class RecordedWrite(val payload: Any, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    private fun repo(uid: String): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        every { firestore.collection("users") } returns collection
        every { collection.document(uid) } returns docRef
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
     * data class, blank ones included - and, by omission, exactly the set of
     * server-written fields a bare `set()` destroys.
     */
    private fun writtenKeys(): Set<String> {
        val payload = requireNotNull(recorded) { "the repository issued no document write at all" }.payload
        return if (payload is Map<*, *>) {
            payload.keys.map { it.toString() }.toSet()
        } else {
            payload.javaClass.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet()
        }
    }

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

    /** The operator's document as the callables actually leave it. */
    private fun storedUserDoc(): Map<String, Any> = mapOf(
        "uid" to "u1",
        "displayName" to "Nia Okafor",
        "themeMode" to "DARK",
        "dashboardWidgets" to listOf("today:wide", "expirations:compact"),
        // Stamped by saveDashboardLayout. Not on UserProfile, by design.
        "dashboardWidgetsUpdatedAt" to "2026-08-01T00:00:00Z",
    )

    private val loaded = UserProfile(
        id = "u1",
        uid = "u1",
        displayName = "Nia Okafor",
        themeMode = "DARK",
        dashboardWidgets = listOf("today:wide", "expirations:compact"),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-08-01T00:00:00",
    )

    // ── the premise: the client cannot name this field ────────────────────────

    @Test
    fun `UserProfile declares none of the server-written fields`() {
        val keys = UserProfile::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()
        // If this ever fails the fix went the wrong way. This client has no clock
        // the server trusts, so declaring the stamp could only write a client
        // instant over a server one, or freeze it at whatever was read.
        assertTrue("dashboardWidgetsUpdatedAt" !in keys)
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("themeMode" in keys)
        assertTrue("dashboardWidgets" in keys)
    }

    // ── the defect ────────────────────────────────────────────────────────────

    @Test
    fun `changing the theme does not erase the callable's dashboard stamp`() {
        val result = runBlocking {
            repo("u1").saveUserProfile(loaded, loaded.copy(themeMode = "LIGHT"))
        }

        assertTrue(result.isSuccess)
        assertEquals("2026-08-01T00:00:00Z", serverDocAfterWrite(storedUserDoc())["dashboardWidgetsUpdatedAt"])
    }

    /**
     * The second loss, the one merge alone would leave open. The operator
     * arranges their Home board on the web, then changes the theme on the phone.
     * The phone's copy of `dashboardWidgets` is stale, and writing it back is
     * what made the web layout snap back.
     */
    @Test
    fun `changing the theme writes only the theme`() {
        runBlocking {
            repo("u1").saveUserProfile(loaded, loaded.copy(themeMode = "LIGHT"))
        }.getOrThrow()

        assertEquals(setOf("themeMode", "updatedAt"), writtenKeys())
    }

    /** The nav editor owns one field, and must reach exactly one. */
    @Test
    fun `saving the nav bar writes only navConfig`() {
        runBlocking {
            repo("u1").saveUserProfile(loaded, loaded.copy(navConfig = listOf("home", "schedule|Diary")))
        }.getOrThrow()

        assertEquals(setOf("navConfig", "updatedAt"), writtenKeys())
        assertEquals("2026-08-01T00:00:00Z", serverDocAfterWrite(storedUserDoc())["dashboardWidgetsUpdatedAt"])
    }

    @Test
    fun `a field cleared by the operator still reaches the server as cleared`() {
        // The diff must not become a way to silence a real edit.
        runBlocking {
            repo("u1").saveUserProfile(loaded, loaded.copy(displayName = ""))
        }.getOrThrow()

        assertEquals("", (requireNotNull(recorded).payload as Map<*, *>)["displayName"])
    }

    @Test
    fun `the save stamps updatedAt rather than round-tripping the read value`() {
        runBlocking {
            repo("u1").saveUserProfile(loaded, loaded.copy(themeMode = "LIGHT"))
        }.getOrThrow()

        val stamp = (requireNotNull(recorded).payload as Map<*, *>)["updatedAt"] as String
        assertTrue(stamp != "2026-08-01T00:00:00")
    }

    /**
     * Pressing Save on an untouched form is something an operator really does.
     * It must not move the stamp and claim an edit that never happened, and it
     * must not report a failure either: the profile does hold what they asked
     * for.
     */
    @Test
    fun `a save that changed nothing is a success that writes nothing`() {
        val result = runBlocking { repo("u1").saveUserProfile(loaded, loaded.copy()) }

        assertTrue(result.isSuccess)
        assertNull(recorded)
    }

    // ── the case where a whole-document write IS correct ──────────────────────

    /**
     * A first sign-in has no `users/{uid}` document. There is nothing to clobber
     * and no server field to delete, so the whole model is written - and it must
     * be, or a brand-new profile would save only the fields that happen to
     * differ from a Kotlin default.
     */
    @Test
    fun `a profile with no stored document is created whole`() {
        val fresh = UserProfile(uid = "u1", email = "nia@tribetails.com", themeMode = "DARK")

        runBlocking { repo("u1").saveUserProfile(null, fresh) }.getOrThrow()

        val write = requireNotNull(recorded)
        assertTrue("a create must not be a merge patch", !write.merge)
        assertTrue(write.payload is UserProfile)
        assertTrue("email" in writtenKeys())
        assertTrue("themeMode" in writtenKeys())
    }

    @Test
    fun `a create stamps createdAt when the profile carries none`() {
        runBlocking {
            repo("u1").saveUserProfile(null, UserProfile(uid = "u1"))
        }.getOrThrow()

        val written = requireNotNull(recorded).payload as UserProfile
        assertTrue(written.createdAtIso().isNotBlank())
        assertEquals("u1", written.id)
    }

    @Test
    fun `a blank uid is refused rather than written to a document named empty`() {
        val result = runBlocking { repo("").saveUserProfile(null, UserProfile()) }
        assertTrue(result.isFailure)
        assertNull(recorded)
    }
}
