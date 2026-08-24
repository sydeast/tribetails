@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test

/**
 * The floor, on the target that has no Mapbox SDK at all.
 *
 * Issue #520 put a real basemap under the KinCare route on Android. The point of
 * these is the other half of that design: `jvm` and `js` have no Maps SDK to
 * fall back from, so [RouteCanvas] is their permanent answer, and a kinfolk on
 * either must still see the route drawn the way it always was rather than an
 * empty rectangle. `RouteMapSurfaceTest` covers the Android fallback decision;
 * this covers what the non-Android `actual` actually renders.
 *
 * These run under `:jvmTest`, which is the authoritative task for this module,
 * so they exercise `RouteMapSurface.jvm.kt` for real rather than by inspection.
 * The `js` actual is byte-for-byte the same delegation and is gated by
 * `compileKotlinJs` in CI, there being no js test source set.
 *
 * The assertion is on [ROUTE_CANVAS_TAG] rather than on the frame or the
 * statistics row, because those render whether or not anything was drawn inside
 * them: a surface that quietly produced a blank box would pass a test written
 * against "Distance" and "Pings". The tag is the state carrier that separates
 * the two.
 */
class RouteMapTest {

    private val walk = listOf(
        RoutePoint(lat = 30.2672, lng = -97.7431, t = 1_724_000_000_000),
        RoutePoint(lat = 30.2685, lng = -97.7420, t = 1_724_000_300_000),
        RoutePoint(lat = 30.2699, lng = -97.7402, t = 1_724_000_600_000),
    )

    @Test
    fun the_non_android_surface_draws_the_polyline_rather_than_an_empty_box() = runComposeUiTest {
        setThemedContent { RouteMap(route = walk) }
        waitForIdle()

        onNodeWithTag(ROUTE_CANVAS_TAG).assertIsDisplayed()
    }

    @Test
    fun a_single_ping_still_draws() = runComposeUiTest {
        // A visit that ended after one breadcrumb. The polyline has nothing to
        // join, and the start pin still has to appear somewhere.
        setThemedContent { RouteMap(route = walk.take(1)) }
        waitForIdle()

        onNodeWithTag(ROUTE_CANVAS_TAG).assertIsDisplayed()
    }

    @Test
    fun the_statistics_row_survives_the_move_into_the_expect_actual() = runComposeUiTest {
        // RouteMap's own output, which sits outside the surface and must not
        // have followed the Canvas into the platform split.
        setThemedContent { RouteMap(route = walk) }
        waitForIdle()

        onNodeWithText("DISTANCE").assertIsDisplayed()
        onNodeWithText("DURATION").assertIsDisplayed()
        onNodeWithText("PINGS").assertIsDisplayed()
        onNodeWithText("3").assertIsDisplayed()
    }

    @Test
    fun an_empty_route_renders_nothing_at_all() = runComposeUiTest {
        // Unchanged from before #520: no route means no frame, no statistics and
        // no surface, rather than an empty map waiting for data.
        setThemedContent { RouteMap(route = emptyList()) }
        waitForIdle()

        onNodeWithTag(ROUTE_CANVAS_TAG).assertDoesNotExist()
        onNodeWithText("PINGS").assertDoesNotExist()
    }
}
