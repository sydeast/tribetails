package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.ChecklistItem
import com.tribetails.auntieos.web.data.FieldCondition
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.TagColor
import com.tribetails.auntieos.web.data.TagDef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pins the KinTale condition BUILDER helpers and the visibility call-site seams.
 *
 * These are the pure halves of the condition editor and the composer's checklist
 * filter, extracted so they can be tested without a Compose runtime. They are
 * ported from React's `lib/kinTaleTemplateEdit.ts` (attributeCatalogForSource,
 * changeConditionSource, valuePlaceholder, opLabel) plus the "(unrecognised)"
 * option behavior of `screens/KinTaleTemplates.tsx#ConditionRow`.
 *
 * The visibility cases are the ones that matter most: until I7 the KINFOLK_*
 * sources parsed as unknown and fail-open returned true, so a household rule
 * silently showed every checklist item. A call site that forgets to hand over
 * the household reproduces exactly that bug, which is why the seams below take
 * `kinfolk` with NO default value.
 */
class KinTaleConditionEditorHelpersTest {

    private fun session(serviceType: String = "Dog Walking") =
        KinCareSession(serviceType = serviceType)

    private fun item(vararg conditions: FieldCondition, scope: String = "PER_PET") =
        ChecklistItem(key = "k", text = "t", scope = scope, conditions = conditions.toList())

    private val dog = Kin(name = "Rex", species = "Dog")
    private val vipHousehold = Kinfolk(lastName = "Thorne", tags = listOf("VIP"), gateCode = "8421")
    private val plainHousehold = Kinfolk(lastName = "Bell", tags = emptyList())

    private fun tag(name: String) = TagDef(name = name, color = TagColor(token = "teal", css = "var(--color-accent)"))

    // ---- attributeCatalogForSource ----

    @Test
    fun attributeCatalog_kinAttributeGetsKinCatalog() {
        val catalog = attributeCatalogForSource("KIN_ATTRIBUTE")
        assertEquals("medicationHealthNotes", catalog.first().key)
        assertTrue(catalog.any { it.key == "colorMarkings" })
    }

    @Test
    fun attributeCatalog_kinfolkAttributeGetsHouseholdCatalog() {
        val catalog = attributeCatalogForSource("KINFOLK_ATTRIBUTE")
        assertEquals(listOf("serviceAddress", "gateCode", "parkingInstructions", "entryNotes",
            "emergencyContactName", "emergencyContactPhone", "vetClinicName"), catalog.map { it.key })
        // The two labels that are not a title-cased echo of the key.
        assertEquals("Emergency contact", catalog.first { it.key == "emergencyContactName" }.label)
        assertEquals("Vet on file", catalog.first { it.key == "vetClinicName" }.label)
    }

    @Test
    fun attributeCatalog_everyOtherSourceGetsNone() {
        assertTrue(attributeCatalogForSource("KIN_SPECIES").isEmpty())
        assertTrue(attributeCatalogForSource("SERVICE_TYPE").isEmpty())
        assertTrue(attributeCatalogForSource("KINFOLK_TAG").isEmpty())
        assertTrue(attributeCatalogForSource("SOMETHING_NEWER").isEmpty())
    }

    // ---- changeConditionSource ----

    @Test
    fun changeSource_seedsFirstKeyWhenAttributeKeyIsBlank() {
        val next = changeConditionSource(FieldCondition(source = "KIN_SPECIES", value = "Cat"), "KIN_ATTRIBUTE")
        assertEquals("KIN_ATTRIBUTE", next.source)
        assertEquals("medicationHealthNotes", next.attributeKey)
        assertEquals("Cat", next.value)
    }

    @Test
    fun changeSource_resetsAKeyLeftOverFromTheOtherAttributeSource() {
        // "vaccinations" is a KIN key; the household engine reads it as blank, so
        // switching to KINFOLK_ATTRIBUTE must re-seed rather than keep it.
        val stale = FieldCondition(source = "KIN_ATTRIBUTE", attributeKey = "vaccinations")
        assertEquals("serviceAddress", changeConditionSource(stale, "KINFOLK_ATTRIBUTE").attributeKey)
    }

