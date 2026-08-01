package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.FieldCondition
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
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
    fun scope_isCaseInsensitiveAndAnythingElseIsPerVisit() {
        val catRule = FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat")
        // Lowercase "per_visit" must still evaluate per-visit (first kin only).
        assertFalse(
            KinTaleTemplateEngine.isChecklistItemVisible(item(catRule, scope = "per_visit"), session(), listOf(dog, cat)),
        )
        // Lowercase "per_pet" must still evaluate per-pet (any kin matches).
        assertTrue(
            KinTaleTemplateEngine.isChecklistItemVisible(item(catRule, scope = "per_pet"), session(), listOf(dog, cat)),
        )
        // An unknown scope from a newer app falls to PER_VISIT, matching React.
        assertFalse(
            KinTaleTemplateEngine.isChecklistItemVisible(item(catRule, scope = "PER_ROOM"), session(), listOf(dog, cat)),
        )
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
    fun usesAttributeKey_onlyForAttributeSources() {
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

    // -------------------------------------------------------------------------
    // I7: household condition sources (KINFOLK_ATTRIBUTE / KINFOLK_TAG).
    // Mirrors the React engine.test.ts "I7 household sources" block case-for-case.
    // Before this landed both sources fell through the fail-open default, so every
    // household condition authored in the React admin evaluated TRUE on android.
    // -------------------------------------------------------------------------

    private val withGate = Kinfolk(firstName = "Gated", gateCode = "4417")
    private val noGate = Kinfolk(firstName = "Open")
    private val vipHome = Kinfolk(firstName = "Vip", tags = listOf("VIP", "new-2026"))
    private val plainHome = Kinfolk(firstName = "Plain", tags = emptyList<String>())

    @Test
    fun kinfolkAttribute_equals_matchesHousehold() {
        val gateIs4417 = item(
            FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EQUALS", value = "4417", attributeKey = "gateCode"),
            scope = "PER_VISIT",
        )
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(gateIs4417, session(), listOf(dog), withGate))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(gateIs4417, session(), listOf(dog), noGate))
    }

    @Test
    fun kinfolkAttribute_exists_gateCodeSetVsUnset() {
        val hasGate = item(
            FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode"),
            scope = "PER_VISIT",
        )
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(hasGate, session(), listOf(dog), withGate))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(hasGate, session(), listOf(dog), noGate))
        // No household supplied at all reads blank, so the item stays hidden.
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(hasGate, session(), listOf(dog)))
    }

    @Test
    fun kinfolkTag_contains_isCaseInsensitiveAndExact() {
        val isVip = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "vip"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(isVip, session(), listOf(dog), vipHome))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(isVip, session(), listOf(dog), plainHome))
        // A different tag is not present. Tags never substring-match.
        val isGold = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "gold"), scope = "PER_VISIT")
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(isGold, session(), listOf(dog), vipHome))
    }

    @Test
    fun kinfolkTag_equals_meansTheSameAsContains() {
        val equalsVip = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(equalsVip, session(), listOf(dog), vipHome))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(equalsVip, session(), listOf(dog), plainHome))
    }

    @Test
    fun kinfolkTag_notEquals_isTrueWhenTagAbsent() {
        val notVip = item(FieldCondition(source = "KINFOLK_TAG", op = "NOT_EQUALS", value = "VIP"), scope = "PER_VISIT")
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(notVip, session(), listOf(dog), vipHome))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(notVip, session(), listOf(dog), plainHome))
        // A null household has no tags, so "not tagged VIP" holds.
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(notVip, session(), listOf(dog)))
    }

    @Test
    fun kinfolkTag_exists_anyTagVsNone() {
        val hasAnyTag = item(FieldCondition(source = "KINFOLK_TAG", op = "EXISTS"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), vipHome))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), plainHome))
        // Blank-only tags do not count as "any tag".
        val blankTags = Kinfolk(firstName = "Blank", tags = listOf("", "  "))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), blankTags))
    }

    @Test
    fun kinfolkTag_junkEntriesAreDroppedNotFatal() {
        // `tags` is held raw, so a Boolean or map written by another client must
        // be skipped rather than blowing up the evaluation.
        val junkyHome = Kinfolk(firstName = "Junky", tags = listOf("VIP", true, mapOf("name" to "x")))
        val isVip = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"), scope = "PER_VISIT")
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(isVip, session(), listOf(dog), junkyHome))
        // A `tags` field that is not a list at all reads as no tags.
        val brokenHome = Kinfolk(firstName = "Broken", tags = "VIP")
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(isVip, session(), listOf(dog), brokenHome))
    }

    @Test
    fun perPet_andsAKinConditionWithAHouseholdTag() {
        val catInVipHome = item(
            FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"),
            FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"),
            scope = "PER_PET",
        )
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(catInVipHome, session(), listOf(cat), vipHome))
        // Kin matches, household does not.
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(catInVipHome, session(), listOf(cat), plainHome))
        // Household matches, kin does not.
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(catInVipHome, session(), listOf(dog), vipHome))
    }

    @Test
    fun addingAKinfolkArg_doesNotChangeAKinOnlyEvaluation() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(cat), vipHome))
        assertTrue(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(cat), plainHome))
        assertFalse(KinTaleTemplateEngine.isChecklistItemVisible(litter, session(), listOf(dog), vipHome))
    }

    @Test
    fun applicableKin_acceptsAHouseholdAndStillFilters() {
        val catInVipHome = item(
            FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"),
            FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"),
            scope = "PER_PET",
        )
        assertEquals(
            listOf(cat),
            KinTaleTemplateEngine.applicableKinForChecklistItem(catInVipHome, session(), listOf(dog, cat), vipHome),
        )
        assertEquals(
            emptyList<Kin>(),
            KinTaleTemplateEngine.applicableKinForChecklistItem(catInVipHome, session(), listOf(dog, cat), plainHome),
        )
    }

    @Test
    fun everyKinfolkAttributeInCatalog_resolvesOnTheEngine() {
        val loadedHome = Kinfolk(
            firstName = "Loaded",
            serviceAddress = "1 Bark Ave",
            gateCode = "4417",
            parkingInstructions = "driveway",
            entryNotes = "side door",
            emergencyContactName = "Sam",
            emergencyContactPhone = "555-0199",
        )
        for (attr in kinfolkAttributeCatalog) {
            val cond = item(
                FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = attr.key),
                scope = "PER_VISIT",
            )
            assertTrue(
                "catalog key '${attr.key}' (${attr.label}) is offered in the editor but the engine can't read it",
                KinTaleTemplateEngine.isChecklistItemVisible(cond, session(), emptyList(), loadedHome),
            )
        }
    }

    @Test
    fun conditionSummary_householdAttributeExists_readable() {
        assertEquals(
            "Only show when the household's Gate code is set",
            conditionSummary(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode")),
        )
    }

    @Test
    fun conditionSummary_householdAttributeComparisons_readable() {
        assertEquals(
            "Only show when the household's Gate code is 4417",
            conditionSummary(
                FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EQUALS", value = "4417", attributeKey = "gateCode"),
            ),
        )
        // `vetClinicName` is no longer a condition attribute: KinTales do not
        // display a vet (page-specs 06 item 2), and the household vet moved off
        // the kinfolk doc entirely. Entry notes stand in as another free-text
        // household attribute, so the NOT_EQUALS phrasing is still covered.
        assertEquals(
            "Only show when the household's Entry notes is not side door",
            conditionSummary(
                FieldCondition(
                    source = "KINFOLK_ATTRIBUTE",
                    op = "NOT_EQUALS",
                    value = "side door",
                    attributeKey = "entryNotes",
                ),
            ),
        )
        assertEquals(
            "Only show when the household's Emergency contact contains Sam",
            conditionSummary(
                FieldCondition(
                    source = "KINFOLK_ATTRIBUTE",
                    op = "CONTAINS",
                    value = "Sam",
                    attributeKey = "emergencyContactName",
                ),
            ),
        )
    }

    @Test
    fun conditionSummary_householdAttribute_unknownKeyFallsBack() {
        assertEquals(
            "Only show when the household's mysteryKey is set",
            conditionSummary(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "mysteryKey")),
        )
        assertEquals(
            "Only show when the household's an attribute is set",
            conditionSummary(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "")),
        )
    }

    @Test
    fun conditionSummary_householdTag_readable() {
        assertEquals(
            "Only show when the household is tagged VIP",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP")),
        )
        assertEquals(
            "Only show when the household is tagged VIP",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP")),
        )
        assertEquals(
            "Only show when the household is not tagged VIP",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "NOT_EQUALS", value = "VIP")),
        )
        assertEquals(
            "Only show when the household has any tags",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "EXISTS")),
        )
    }

    @Test
    fun conditionSummary_blankValue_rendersBlankPlaceholder() {
        assertEquals(
            "Only show when the household is tagged (blank)",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "")),
        )
    }

    @Test
    fun usesAttributeKey_isTrueForKinfolkAttribute_falseForKinfolkTag() {
        assertTrue(conditionUsesAttributeKey("KINFOLK_ATTRIBUTE"))
        assertFalse(conditionUsesAttributeKey("KINFOLK_TAG"))
    }

    @Test
    fun editorSourceList_offersAllFiveSourcesInOrder() {
        assertEquals(
            listOf("KIN_SPECIES", "KIN_ATTRIBUTE", "SERVICE_TYPE", "KINFOLK_ATTRIBUTE", "KINFOLK_TAG"),
            conditionSourceOptions.map { it.source.name },
        )
        assertEquals(
            listOf("Pet species", "Pet attribute", "Service type", "Household attribute", "Household tag"),
            conditionSourceOptions.map { it.label },
        )
    }
}
