package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Stage 0C / Phase 2: global-search navigation deep-links into the Directory.
 * Pin the kinfolk-profile and kin-under-kinfolk hash contracts so back/forward
 * and shared links resolve to the same target the search dropdown opens.
 */
class DirectoryDeepLinkRouteTest {

    @Test fun kinfolkProfileDeepLinkRoundTrips() {
        val route = Route(Destination.Directory, detailId = "kf1")
        assertEquals("#/directory/kf1", routeToHash(route))
        val parsed = parseHash("#/directory/kf1")
        assertEquals(Destination.Directory, parsed.dest)
        assertEquals("kf1", parsed.detailId)
        assertEquals(null, parsed.detailType)
    }

    @Test fun kinUnderKinfolkDeepLinkRoundTrips() {
        val route = Route(Destination.Directory, detailId = "kf1", detailType = "kn9")
        assertEquals("#/directory/kf1/kn9", routeToHash(route))
        val parsed = parseHash("#/directory/kf1/kn9")
        assertEquals(Destination.Directory, parsed.dest)
        assertEquals("kf1", parsed.detailId)
        assertEquals("kn9", parsed.detailType)
    }

    @Test fun bareDirectorySlugIsListView() {
        val parsed = parseHash("#/directory")
        assertEquals(Destination.Directory, parsed.dest)
        assertEquals(null, parsed.detailId)
        assertEquals(null, parsed.detailType)
    }
}
