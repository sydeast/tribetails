package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals

class RouteTest {
    @Test fun topLevel_roundTrips() {
        for (d in Destination.values()) {
            val hash = routeToHash(Route(d))
            assertEquals(Route(d), parseHash(hash), "round-trip failed for $d ($hash)")
        }
    }

    @Test fun home_isDefaultForEmptyOrUnknown() {
        assertEquals(Route(Destination.Home), parseHash(""))
        assertEquals(Route(Destination.Home), parseHash("#/"))
        assertEquals(Route(Destination.Home), parseHash("#/totally-unknown"))
    }

    @Test fun detailRoutes_parseId() {
        assertEquals(Route(Destination.Invoices, detailId = "inv_42"), parseHash("#/invoices/inv_42"))
        assertEquals(Route(Destination.KinTales, detailId = "sess_9"), parseHash("#/kintales/sess_9"))
        assertEquals(Route(Destination.FormSchemas, detailId = "fs_1"), parseHash("#/form-schemas/fs_1"))
    }

    @Test fun mediaDetail_parsesTypeAndId() {
        assertEquals(
            Route(Destination.MediaGallery, detailId = "kin_7", detailType = "kin"),
            parseHash("#/media/kin/kin_7"),
        )
    }

    @Test fun detail_roundTrips() {
        val r = Route(Destination.Invoices, detailId = "inv_42")
        assertEquals(r, parseHash(routeToHash(r)))
        val m = Route(Destination.MediaGallery, detailId = "kin_7", detailType = "kin")
        assertEquals(m, parseHash(routeToHash(m)))
    }
}
