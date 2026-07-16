package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the KinTale conditional-checklist engine. Deliberately the same cases as
 * the web KinTaleConditionEngineTest: if the two engines drift, a kinfolk gets a
 * different report depending on which app sent it. The engine shipped untested
 * until the condition editor landed - this closes that gap.
 */
class KinTaleTemplateEngineTest {

    private fun session(serviceType: String = "Dog Walking") =
        KinCareSession(serviceType = serviceType)

    private fun item(vararg conditions: FieldCondition, scope: String = "PER_PET") =
        ChecklistItem(key = "k", text = "t", scope = scope, conditions = conditions.toList())

    private val cat = Kin(name = "Mittens", species = "Cat")
    private val dog = Kin(name = "Rex", species = "Dog")
    private val dogOnMeds = Kin(name = "Rex", species = "Dog", medicationHealthNotes = "insulin 2x/day")

    @Test
    fun emptyConditions_alwaysVisible() {
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(item(), session(), listOf(dog)))
    }

    @Test
    fun kinSpecies_equals_matchesCatHidesDog() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(dog)))
    }

    @Test
    fun kinSpecies_equals_isCaseInsensitive() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "cat"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
    }

    @Test
    fun kinAttribute_exists_medication() {
        val meds = item(FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(meds, session(), listOf(dogOnMeds)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(meds, session(), listOf(dog)))
    }

    @Test
    fun serviceType_contains_walk() {
        val postWalk = item(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(postWalk, session("Dog Walking"), listOf(dog)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(postWalk, session("Overnight Boarding"), listOf(dog)))
    }

    @Test
    fun notEquals_hidesWhenEqual() {
        val notCat = item(FieldCondition(source = "KIN_SPECIES", op = "NOT_EQUALS", value = "Cat"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(notCat, session(), listOf(dog)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(notCat, session(), listOf(cat)))
    }

    @Test
    fun multipleConditions_areAnded() {
        val dogAndMeds = item(
            FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Dog"),
            FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes"),
        )
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(dogOnMeds)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(dog)))
        val catOnMeds = cat.copy(medicationHealthNotes = "thyroid")
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(catOnMeds)))
    }

    @Test
    fun perPet_visibleIfAnyKinMatches() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_PET")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(dog, cat)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(dog)))
    }

    @Test
    fun applicableKin_filtersToMatchingKinOnly() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_PET")
        val applicable = KinTaleTemplateEngine.applicableKinForChecklistItem(litter, session(), listOf(dog, cat))
        assertEquals(listOf(cat), applicable)
    }

    @Test
    fun applicableKin_emptyConditions_returnsAllKin() {
        val all = KinTaleTemplateEngine.applicableKinForChecklistItem(item(), session(), listOf(dog, cat))
        assertEquals(listOf(dog, cat), all)
    }

    @Test
    fun perVisit_evaluatesAgainstFirstKin() {
        val catVisit = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(catVisit, session(), listOf(cat, dog)))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(catVisit, session(), listOf(dog, cat)))
    }

    @Test
    fun perVisit_serviceTypeCondition_worksWithNoKin() {
        val postWalk = item(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(postWalk, session("Dog Walking"), emptyList()))
    }

    @Test
    fun unknownSource_isSafelyVisible() {
        val garbage = item(FieldCondition(source = "FROM_THE_FUTURE", op = "EQUALS", value = "x"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(garbage, session(), listOf(dog)))
    }

    @Test
    fun unknownOp_isSafelyVisible() {
        val garbage = item(FieldCondition(source = "KIN_SPECIES", op = "REGEX_MATCH", value = "x"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(garbage, session(), listOf(dog)))
    }

    @Test
    fun conditionSummary_speciesEquals_readable() {
        assertEquals(
            "Only show when the pet's species is Cat",
            conditionSummary(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat")),
        )
    }

    @Test
    fun conditionSummary_attributeExists_readable() {
        assertEquals(
            "Only show when the pet has Medication / health notes",
            conditionSummary(FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes")),
        )
    }

    @Test
    fun conditionSummary_serviceContains_readable() {
        assertEquals(
            "Only show when the service type contains walk",
            conditionSummary(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk")),
        )
    }

    @Test
    fun usesAttributeKey_onlyForKinAttributeSource() {
        assertTrue(conditionUsesAttributeKey("KIN_ATTRIBUTE"))
        assertFalse(conditionUsesAttributeKey("KIN_SPECIES"))
        assertFalse(conditionUsesAttributeKey("SERVICE_TYPE"))
    }

    @Test
    fun usesValueInput_falseForExists_trueForComparisons() {
        assertFalse(conditionUsesValueInput("EXISTS"))
        assertTrue(conditionUsesValueInput("EQUALS"))
        assertTrue(conditionUsesValueInput("NOT_EQUALS"))
        assertTrue(conditionUsesValueInput("CONTAINS"))
    }

    @Test
    fun everyAttributeInCatalog_resolvesOnTheEngine() {
        val loaded = Kin(
            name = "Loaded", species = "Dog",
            colorMarkings = "tan", spayedNeutered = true, routine = "am/pm",
            trainingCommands = "sit", feedingBrand = "Acme", vaccinations = "current",
            medicationHealthNotes = "insulin", vetInfo = "Dr Paws", checklist = "x",
            reactive = true, officeNotes = "vip",
        )
        for (attr in conditionAttributeCatalog) {
            val cond = item(FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = attr.key))
            assertTrue(
                "catalog key '${attr.key}' (${attr.label}) is offered in the editor but the engine can't read it",
                KinTaleTemplateEngine.isChecklistItemVisible(cond, session(), listOf(loaded)),
            )
        }
    }
}
