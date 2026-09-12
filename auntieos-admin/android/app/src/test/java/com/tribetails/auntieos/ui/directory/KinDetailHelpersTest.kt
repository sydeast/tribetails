package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.domain.coversKin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kin detail screen's pure text, and the join that narrows a household's
 * feeds to one pet. Kept away from the composable so every branch is reachable
 * without a screen.
 *
 * The web twin is `src/screens/KinView.tsx` (`kinHeroLine`, `sexLine`,
 * `checklistLines`) and `src/lib/kinfolkProfileFeeds.ts` (`coversKin`). The two
 * surfaces must not describe the same pet differently.
 */
class KinDetailHelpersTest {

    private fun kin(
        species: String = "Dog",
        breed: String = "",
        age: String = "",
        sex: String = "",
        spayedNeutered: Boolean = false,
        weight: String = "",
        colorMarkings: String = "",
    ) = Kin(
        id = "k1",
        name = "Biscuit",
        species = species,
        breed = breed,
        age = age,
        sex = sex,
        spayedNeutered = spayedNeutered,
        weight = weight,
        colorMarkings = colorMarkings,
    )

    @Test
    fun `the hero line reads the way the mock writes it`() {
        assertEquals(
            "Labrador Retriever · 5 yrs · neutered male · 68 lbs",
            kinHeroLine(
                kin(
                    breed = "Labrador Retriever",
                    age = "5",
                    sex = "Male",
                    spayedNeutered = true,
                    weight = "68 lbs",
                ),
            ),
        )
    }

    /** Breed leads; species stands in only when there is no breed on file. */
    @Test
    fun `species stands in when no breed is known`() {
        assertEquals("Dog · 3 yrs", kinHeroLine(kin(species = "Dog", age = "3")))
    }

    /** Blanks DROP OUT, rather than leaving a dangling separator. */
    @Test
    fun `an almost empty pet still reads as one line`() {
        assertEquals("Dog", kinHeroLine(kin()))
    }

    @Test
    fun `colour and markings ride at the end`() {
        assertEquals(
            "Tabby · brindle, white chest",
            kinHeroLine(kin(species = "Cat", breed = "Tabby", colorMarkings = "brindle, white chest")),
        )
    }

    @Test
    fun `an unaltered pet keeps its own wording`() {
        assertEquals("Female", sexLine("Female", spayedNeutered = false))
        assertEquals("", sexLine("", spayedNeutered = false))
    }

    @Test
    fun `spayed and neutered are spelled out`() {
        assertEquals("spayed female", sexLine("Female", spayedNeutered = true))
        assertEquals("neutered male", sexLine("male", spayedNeutered = true))
    }

    /** A sex the two words do not fit keeps its own and takes the flag after it. */
    @Test
    fun `an unrecognised sex takes the flag after it`() {
        assertEquals("Unknown · spayed / neutered", sexLine("Unknown", spayedNeutered = true))
        assertEquals("spayed / neutered", sexLine("  ", spayedNeutered = true))
    }

    @Test
    fun `the legacy checklist splits on lines and drops the blanks`() {
        assertEquals(
            listOf("Fresh water", "Harness, not collar", "Lock the side gate"),
            checklistLines("Fresh water\n\n  Harness, not collar  \r\n\nLock the side gate\n"),
        )
        assertEquals(emptyList<String>(), checklistLines("   \n\n"))
    }

    // ── coversKin ────────────────────────────────────────────────────────────

    @Test
    fun `a row that names this pet covers it`() {
        assertTrue(coversKin(listOf("k1", "k2"), "k1"))
    }

    @Test
    fun `a row that names other pets does not cover this one`() {
        assertFalse(coversKin(listOf("k2", "k3"), "k1"))
    }

    /**
     * R1: an empty `kinIds` never meant "nobody". A pre-roster row names no pets
     * at all, and dropping it would empty a pet's history for a bookkeeping
     * reason.
     */
    @Test
    fun `a row that names no pets covers every pet`() {
        assertTrue(coversKin(emptyList(), "k1"))
    }
}

/**
 * The route both entry points navigate to: the Directory's Kin tab
 * (`DirectoryScreen.onKinClick`) and the household profile's Kin card
 * (`KinfolkProfileScreen.onOpenKin`). Both used to go to `edit_kin/{kinId}`,
 * which is now what the screen's own "Edit kin" opens.
 */
class KinDetailRouteTest {

    @Test
    fun `the kin detail route carries the pet's document id`() {
        assertEquals("kin_detail/k1", com.tribetails.auntieos.ui.Screen.KinDetail.createRoute("k1"))
        assertEquals("kin_detail/{kinId}", com.tribetails.auntieos.ui.Screen.KinDetail.route)
    }

    /** The editor is still its own route, reached FROM the detail screen. */
    @Test
    fun `the edit route is unchanged`() {
        assertEquals("edit_kin/k1", com.tribetails.auntieos.ui.Screen.EditKin.createRoute("k1"))
    }
}
