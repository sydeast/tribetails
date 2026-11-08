package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.ui.admin.ServiceCatalog
import org.junit.Assert.assertEquals
import org.junit.Test

/** #1592: the KinTale session picker names the KinCare, the web `KinTaleCompose` picker rule. */
class SessionPickServiceNameTest {
    private val catalog = ServiceCatalog(mapOf("Long walk" to "45"), mapOf("Long walk" to "60"))
    private val session = KinCareSession(id = "s1", kinfolkName = "The Whitfields", serviceType = "visit_60")

    @Test fun `the scoped headline is the KinCare name`() {
        assertEquals("Long walk", sessionPickPrimaryLabel(session, showHousehold = false, catalog = catalog))
    }

    @Test fun `the unscoped second line names the KinCare after the date`() {
        assertEquals(true, sessionPickMetaLabel(session, showHousehold = true, catalog = catalog).endsWith("  Long walk"))
    }

    @Test fun `a blank service still reads Visit`() {
        assertEquals("Visit", sessionPickPrimaryLabel(session.copy(serviceType = ""), showHousehold = false, catalog = catalog))
    }
}
