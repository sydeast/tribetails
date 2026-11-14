package com.tribetails.auntieos.ui.directory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #2115: every admin Android save of a Kin used to re-point its link to the
 * household's copy at `families/{kinfolkId}/kin/{the admin record id}`. That is
 * right only for a Kin the office made first. A Kin the household added in the
 * portal has its household copy under a different id, so the link now stays as
 * it was loaded.
 */
class FamilyKinPathStampTest {

    @Test
    fun `a Kin the household added keeps its link, whose copy id differs from the admin record id`() {
        assertNull(familyKinPathStamp("admin-k1", "kf1", "families/kf1/kin/portal-7", movedHousehold = false))
    }

    @Test
    fun `a Kin the office made keeps its link too`() {
        assertNull(familyKinPathStamp("k1", "kf1", "families/kf1/kin/k1", movedHousehold = false))
    }

    @Test
    fun `a Kin with no link yet is given one`() {
        assertEquals(
            mapOf("kinfolkId" to "kf1", "familyKinPath" to "families/kf1/kin/k1"),
            familyKinPathStamp("k1", "kf1", "", movedHousehold = false),
        )
        assertEquals(
            mapOf("kinfolkId" to "kf1", "familyKinPath" to "families/kf1/kin/k1"),
            familyKinPathStamp("k1", "kf1", "   ", movedHousehold = false),
        )
    }

    @Test
    fun `a Kin moved to another household is linked under that household`() {
        assertEquals(
            mapOf("kinfolkId" to "kf2", "familyKinPath" to "families/kf2/kin/k1"),
            familyKinPathStamp("k1", "kf2", "families/kf1/kin/k1", movedHousehold = true),
        )
    }

    @Test
    fun `an unknown link, a blank id or a blank household writes nothing`() {
        assertNull(familyKinPathStamp("k1", "kf1", null, movedHousehold = false))
        assertNull(familyKinPathStamp("k1", "kf1", null, movedHousehold = true))
        assertNull(familyKinPathStamp("", "kf1", "", movedHousehold = false))
        assertNull(familyKinPathStamp("k1", "", "", movedHousehold = false))
    }
}
