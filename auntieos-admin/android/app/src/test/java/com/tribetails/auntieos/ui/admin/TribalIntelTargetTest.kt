package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.TrainingDocument
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The three Tribal Intel targets (issue #393), Android side.
 *
 * Mirrors `auntieos-admin/src/lib/tribalIntelFormat.test.ts` case for case, so a
 * divergence between the two clients fails a test on the client that drifted
 * rather than showing up as two different words for one entry.
 */
class TribalIntelTargetTest {

    private val roster = listOf(
        Kinfolk(id = "kf1", firstName = "Jane", lastName = "Halbrook"),
        Kinfolk(id = "kf2", firstName = "Sam", lastName = ""),
    )
    private val pets = listOf(
        Kin(id = "k9", kinfolkId = "kf1", name = "Rufus"),
        Kin(id = "k10", kinfolkId = "kf1", name = ""),
    )

    private fun doc(
        targetType: String = "",
        targetKinfolkId: String = "",
        targetKinId: String = "",
        kinfolkRef: String = "",
    ) = TrainingDocument(
        id = "d1",
        targetType = targetType,
        targetKinfolkId = targetKinfolkId,
        targetKinId = targetKinId,
        kinfolkRef = kinfolkRef,
    )

    // ── classification ───────────────────────────────────────────────────

    @Test
    fun `reads a HOUSEHOLD entry as the household it names`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, "kf1"),
            tribalIntelTarget(doc(targetType = "HOUSEHOLD", targetKinfolkId = "kf1")),
        )
    }

    @Test
    fun `reads a KINFOLK entry as one human client, not the whole house`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.KINFOLK, "kf1"),
            tribalIntelTarget(doc(targetType = "KINFOLK", targetKinfolkId = "kf1")),
        )
    }

    @Test
    fun `reads a KIN entry as the one animal it names`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.KIN, "k9"),
            tribalIntelTarget(doc(targetType = "KIN", targetKinfolkId = "kf1", targetKinId = "k9")),
        )
    }

    @Test
    fun `is case- and whitespace-insensitive about the stored text`() {
        assertEquals(
            TribalIntelTargetKind.KINFOLK,
            tribalIntelTarget(doc(targetType = " kinfolk ", targetKinfolkId = "kf1")).kind,
        )
        assertEquals(
            TribalIntelTargetKind.KIN,
            tribalIntelTarget(doc(targetType = "kin", targetKinfolkId = "kf1", targetKinId = "k9")).kind,
        )
    }

    @Test
    fun `defaults a legacy entry with no target type to the household it is filed under`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, "demo-family-002"),
            tribalIntelTarget(doc(kinfolkRef = "demo-family-002")),
        )
    }

    @Test
    fun `defaults an unrecognized target type to household rather than guessing`() {
        assertEquals(
            TribalIntelTargetKind.HOUSEHOLD,
            tribalIntelTarget(doc(targetType = "FAMILY", targetKinfolkId = "kf1")).kind,
        )
    }

    @Test
    fun `falls back to household for a KIN entry that names no kin`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, "kf1"),
            tribalIntelTarget(doc(targetType = "KIN", targetKinfolkId = "kf1", targetKinId = "  ")),
        )
    }

    @Test
    fun `falls back to household for a KINFOLK entry that names nobody`() {
        assertEquals(
            TribalIntelTarget(TribalIntelTargetKind.HOUSEHOLD, ""),
            tribalIntelTarget(doc(targetType = "KINFOLK")),
        )
    }

    @Test
    fun `prefers targetKinfolkId over the legacy kinfolkRef when both are present`() {
        assertEquals(
            "kf1",
            tribalIntelTarget(doc(targetType = "HOUSEHOLD", targetKinfolkId = "kf1", kinfolkRef = "stale")).id,
        )
    }

    // ── wording, byte-identical to the web admin ─────────────────────────

    @Test
    fun `offers exactly household, kinfolk and kin, widest first`() {
        assertEquals(listOf("HOUSEHOLD", "KINFOLK", "KIN"), TRIBAL_INTEL_TARGET_TYPES)
        assertEquals("HOUSEHOLD", TRIBAL_INTEL_DEFAULT_TARGET_TYPE)
    }

    @Test
    fun `names each target with the operator's own word`() {
        assertEquals("Household", targetTypeLabel("HOUSEHOLD"))
        assertEquals("Kinfolk", targetTypeLabel("KINFOLK"))
        assertEquals("Kin", targetTypeLabel("KIN"))
    }

    @Test
    fun `explains the three targets in the same sentence the web admin uses`() {
        assertEquals(
            "Household is everyone under one roof. Kinfolk is one person. Kin is one animal.",
            TRIBAL_INTEL_TARGET_HINT,
        )
    }

    // ── name resolution ──────────────────────────────────────────────────

    @Test
    fun `names a household by the surname it shares`() {
        assertEquals(
            "Household: the Halbrooks",
            tribalIntelTargetLabel(doc(targetType = "HOUSEHOLD", targetKinfolkId = "kf1"), roster, pets),
        )
    }

    @Test
    fun `names a kinfolk by their own name, never as a household`() {
        assertEquals(
            "Kinfolk: Jane Halbrook",
            tribalIntelTargetLabel(doc(targetType = "KINFOLK", targetKinfolkId = "kf1"), roster, pets),
        )
    }

    @Test
    fun `names a kin by their own name`() {
        assertEquals(
            "Kin: Rufus",
            tribalIntelTargetLabel(
                doc(targetType = "KIN", targetKinfolkId = "kf1", targetKinId = "k9"),
                roster,
                pets,
            ),
        )
    }

    @Test
    fun `pluralizes a sibilant surname without doubling the s`() {
        assertEquals("the Brookses", householdLabel("Brooks"))
        assertEquals("the Halbrooks", householdLabel("Halbrook"))
        assertEquals("", householdLabel("   "))
    }

    @Test
    fun `uses the person name for a household with no surname on file`() {
        assertEquals(
            "Household: Sam",
            tribalIntelTargetLabel(doc(targetType = "HOUSEHOLD", targetKinfolkId = "kf2"), roster, pets),
        )
    }

    @Test
    fun `shows the raw id when the roster holds no match, never a blank`() {
        assertEquals(
            "Household: gone",
            tribalIntelTargetLabel(doc(targetType = "HOUSEHOLD", targetKinfolkId = "gone"), roster, pets),
        )
        assertEquals(
            "Kin: k10",
            tribalIntelTargetLabel(
                doc(targetType = "KIN", targetKinfolkId = "kf1", targetKinId = "k10"),
                roster,
                pets,
            ),
        )
    }

    @Test
    fun `is null when the entry names nobody, so the row draws no target line`() {
        assertNull(tribalIntelTargetLabel(doc(), roster, pets))
    }
    // -- the stale target (issue #460) --------------------------------------
    private val rosterIds = listOf("kf1", "kf2")
    @Test
    fun `says nothing about an id the roster holds`() {
        assertNull(tribalIntelStaleTargetMessage("kf1", rosterIds, TribalIntelTargetNoun.HOUSEHOLD))
    }
    @Test
    fun `says nothing about a blank value, because an unset target is a different complaint`() {
        assertNull(tribalIntelStaleTargetMessage("", rosterIds, TribalIntelTargetNoun.HOUSEHOLD))
        assertNull(tribalIntelStaleTargetMessage("   ", rosterIds, TribalIntelTargetNoun.HOUSEHOLD))
    }
    @Test
    fun `says nothing while the directory is empty, because that means not loaded yet`() {
        assertNull(
            tribalIntelStaleTargetMessage("Jane Halbrook", emptyList(), TribalIntelTargetNoun.HOUSEHOLD),
        )
    }
    @Test
    fun `names the stored value and the fix when the reference is a person name`() {
        val msg = tribalIntelStaleTargetMessage("Jane Halbrook", rosterIds, TribalIntelTargetNoun.HOUSEHOLD)
        assertEquals(
            "This entry points at \"Jane Halbrook\", which is not a household on the roster. " +
                "Pick the right household. It cannot be saved as it stands.",
            msg,
        )
    }
    @Test
    fun `uses the noun each picker uses`() {
        assertEquals(
            true,
            tribalIntelStaleTargetMessage("x", rosterIds, TribalIntelTargetNoun.KINFOLK)!!
                .contains("kinfolk on the roster"),
        )
        assertEquals(
            true,
            tribalIntelStaleTargetMessage("x", rosterIds, TribalIntelTargetNoun.KIN)!!
                .contains("pet on the roster"),
        )
    }
    @Test
    fun `labels the stale value with the value itself`() {
        assertEquals("Unresolved: \"Jane Halbrook\"", tribalIntelStaleOptionLabel("Jane Halbrook"))
    }
    @Test
    fun `the anchor picker is the kinfolk one only under a KINFOLK target`() {
        assertEquals(TribalIntelTargetNoun.KINFOLK, anchorNounFor("KINFOLK"))
        assertEquals(TribalIntelTargetNoun.HOUSEHOLD, anchorNounFor("HOUSEHOLD"))
        assertEquals(TribalIntelTargetNoun.HOUSEHOLD, anchorNounFor("KIN"))
        assertEquals(TribalIntelTargetNoun.HOUSEHOLD, anchorNounFor(""))
    }
}
