package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kinfolk
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1602: Fix Backlog 4.8/4.9 and punchlist K2 ordered Preferred contact and
 * Best time to reach off the household profile; Android still showed Best
 * time to reach. Both fields stay on the record.
 */
class KinfolkProfileContactTest {

    @Test
    fun theContactPanelShowsNeitherPreferredContactNorBestTime() {
        val kinfolk = Kinfolk(
            phoneNumber = "5125550100",
            preferredContactMethod = "Text",
            bestTimeToContact = "Evenings",
        )
        val labels = contactFields(kinfolk).map { it.label }
        assertFalse(labels.contains("Best time to reach"))
        assertFalse(labels.any { it.startsWith("Preferred contact") })
        assertFalse(contactFields(kinfolk).any { it.value == "Evenings" })
        assertTrue(labels.contains("Phone"))
    }
}
