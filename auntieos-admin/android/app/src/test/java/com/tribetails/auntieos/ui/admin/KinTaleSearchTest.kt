package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareReport
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** KinTale list-search predicate (spec 09 item 2): kinfolk name, service, body. */
class KinTaleSearchTest {

    private val report = KinCareReport(
        kinfolkName = "Wanda Thorne",
        serviceType = "Dog Walking",
        bodyCopy = "Biscuit had a great walk by the creek.",
    )

    @Test
    fun blankQueryMatchesEverything() = assertTrue(matchesSearch(report, "   "))

    @Test
    fun matchesKinfolkServiceAndBodyCaseInsensitive() {
        assertTrue(matchesSearch(report, "wanda"))
        assertTrue(matchesSearch(report, "WALKING"))
        assertTrue(matchesSearch(report, "creek"))
    }

    @Test
    fun nonMatchIsFiltered() = assertFalse(matchesSearch(report, "zzz-nope"))
}
