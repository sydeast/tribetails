package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for the KinTale condition BUILDER and the report screen's
 * visibility seams. Mirrors the web KinTaleConditionEditorHelpersTest case for
 * case, because a template authored on either platform has to build and evaluate
 * the same rule.
 *
 * The helpers are ported from React's lib/kinTaleTemplateEdit.ts
 * (attributeCatalogForSource, changeConditionSource, opLabel, valuePlaceholder)
 * plus the "(unrecognised)" option behavior in screens/KinTaleTemplates.tsx.
 */
class KinTaleConditionEditorHelpersTest {

    private fun session(serviceType: String = "Dog Walking") =
        KinCareSession(serviceType = serviceType)

    private fun item(vararg conditions: FieldCondition, scope: String = ChecklistScope.PER_PET.name) =
        ChecklistItem(key = "k", text = "t", scope = scope, conditions = conditions.toList())

    private val dog = Kin(id = "kin1", name = "Rex", species = "Dog")
    private val vipHousehold = Kinfolk(lastName = "Thorne", tags = listOf("VIP"), gateCode = "8421")
    private val plainHousehold = Kinfolk(lastName = "Bell", tags = emptyList<String>())

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
        assertEquals(
            listOf(
                // `vetClinicName` is gone: KinTales do not display a vet
                // (page-specs 06 item 2), and the household vet moved off the
                // kinfolk doc onto household_data entirely.
                "serviceAddress", "gateCode", "parkingInstructions", "entryNotes",
                "emergencyContactName", "emergencyContactPhone",
            ),
            catalog.map { it.key },
        )
        assertEquals("Emergency contact", catalog.first { it.key == "emergencyContactName" }.label)
        assertEquals("Entry notes", catalog.first { it.key == "entryNotes" }.label)
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
        val cond = FieldCondition(source = "KIN_ATTRIBUTE", attributeKey = "routine")
        val next = changeConditionSource(cond, "KINFOLK_TAG")
        assertEquals("KINFOLK_TAG", next.source)
        assertEquals("routine", next.attributeKey)
    }

    // ---- picker choices ----

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
        assertEquals(
            listOf(
                // `vetClinicName` is gone: KinTales do not display a vet
                // (page-specs 06 item 2), and the household vet moved off the
                // kinfolk doc onto household_data entirely.
                "serviceAddress", "gateCode", "parkingInstructions", "entryNotes",
                "emergencyContactName", "emergencyContactPhone",
            ),
            attributeKeyChoices("KINFOLK_ATTRIBUTE", ""),
        )
        // A rule with no field yet says so, rather than displaying the first entry
        // and implying a field the stored rule does not carry.
        assertEquals("Choose a field", attributeKeyLabel("KINFOLK_ATTRIBUTE", ""))
    }

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
        val vip = item(
            FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"),
            scope = ChecklistScope.PER_VISIT.name,
        )
        assertEquals(listOf(vip), visiblePerVisitItems(listOf(vip), session(), listOf(dog), vipHousehold))
        assertTrue(visiblePerVisitItems(listOf(vip), session(), listOf(dog), plainHousehold).isEmpty())
    }

    @Test
    fun perVisit_householdTagRuleHidesWhenTheHouseholdIsMissing() {
        // A null household is the pre-I7 failure mode: it must read as "no tags",
        // never as "show everything".
        val vip = item(
            FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"),
            scope = ChecklistScope.PER_VISIT.name,
        )
        assertTrue(visiblePerVisitItems(listOf(vip), session(), listOf(dog), null).isEmpty())
    }

    @Test
    fun perPet_householdAttributeRuleReachesTheEngine() {
        val gate = item(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode"))
        assertEquals(listOf(gate), applicablePerPetItems(listOf(gate), session(), listOf(dog), dog, vipHousehold))
        assertTrue(applicablePerPetItems(listOf(gate), session(), listOf(dog), dog, plainHousehold).isEmpty())
    }

    @Test
    fun perPet_kinRulesAreUnaffectedByTheHousehold() {
        val dogsOnly = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Dog"))
        assertEquals(listOf(dogsOnly), applicablePerPetItems(listOf(dogsOnly), session(), listOf(dog), dog, null))
        assertEquals(
            listOf(dogsOnly),
            applicablePerPetItems(listOf(dogsOnly), session(), listOf(dog), dog, vipHousehold),
        )
    }

    @Test
    fun perPet_itemIsDroppedForAKinItDoesNotApplyTo() {
        val cat = Kin(id = "kin2", name = "Mittens", species = "Cat")
        val catsOnly = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"))
        val kinList = listOf(dog, cat)
        assertTrue(applicablePerPetItems(listOf(catsOnly), session(), kinList, dog, null).isEmpty())
        assertEquals(listOf(catsOnly), applicablePerPetItems(listOf(catsOnly), session(), kinList, cat, null))
    }

    @Test
    fun unconditionalItemsSurviveBothSeams() {
        val perPet = item()
        val perVisit = item(scope = ChecklistScope.PER_VISIT.name)
        assertEquals(listOf(perPet), applicablePerPetItems(listOf(perPet), session(), listOf(dog), dog, null))
        assertEquals(listOf(perVisit), visiblePerVisitItems(listOf(perVisit), session(), listOf(dog), null))
    }
    // ── Item 8: which items open their "Advanced" fold on load ───────────────
    /**
     * Everything an item can be configured to do beyond its text lives in the
     * fold, so an item off the defaults opens on load: folding may cost a click,
     * never a fact. Same predicate as React's `advancedOpenByDefault`
     * (lib/kinTaleTemplateEdit.ts), so neither platform folds away something the
     * other shows.
     */
    @Test
    fun advancedOpenByDefault_foldsAPlainItem() {
        assertFalse(advancedOpenByDefault(ChecklistItem(key = "a", text = "Meds")))
    }
    @Test
    fun advancedOpenByDefault_opensForShowWhenUnchecked() {
        assertTrue(advancedOpenByDefault(ChecklistItem(key = "a", showWhenUnchecked = true)))
    }
    @Test
    fun advancedOpenByDefault_opensForRequired() {
        assertTrue(advancedOpenByDefault(ChecklistItem(key = "a", required = true)))
    }
    @Test
    fun advancedOpenByDefault_opensForAnyCondition() {
        val item = ChecklistItem(
            key = "a",
            conditions = listOf(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "dog")),
        )
        assertTrue(advancedOpenByDefault(item))
    }
}
