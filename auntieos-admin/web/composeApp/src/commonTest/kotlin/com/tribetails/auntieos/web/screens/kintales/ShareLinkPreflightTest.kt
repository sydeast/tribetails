package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.KinCareReport
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure tests for [shareLinkPreflightError], the fail-loud guard the KinTale share
 * action runs before calling createShareLink. A link can only be minted for a SENT
 * report that carries both routing keys (a saved id + the owning kinfolkId).
 */
class ShareLinkPreflightTest {

    private fun sent() = KinCareReport(
        _id = "rep1",
        kinfolkId = "kf1",
        status = "SENT",
    )

    @Test
    fun sentReportWithKeysIsShareable() {
        assertNull(shareLinkPreflightError(sent()))
    }

    @Test
    fun draftIsNotShareable() {
        val err = shareLinkPreflightError(sent().copy(status = "DRAFT"))
        assertTrue(err != null && err.contains("sent", ignoreCase = true))
    }

    @Test
    fun blankIdIsNotShareable() {
        val err = shareLinkPreflightError(sent().copy(_id = ""))
        assertTrue(err != null && err.contains("saved", ignoreCase = true))
    }

    @Test
    fun blankKinfolkIsNotShareable() {
        val err = shareLinkPreflightError(sent().copy(kinfolkId = ""))
        assertTrue(err != null && err.contains("kinfolk", ignoreCase = true))
    }
}
