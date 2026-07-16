package com.tribetails.auntieos.web.screens.media

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.MediaFile
import kotlin.test.Test
import kotlin.test.assertEquals

class GalleryFiltersTest {
    private fun media(
        id: String,
        kinfolk: String = "",
        type: String = "IMAGE",
        at: String = "2026-06-01",
        tagged: List<String> = emptyList(),
    ) = MediaFile(_id = id, kinfolkId = kinfolk, fileType = type, uploadedAt = at, taggedKinIds = tagged)

    private val all = listOf(
        media("a", kinfolk = "k1", type = "IMAGE", at = "2026-06-05"),
        media("b", kinfolk = "k1", type = "VIDEO", at = "2026-05-20"),
        media("c", kinfolk = "k2", type = "IMAGE", at = "2026-06-02"),
    )

    @Test fun filtersByKinfolk() {
        assertEquals(listOf("a", "b"), filterGalleryMedia(all, GalleryFilter(kinfolkId = "k1")).map { it._id })
    }

    @Test fun filtersByTypeAndSortsNewestFirst() {
        // a (06-05) sorts before c (06-02); b is a VIDEO and excluded.
        assertEquals(listOf("a", "c"), filterGalleryMedia(all, GalleryFilter(fileType = "IMAGE")).map { it._id })
    }

    @Test fun filtersByMonth() {
        assertEquals(listOf("b"), filterGalleryMedia(all, GalleryFilter(monthPrefix = "2026-05")).map { it._id })
    }

    @Test fun monthsDistinctNewestFirst() {
        assertEquals(listOf("2026-06", "2026-05"), galleryMonths(all))
    }

    @Test fun kinfolkIdsDistinct() {
        assertEquals(listOf("k1", "k2"), galleryKinfolkIds(all))
    }

    @Test fun fileTypesDistinctSorted() {
        assertEquals(listOf("IMAGE", "VIDEO"), galleryFileTypes(all))
    }

    @Test fun taggedNamesResolveAndDropUnknown() {
        val m = media("x", tagged = listOf("kin1", "ghost"))
        val byId = mapOf("kin1" to Kin(_id = "kin1", name = "Waddles"))
        assertEquals(listOf("Waddles"), taggedKinNames(m, byId))
    }

    @Test fun taggableKinScopedToKinfolkWhenKnown() {
        val kin = listOf(
            Kin(_id = "1", kinfolkId = "k1", name = "A"),
            Kin(_id = "2", kinfolkId = "k2", name = "B"),
        )
        assertEquals(listOf("1"), taggableKin(media("x", kinfolk = "k1"), kin).map { it._id })
    }

    @Test fun taggableKinAllWhenNoKinfolk() {
        val kin = listOf(Kin(_id = "1", kinfolkId = "k1"), Kin(_id = "2", kinfolkId = "k2"))
        assertEquals(2, taggableKin(media("x", kinfolk = ""), kin).size)
    }
}
