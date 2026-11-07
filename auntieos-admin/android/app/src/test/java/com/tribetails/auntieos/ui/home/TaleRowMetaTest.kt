package com.tribetails.auntieos.ui.home

import com.tribetails.auntieos.data.model.Draft
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1598 ruling (2026-11-05): a written but unsent KinTale is a "Draft"
 * everywhere, Home included. Home's "KinTales pending" rows printed the stored
 * status, so a May-era draft read PENDING and a generate.js one GENERATED,
 * while KinTales filed both under Drafts.
 */
class TaleRowMetaTest {

    @Test
    fun `a pending draft reads DRAFT, not PENDING`() {
        val d = Draft(id = "a", status = "pending", kinfolkName = "Robyn", createdOn = "2026-05-23T22:23:00Z")
        assertEquals("DRAFT · Robyn · 2026-05-23", taleRowMeta(d))
    }

    @Test
    fun `a generated draft reads DRAFT, not GENERATED`() {
        val d = Draft(id = "b", status = "generated", kinfolkName = "Olivia", createdOn = "")
        assertEquals("DRAFT · Olivia", taleRowMeta(d))
    }
}
