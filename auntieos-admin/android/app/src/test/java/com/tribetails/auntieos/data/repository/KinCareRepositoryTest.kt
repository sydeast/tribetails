package com.tribetails.auntieos.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The [KinCareRepository] wire contract: every pure encoder and decoder the
 * kin-care callables go through. Renamed from AssignAuntiePayloadTest and
 * gathered here by W4-3, absorbing ListStaffDecodeTest, so the contracts sit
 * beside the repo that sends them rather than scattered across the god-file's
 * test files. Same move InvoiceRepositoryTest made in W4-1.
 *
 * These payloads are HAND-MIRRORED against the server zod Args, so these tests
 * pin the exact key set: a key added or dropped here is contract drift the
 * compiler cannot see. Kept pure so they run without Firebase static init.
 */
class KinCareRepositoryTest {

    // ── assignAuntie payload ─────────────────────────────────────────────────
    //
    // The backend schema is `auntieUid: string | null` (not optional), so the
    // key must be present on an unassign and carry an explicit null.

    @Test fun `assign payload carries ids and auntie uid`() {
        val p = assignAuntiePayload("fam1", "batch1", "v1", "u1")
        assertEquals("fam1", p["kinfolkId"])
        assertEquals("batch1", p["batchId"])
        assertEquals("v1", p["visitId"])
        assertEquals("u1", p["auntieUid"])
        assertEquals(4, p.size)
    }

    @Test fun `unassign payload keeps auntieUid key with explicit null`() {
        val p = assignAuntiePayload("fam1", "batch1", "v1", null)
        assertTrue(p.containsKey("auntieUid"))
        assertNull(p["auntieUid"])
        assertEquals("v1", p["visitId"])
    }

    // ── listStaff decode ─────────────────────────────────────────────────────
    //
    // The callable answers { staff: [{ uid, displayName, email }] } and this is
    // what the Assigned Auntie picker renders.

    @Test fun `decodes staff entries with nullable identity fields`() {
        val raw = mapOf(
            "staff" to listOf(
                mapOf("uid" to "u1", "displayName" to "Auntie Dee", "email" to "dee@tribetails.com"),
                mapOf("uid" to "u2", "displayName" to null, "email" to null),
            ),
        )
        val staff = decodeListStaff(raw)
        assertEquals(2, staff.size)
        assertEquals(StaffMember("u1", "Auntie Dee", "dee@tribetails.com"), staff[0])
        assertNull(staff[1].displayName)
        assertNull(staff[1].email)
    }

    @Test fun `drops entries without a uid and non-map junk`() {
        val raw = mapOf(
            "staff" to listOf(
                mapOf("displayName" to "No Uid"),
                mapOf("uid" to "", "displayName" to "Blank Uid"),
                "junk",
                null,
                mapOf("uid" to "u1", "displayName" to "Kept"),
            ),
        )
        val staff = decodeListStaff(raw)
        assertEquals(listOf("u1"), staff.map { it.uid })
    }

    @Test fun `sorts by displayName else uid, case-insensitive`() {
        val raw = mapOf(
            "staff" to listOf(
                mapOf("uid" to "zz", "displayName" to null), // sorts by uid "zz"
                mapOf("uid" to "u2", "displayName" to "bella"),
                mapOf("uid" to "u3", "displayName" to "Auntie Dee"),
            ),
        )
        assertEquals(listOf("u3", "u2", "zz"), decodeListStaff(raw).map { it.uid })
    }

    @Test fun `null or malformed payload decodes to empty roster`() {
        assertTrue(decodeListStaff(null).isEmpty())
        assertTrue(decodeListStaff(mapOf("staff" to "nope")).isEmpty())
        assertTrue(decodeListStaff(emptyMap<String, Any?>()).isEmpty())
    }

    @Test fun `label prefers displayName then email then uid`() {
        assertEquals("Auntie Dee", StaffMember("u1", "Auntie Dee", "d@x.com").label)
        assertEquals("d@x.com", StaffMember("u1", "", "d@x.com").label)
        assertEquals("u1", StaffMember("u1", null, "").label)
    }

    // ── construction ─────────────────────────────────────────────────────────
    @Test
    fun `constructing the repo touches no Firebase singleton`() {
        // The three Firebase handles are lazy PROVIDERS, not eager constructor
        // arguments, so `AuntieOSApp.instance.kinCareRepository` is safe to name
        // as a ViewModel default argument in a Firebase-less Robolectric test.
        // Turning any of them back into an eager `FirebaseFirestore.getInstance()`
        // default would blow up here with "Default FirebaseApp is not
        // initialized" rather than in a screenshot golden three files away.
        //
        // The zero-argument form is the one that has to stay Firebase-free: the
        // default gate is `AuthGate.shared`, which holds its own FirebaseAuth
        // lazily (AuthGateTest pins that half), and this repo adds a FirebaseAuth
        // of its own for the report author stamp. Same invariant W4-1 pinned for
        // InvoiceRepository, with one more handle to get wrong.
        val repo = KinCareRepository()
        assertNotNull(repo)
    }
}
