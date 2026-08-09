package com.tribetails.auntieos.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android's half of "a household is a place you can navigate to".
 *
 * The web admin used to open the household profile as local state under an
 * unchanged `/directory`, so it was not linkable and Back left the screen.
 * Android never had that defect: `DirectoryScreen`'s `onKinfolkClick` pushes
 * `Screen.KinfolkProfile.createRoute(id)` and the profile pushes
 * `Screen.HouseholdMembers.createRoute(...)`, so each level is its own back
 * stack destination. These tests pin the property that makes that true, which
 * is that every level carries its own identity in its route.
 *
 * Collapsing either destination back to a parameterless route, or dropping the
 * name encoding, turns "restore this household" into "restore whatever the
 * screen happened to hold", and both are one edit away in `Navigation.kt`.
 */
class DirectoryRouteTest {

    @Test
    fun profile_route_declares_a_household_argument() {
        assertTrue(
            "KinfolkProfile must be per-household, not a single shared destination",
            Screen.KinfolkProfile.route.contains("{id}"),
        )
        assertEquals("kinfolk_profile/e2e-kf-1", Screen.KinfolkProfile.createRoute("e2e-kf-1"))
    }

    @Test
    fun two_households_are_two_destinations() {
        assertNotEquals(
            Screen.KinfolkProfile.createRoute("e2e-kf-1"),
            Screen.KinfolkProfile.createRoute("e2e-kf-2"),
        )
    }

    @Test
    fun members_route_is_its_own_destination_below_the_profile() {
        assertTrue(Screen.HouseholdMembers.route.contains("{kinfolkId}"))
        assertNotEquals(Screen.KinfolkProfile.route, Screen.HouseholdMembers.route)
        assertEquals(
            "household_members/kf1/Wanda+Thorne",
            Screen.HouseholdMembers.createRoute("kf1", "Wanda Thorne"),
        )
    }

    /**
     * The household name is free text. `Navigation.kt` decodes it with
     * `URLDecoder`, so the builder has to encode it: an unencoded "Fairweather
     * & Okonkwo" would truncate the path at the ampersand and the members
     * screen would open titled with half a household.
     */
    @Test
    fun members_route_survives_a_name_with_path_characters() {
        val name = "Fairweather & Okonkwo"
        val route = Screen.HouseholdMembers.createRoute("kf1", name)
        assertTrue(route.startsWith("household_members/kf1/"))
        val encoded = route.removePrefix("household_members/kf1/")
        assertEquals(name, java.net.URLDecoder.decode(encoded, "UTF-8"))
    }

    /**
     * The notification deep link and a Directory tap must land on the SAME
     * destination, or "open linked item" silently builds a second profile route
     * that the graph does not declare.
     */
    @Test
    fun the_notification_deep_link_resolves_to_the_same_profile_route() {
        assertEquals(
            Screen.KinfolkProfile.createRoute("kf1"),
            notificationTargetRoute("kinfolk", "kf1"),
        )
    }
}