    @Test
    fun changeSource_keepsAKeyThatIsValidForTheNewSource() {
        val cond = FieldCondition(source = "KIN_ATTRIBUTE", attributeKey = "gateCode")
        assertEquals("gateCode", changeConditionSource(cond, "KINFOLK_ATTRIBUTE").attributeKey)
    }

    @Test
    fun changeSource_leavesAttributeKeyAloneForSourcesWithNoCatalog() {
        // React's changeConditionSource does not clear it (the engine ignores
        // attributeKey for these sources), so neither do we.
        val cond = FieldCondition(source = "KIN_ATTRIBUTE", attributeKey = "routine")
        val next = changeConditionSource(cond, "KINFOLK_TAG")
        assertEquals("KINFOLK_TAG", next.source)
        assertEquals("routine", next.attributeKey)
    }

    // ---- picker choices: an unknown stored value must stay selected ----

    @Test
    fun sourceChoices_listAllFiveInOrder() {
        assertEquals(
            listOf("KIN_SPECIES", "KIN_ATTRIBUTE", "SERVICE_TYPE", "KINFOLK_ATTRIBUTE", "KINFOLK_TAG"),
            conditionSourceChoices("KIN_SPECIES"),
        )
    }

    @Test
    fun sourceChoices_keepAnUnknownStoredSource() {
        val choices = conditionSourceChoices("KINFOLK_ZODIAC")
        assertEquals("KINFOLK_ZODIAC", choices.first())
        assertEquals(6, choices.size)
        assertEquals("KINFOLK_ZODIAC (unrecognised)", conditionSourceLabel("KINFOLK_ZODIAC"))
    }

    @Test
    fun sourceLabel_usesTheEditorCopy() {
        assertEquals("Household attribute", conditionSourceLabel("KINFOLK_ATTRIBUTE"))
        assertEquals("Household tag", conditionSourceLabel("KINFOLK_TAG"))
    }

    @Test
    fun opChoices_keepAnUnknownStoredOp() {
        assertEquals(listOf("EQUALS", "NOT_EQUALS", "CONTAINS", "EXISTS"), conditionOpChoices("EQUALS"))
        assertEquals("STARTS_WITH", conditionOpChoices("STARTS_WITH").first())
        assertEquals("is set", conditionOpLabel("EXISTS"))
        assertEquals("STARTS_WITH (unrecognised)", conditionOpLabel("STARTS_WITH"))
    }

    @Test
    fun attributeChoices_keepAnUnknownStoredKey() {
        val choices = attributeKeyChoices("KINFOLK_ATTRIBUTE", "wifiPassword")
        assertEquals("wifiPassword", choices.first())
        assertEquals("wifiPassword (unrecognised)", attributeKeyLabel("KINFOLK_ATTRIBUTE", "wifiPassword"))
        assertEquals("Gate code", attributeKeyLabel("KINFOLK_ATTRIBUTE", "gateCode"))
    }

    @Test
    fun attributeChoices_dropABlankKeyRatherThanOfferingIt() {
        assertEquals(kinfolkAttributeKeys, attributeKeyChoices("KINFOLK_ATTRIBUTE", ""))
        // A rule with no field yet says so, rather than displaying the first entry
        // and implying a field the stored rule does not carry.
        assertEquals("Choose a field", attributeKeyLabel("KINFOLK_ATTRIBUTE", ""))
    }

    private val kinfolkAttributeKeys = listOf(
        "serviceAddress", "gateCode", "parkingInstructions", "entryNotes",
        "emergencyContactName", "emergencyContactPhone", "vetClinicName",
    )

    // ---- value placeholder ----

    @Test
    fun valuePlaceholder_perSource() {
        assertEquals("e.g. Cat", conditionValuePlaceholder("KIN_SPECIES"))
        assertEquals("e.g. walk", conditionValuePlaceholder("SERVICE_TYPE"))
        assertEquals("e.g. VIP", conditionValuePlaceholder("KINFOLK_TAG"))
        assertEquals("Value to match", conditionValuePlaceholder("KINFOLK_ATTRIBUTE"))
        assertEquals("Value to match", conditionValuePlaceholder("SOMETHING_NEWER"))
    }

