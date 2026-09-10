package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.ui.Screen
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * "New KinTale" on the household profile (#552), removed by #676.
 *
 * The mock (`auntieos-admin/ui-ideas/auntieos-kinfolk-profile-2026-05-27.html`,
 * the hero's `act primary`) put this button here, and #407 fixed every other
 * difference on both surfaces but not this one. #676 (walk admin-2026-09-10)
 * closed that gap the other way: the operator ruled a KinTale is only ever
 * started from a KinCare session, so the profile's hero no longer offers this
 * entry point at all, and `KinfolkProfileScreen` no longer takes an
 * `onNewKinTale` callback. This file used to render the screen and click the
 * button; that test is gone with the button.
 *
 * What is still pinned is [Screen.NewKinTale]'s own route helper, unrelated to
 * whether anything currently navigates to it.
 */
class KinfolkProfileNewKinTaleTest {

    @Test
    fun `the New KinTale route carries the household, and omits it when there is none`() {
        assertEquals("kintale_new?kinfolkId=kf1", Screen.NewKinTale.createRoute("kf1"))
        assertEquals("kintale_new", Screen.NewKinTale.createRoute(null))
        assertEquals("kintale_new", Screen.NewKinTale.createRoute(""))
    }
}
