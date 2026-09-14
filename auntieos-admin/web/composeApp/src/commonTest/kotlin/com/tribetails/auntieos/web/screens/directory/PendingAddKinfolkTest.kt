package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.Kinfolk
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** #890: the app-level store of a household Add created whose contact has not saved. */
class PendingAddKinfolkTest {

    @AfterTest
    fun tearDown() = PendingAddKinfolk.clearAll()

    private fun pending(id: String = "kf-890", first: String = "Dana", last: String = "Mercer") = PendingKinfolk(
        kinfolkId = id,
        household = Kinfolk(firstName = first, lastName = last),
        contacts = listOf(EmergencyContactDraft("Rae Park", "8055550199")),
    )

    @Test
    fun keepsOnePendingHouseholdPerOperator() {
        PendingAddKinfolk.keep("op-1", pending())
        assertEquals("kf-890", PendingAddKinfolk.get("op-1")?.kinfolkId)
        assertNull(PendingAddKinfolk.get("op-2"))
    }

    @Test
    fun keepingAgainReplacesIt() {
        PendingAddKinfolk.keep("op-1", pending())
        PendingAddKinfolk.keep("op-1", pending().copy(contacts = listOf(EmergencyContactDraft("Lee", "8055550177"))))
        assertEquals("Lee", PendingAddKinfolk.get("op-1")?.contacts?.single()?.name)
    }

    @Test
    fun clearForgetsOnlyThatOperator() {
        PendingAddKinfolk.keep("op-1", pending())
        PendingAddKinfolk.keep("op-2", pending(id = "kf-other"))
        PendingAddKinfolk.clear("op-1")
        assertNull(PendingAddKinfolk.get("op-1"))
        assertEquals("kf-other", PendingAddKinfolk.get("op-2")?.kinfolkId)
    }

    @Test
    fun namesTheHouseholdOrSaysThisHousehold() {
        assertEquals("Dana Mercer", pendingHouseholdName(pending()))
        assertEquals("this household", pendingHouseholdName(pending(first = " ", last = "")))
    }
}
