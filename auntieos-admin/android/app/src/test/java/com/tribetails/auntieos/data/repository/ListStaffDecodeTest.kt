package com.tribetails.auntieos.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure decode contract for the listStaff callable payload that
 * AuntieRepository.listStaff consumes: { staff: [{ uid, displayName, email }] }.
 * Kept pure so it is testable without Firebase static init.
 */
class ListStaffDecodeTest {

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
}