    // ---- tag picker ----

    @Test
    fun tagPicker_onlyForTheTagSource() {
        assertTrue(conditionUsesTagPicker("KINFOLK_TAG"))
        assertFalse(conditionUsesTagPicker("KINFOLK_ATTRIBUTE"))
        assertFalse(conditionUsesTagPicker("KIN_SPECIES"))
    }

    @Test
    fun tagPicker_offersTheVocabularyInOrder() {
        val vocab = listOf(tag("VIP"), tag("Reactive"), tag("Gate code"))
        assertEquals(listOf("VIP", "Reactive", "Gate code"), tagPickerOptions(vocab, current = ""))
    }

    @Test
    fun tagPicker_keepsVocabularyCasingAndDropsBlankRows() {
        val vocab = listOf(tag("VIP"), tag("   "), tag(""))
        assertEquals(listOf("VIP"), tagPickerOptions(vocab, current = ""))
    }

    @Test
    fun tagPicker_dedupesCaseInsensitivelyKeepingTheFirstSpelling() {
        // The React tag layer is case-insensitive everywhere, so "vip" and "VIP"
        // are the same tag; offering both would let the operator pick a duplicate.
        val vocab = listOf(tag("VIP"), tag("vip"))
        assertEquals(listOf("VIP"), tagPickerOptions(vocab, current = ""))
    }

    @Test
    fun tagPicker_keepsAValueThatIsNotInTheVocabulary() {
        val vocab = listOf(tag("VIP"))
        assertEquals(listOf("Snowbird", "VIP"), tagPickerOptions(vocab, current = "Snowbird"))
        assertEquals("Snowbird (not in your tag list)", tagOptionLabel("Snowbird", vocab))
        assertEquals("VIP", tagOptionLabel("VIP", vocab))
    }

    @Test
    fun tagPicker_doesNotDuplicateAValueThatDiffersOnlyByCase() {
        val vocab = listOf(tag("VIP"))
        assertEquals(listOf("VIP"), tagPickerOptions(vocab, current = "vip"))
    }

    // ---- visibility seams: the household MUST reach the engine ----

    @Test
    fun perVisit_householdTagRuleHidesAnUntaggedHousehold() {
        val vip = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"), scope = "PER_VISIT")
        assertEquals(listOf(vip), visiblePerVisitItems(listOf(vip), session(), listOf(dog), vipHousehold))
        assertTrue(visiblePerVisitItems(listOf(vip), session(), listOf(dog), plainHousehold).isEmpty())
    }

    @Test
    fun perVisit_householdTagRuleHidesWhenTheHouseholdIsMissing() {
        // A null household is the pre-I7 failure mode. It must read as "no tags",
        // never as "show everything".
        val vip = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"), scope = "PER_VISIT")
        assertTrue(visiblePerVisitItems(listOf(vip), session(), listOf(dog), null).isEmpty())
    }

    @Test
    fun perPet_householdAttributeRuleReachesTheEngine() {
        val gate = item(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode"))
        assertEquals(listOf(gate), visiblePerPetItems(listOf(gate), session(), dog, vipHousehold))
        assertTrue(visiblePerPetItems(listOf(gate), session(), dog, plainHousehold).isEmpty())
    }

    @Test
    fun perPet_kinRulesAreUnaffectedByTheHousehold() {
        val cats = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Dog"))
        assertEquals(listOf(cats), visiblePerPetItems(listOf(cats), session(), dog, null))
        assertEquals(listOf(cats), visiblePerPetItems(listOf(cats), session(), dog, vipHousehold))
    }

    @Test
    fun unconditionalItemsSurviveBothSeams() {
        val perPet = item()
        val perVisit = item(scope = "PER_VISIT")
        assertEquals(listOf(perPet), visiblePerPetItems(listOf(perPet), session(), dog, null))
        assertEquals(listOf(perVisit), visiblePerVisitItems(listOf(perVisit), session(), listOf(dog), null))
    }
}
