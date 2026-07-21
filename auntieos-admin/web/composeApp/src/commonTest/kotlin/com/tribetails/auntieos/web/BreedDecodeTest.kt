package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.decodeBreedLists
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class BreedDecodeTest {

    @Test fun decodesDogAndCatArrays() {
        val r = decodeBreedLists("""{"dogBreeds":["Pug","Beagle"],"catBreeds":["Siamese"]}""")
        assertEquals(listOf("Pug", "Beagle"), r.dogBreeds)
        assertEquals(listOf("Siamese"), r.catBreeds)
    }

    @Test fun missingArrays_decodeEmpty_noFabrication() {
        val r = decodeBreedLists("{}")
        assertEquals(emptyList(), r.dogBreeds)
        assertEquals(emptyList(), r.catBreeds)
    }

    @Test fun malformedJson_throws() {
        assertFailsWith<Exception> { decodeBreedLists("not json") }
    }
}
