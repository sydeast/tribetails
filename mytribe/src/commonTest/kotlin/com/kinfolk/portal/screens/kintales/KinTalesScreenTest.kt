@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kintales

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import com.kinfolk.portal.util.clockTime
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class KinTalesScreenTest {

    @Test
    fun empty_rendersEmptyState() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("tales", buildJsonArray {})
            put("hasMore", false)
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No KinTales yet").assertIsDisplayed()
        onNodeWithText("All").assertIsDisplayed()
        onNodeWithText("Notes").assertIsDisplayed()
        onNodeWithText("Gallery").assertIsDisplayed()
    }

    @Test
    fun talesRender_authorBodyAndPhotoBadge() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "Kai played fetch today.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray { add("m1"); add("m2") })
                    put("sentAtMs", 1_700_000_000_000L)
                    put("shared", false)
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Auntie Avery").assertIsDisplayed()
        onNodeWithText("Kai played fetch today.").assertIsDisplayed()
        // The full-gallery control reads "View Gallery (2)" (task-24 follow-up:
        // "N photos" misdescribed a tale whose media includes video, so it no
        // longer says "photos" — matches web's "View Gallery" naming).
        onNodeWithText("View Gallery (2)").assertIsDisplayed()
    }

    @Test
    fun galleryFilter_hidesTextOnlyTales() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-text")
                    put("body", "Just a story.")
                    put("authorDisplayName", "Auntie")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Just a story.").assertIsDisplayed()
        onNodeWithText("Gallery").performClick()
        waitForIdle()
        onNodeWithText("Nothing in Gallery yet").assertIsDisplayed()
    }

    @Test
    fun error_rendersFailureCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinTales", IllegalStateException("server-down"))
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load KinTales").assertIsDisplayed()
    }

    // task-24 (P3): the feed card shows its media up front instead of hiding
    // it one click deep. Tiles are asserted via their testTag rather than by
    // inspecting the async image itself — KinfolkRemoteImage's load state is
    // Coil-network-dependent and out of scope here; the tile container
    // renders synchronously regardless of whether the image ever resolves.

    @Test
    fun thumbStrip_rendersUpToEightTilesInMediaOrder() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-many")
                    put("body", "Twelve photos today.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray { (1..12).forEach { add("m$it") } })
                    put("shared", false)
                    put("thumbs", buildJsonArray {
                        (1..12).forEach { i ->
                            add(buildJsonObject {
                                put("id", "m$i")
                                put("url", "https://cdn.example/m$i.jpg")
                                put("contentType", "image/jpeg")
                            })
                        }
                    })
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onAllNodesWithTag("kinTaleThumbTile").assertCountEquals(8)
    }

    @Test
    fun thumbStrip_onePhotoRendersOneTile() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-one")
                    put("body", "One photo today.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray { add("only") })
                    put("shared", false)
                    put("thumbs", buildJsonArray {
                        add(buildJsonObject {
                            put("id", "only")
                            put("url", "https://cdn.example/only.jpg")
                            put("contentType", "image/jpeg")
                        })
                    })
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onAllNodesWithTag("kinTaleThumbTile").assertCountEquals(1)
    }

    @Test
    fun thumbStrip_videoTileShowsPlayGlyphNotAnImage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-video")
                    put("body", "A video today.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray { add("clip") })
                    put("shared", false)
                    put("thumbs", buildJsonArray {
                        add(buildJsonObject {
                            put("id", "clip")
                            put("url", "https://cdn.example/clip.mp4")
                            put("contentType", "video/mp4")
                        })
                    })
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onAllNodesWithTag("kinTaleThumbTile").assertCountEquals(1)
        onNodeWithText("▶️").assertIsDisplayed()
    }

    @Test
    fun thumbStrip_noMediaRendersNoTilesAtAll() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-none")
                    put("body", "Just a story, no photos.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                    // `thumbs` omitted entirely, same as an older deployed
                    // function that doesn't send it yet — must not crash.
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Just a story, no photos.").assertIsDisplayed()
        onAllNodesWithTag("kinTaleThumbTile").assertCountEquals(0)
    }

    // task-25 (P4): visit facts — arrival/departure times and the checked-only
    // task checklist. A missing time renders nothing for that half (fail-loud:
    // never a fabricated time); the checklist renders checked items only.

    @Test
    fun visitFacts_bothTimesPresent_rendersBoth() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "A fine walk.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                    put("arrivedAtIso", "2026-08-06T14:02:00.000Z")
                    put("departedAtIso", "2026-08-06T14:41:00.000Z")
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        // Computed via the same `clockTime` the component calls, not hardcoded —
        // the rendered hour depends on the test runner's own time zone.
        onNodeWithText(
            "Arrived ${clockTime("2026-08-06T14:02:00.000Z")} · Departed ${clockTime("2026-08-06T14:41:00.000Z")}",
        ).assertIsDisplayed()
    }

    @Test
    fun visitFacts_departureAbsent_showsOnlyArrival() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "A fine walk.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                    put("arrivedAtIso", "2026-08-06T14:02:00.000Z")
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Arrived ${clockTime("2026-08-06T14:02:00.000Z")}").assertIsDisplayed()
    }

    @Test
    fun checklist_checkedItemsRenderAsChips() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "A fine walk.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                    put("checklist", buildJsonArray {
                        add(buildJsonObject { put("key", "peed"); put("text", "Peed") })
                        add(buildJsonObject { put("key", "fed"); put("text", "Fed") })
                    })
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onAllNodesWithTag("kinTaleChecklistChip").assertCountEquals(2)
        onNodeWithText("Peed").assertIsDisplayed()
        onNodeWithText("Fed").assertIsDisplayed()
    }

    @Test
    fun checklist_absent_rendersNoChipsAndNoLabel() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "A fine walk, no checklist.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("A fine walk, no checklist.").assertIsDisplayed()
        onAllNodesWithTag("kinTaleChecklistChip").assertCountEquals(0)
    }
}
