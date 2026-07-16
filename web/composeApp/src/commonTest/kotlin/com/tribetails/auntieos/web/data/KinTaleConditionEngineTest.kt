package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pins the KinTale conditional-checklist engine. This mirrors the Android
 * KinTaleTemplateEngine so a template authored on either platform shows / hides
 * the same checklist items for the same kin. If these two engines drift, a
 * kinfolk gets a different report depending on which app sent it - so the cases
 * below are deliberately identical in spirit to the Android engine test.
 */
class KinTaleConditionEngineTest {

    private fun session(serviceType: String = "Dog Walking") =
        KinCareSession(serviceType = serviceType)

    private fun item(vararg conditions: FieldCondition, scope: String = "PER_PET") =
        ChecklistItem(key = "k", text = "t", scope = scope, conditions = conditions.toList())

    private val cat = Kin(name = "Mittens", species = "Cat")
    private val dog = Kin(name = "Rex", species = "Dog")
    private val dogOnMeds = Kin(name = "Rex", species = "Dog", medicationHealthNotes = "insulin 2x/day")

    // ---- empty = always visible ----

    @Test
    fun emptyConditions_alwaysVisible() {
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(item(), session(), listOf(dog)))
    }

    // ---- KIN_SPECIES ----

    @Test
    fun kinSpecies_equals_matchesCatHidesDog() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(dog)))
    }

    @Test
    fun kinSpecies_equals_isCaseInsensitive() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "cat"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
    }

    // ---- KIN_ATTRIBUTE ----

    @Test
    fun kinAttribute_exists_medication() {
        val meds = item(FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(meds, session(), listOf(dogOnMeds)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(meds, session(), listOf(dog)))
    }

    // ---- SERVICE_TYPE ----

    @Test
    fun serviceType_contains_walk() {
        val postWalk = item(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(postWalk, session("Dog Walking"), listOf(dog)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(postWalk, session("Overnight Boarding"), listOf(dog)))
    }

    // ---- NOT_EQUALS ----

    @Test
    fun notEquals_hidesWhenEqual() {
        val notCat = item(FieldCondition(source = "KIN_SPECIES", op = "NOT_EQUALS", value = "Cat"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(notCat, session(), listOf(dog)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(notCat, session(), listOf(cat)))
    }

    // ---- AND-ing ----

    @Test
    fun multipleConditions_areAnded() {
        val dogAndMeds = item(
            FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Dog"),
            FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes"),
        )
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(dogOnMeds)))
        // dog without meds fails the second condition
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(dog)))
        // cat on meds fails the first condition
        val catOnMeds = cat.copy(medicationHealthNotes = "thyroid")
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(dogAndMeds, session(), listOf(catOnMeds)))
    }

    // ---- PER_PET any-match + applicable-kin filtering ----

    @Test
    fun perPet_visibleIfAnyKinMatches() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_PET")
        // mixed household: one cat, one dog -> visible because the cat matches
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(dog, cat)))
        // dog-only household -> hidden
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(dog)))
    }

    @Test
    fun applicableKin_filtersToMatchingKinOnly() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_PET")
        val applicable = KinTaleConditionEngine.applicableKinForChecklistItem(litter, session(), listOf(dog, cat))
        assertEquals(listOf(cat), applicable)
    }

    @Test
    fun applicableKin_emptyConditions_returnsAllKin() {
        val all = KinTaleConditionEngine.applicableKinForChecklistItem(item(), session(), listOf(dog, cat))
        assertEquals(listOf(dog, cat), all)
    }

    // ---- PER_VISIT uses the first kin (or no kin) ----

    @Test
    fun perVisit_evaluatesAgainstFirstKin() {
        val catVisit = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_VISIT")
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(catVisit, session(), listOf(cat, dog)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(catVisit, session(), listOf(dog, cat)))
    }

    @Test
    fun perVisit_serviceTypeCondition_worksWithNoKin() {
        val postWalk = item(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"), scope = "PER_VISIT")
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(postWalk, session("Dog Walking"), emptyList()))
    }

    // ---- malformed / forward-compatible enums are safe (never throw, never hide everything) ----

    @Test
    fun unknownSource_isSafelyVisible() {
        val garbage = item(FieldCondition(source = "FROM_THE_FUTURE", op = "EQUALS", value = "x"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(garbage, session(), listOf(dog)))
    }

    @Test
    fun unknownOp_isSafelyVisible() {
        val garbage = item(FieldCondition(source = "KIN_SPECIES", op = "REGEX_MATCH", value = "x"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(garbage, session(), listOf(dog)))
    }

    // ---- user-facing summary copy (rendered in the editor row) ----

    @Test
    fun conditionSummary_speciesEquals_readable() {
        val s = conditionSummary(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"))
        assertEquals("Only show when the pet's species is Cat", s)
    }

    @Test
    fun conditionSummary_attributeExists_readable() {
        val s = conditionSummary(FieldCondition(source = "KIN_ATTRIBUTE", op = "EXISTS", attributeKey = "medicationHealthNotes"))
        assertEquals("Only show when the pet has Medication / health notes", s)
    }

    @Test
    fun conditionSummary_serviceContains_readable() {
        val s = conditionSummary(FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"))
        assertEquals("Only show when the service type contains walk", s)
    }

    // ---- catalog <-> engine parity guard (prevents the editor offering a key the engine can't read) ----

    // ---- editor field-visibility helpers (shared by web + android editors) ----

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
        // A kin with every catalogued attribute populated must satisfy an EXISTS
        // condition for each catalogued key. If the engine's readAttribute does
        // not handle a key the editor offers, this fails - which is exactly the
        // drift we want to catch at build time.
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
                KinTaleConditionEngine.isChecklistItemVisible(cond, session(), listOf(loaded)),
                "catalog key '${attr.key}' (${attr.label}) is offered in the editor but the engine can't read it",
            )
        }
    }
}
