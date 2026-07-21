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
    fun usesAttributeKey_forKinAttributeAndKinfolkAttribute() {
        assertTrue(conditionUsesAttributeKey("KIN_ATTRIBUTE"))
        assertTrue(conditionUsesAttributeKey("KINFOLK_ATTRIBUTE"))
        assertFalse(conditionUsesAttributeKey("KIN_SPECIES"))
        assertFalse(conditionUsesAttributeKey("SERVICE_TYPE"))
        // KINFOLK_TAG matches against the tag list, it never picks an attribute key.
        assertFalse(conditionUsesAttributeKey("KINFOLK_TAG"))
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

/**
 * The two household condition sources (KINFOLK_ATTRIBUTE / KINFOLK_TAG) that the
 * React admin has been authoring since I7. Before they existed here they parsed
 * as an unknown source and hit the engine's fail-open branch, so every household
 * condition silently evaluated TRUE on web and desktop. These cases pin the fix.
 *
 * Case-for-case mirror of the React `engine.test.ts` "I7 household sources"
 * block, so the two engines cannot drift.
 */
class KinTaleHouseholdConditionTest {

    private fun session(serviceType: String = "Dog Walking") =
        KinCareSession(serviceType = serviceType)

    private fun item(vararg conditions: FieldCondition, scope: String = "PER_VISIT") =
        ChecklistItem(key = "k", text = "t", scope = scope, conditions = conditions.toList())

    private val cat = Kin(name = "Mittens", species = "Cat")
    private val dog = Kin(name = "Rex", species = "Dog")

    private val withGate = Kinfolk(_id = "h1", gateCode = "4417")
    private val noGate = Kinfolk(_id = "h2")
    private val vipHome = Kinfolk(_id = "h3", tags = listOf("VIP", "new-2026"))
    private val plainHome = Kinfolk(_id = "h4", tags = emptyList())

    // ---- KINFOLK_ATTRIBUTE ----

    @Test
    fun kinfolkAttribute_equals_matchingVsNonMatchingHousehold() {
        val gateIs4417 = item(
            FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EQUALS", value = "4417", attributeKey = "gateCode"),
        )
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(gateIs4417, session(), listOf(dog), withGate))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(gateIs4417, session(), listOf(dog), noGate))
    }

    @Test
    fun kinfolkAttribute_exists_gateCodeSetVsUnset() {
        val hasGate = item(
            FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode"),
        )
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(hasGate, session(), listOf(dog), withGate))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(hasGate, session(), listOf(dog), noGate))
        // no household supplied at all: reads blank, so the item is NOT visible.
        // This is the regression the port closes - it used to fail open to true.
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(hasGate, session(), listOf(dog)))
    }

    @Test
    fun kinfolkAttribute_uncataloguedKey_readsBlank() {
        // wifiPassword is a real Kinfolk field but is deliberately NOT catalogued,
        // so the engine must read it as blank rather than leak it into a condition.
        val cond = item(
            FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "wifiPassword"),
        )
        val home = Kinfolk(_id = "h9", wifiPassword = "hunter2")
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(cond, session(), listOf(dog), home))
    }

    // ---- KINFOLK_TAG ----

    @Test
    fun kinfolkTag_contains_taggedVsUntaggedHousehold() {
        val isVip = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "vip"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(isVip, session(), listOf(dog), vipHome))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(isVip, session(), listOf(dog), plainHome))
        val isGold = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "gold"))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(isGold, session(), listOf(dog), vipHome))
    }

    @Test
    fun kinfolkTag_contains_isNotSubstringMatching() {
        // The single most likely port mistake: routing KINFOLK_TAG through the generic
        // string matcher would make CONTAINS "VI" match the tag "VIP". React gives
        // CONTAINS and EQUALS the same meaning, "a tag equal to value is present".
        val partial = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VI"))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(partial, session(), listOf(dog), vipHome))
    }

    @Test
    fun kinfolkTag_equalsAndContains_haveTheSameMeaning() {
        val equalsVip = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"))
        val containsVip = item(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"))
        for (home in listOf(vipHome, plainHome)) {
            assertEquals(
                KinTaleConditionEngine.isChecklistItemVisible(equalsVip, session(), listOf(dog), home),
                KinTaleConditionEngine.isChecklistItemVisible(containsVip, session(), listOf(dog), home),
                "EQUALS and CONTAINS must agree on KINFOLK_TAG for household ${home._id}",
            )
        }
    }

    @Test
    fun kinfolkTag_exists_anyTagVsNone() {
        val hasAnyTag = item(FieldCondition(source = "KINFOLK_TAG", op = "EXISTS"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), vipHome))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), plainHome))
        // blank-only tags do not count as "any tag"
        val blankTags = Kinfolk(_id = "h5", tags = listOf("", "  "))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog), blankTags))
    }

    @Test
    fun kinfolkTag_comparisonIsCaseInsensitiveAndTrimmedOnBothSides() {
        val padded = Kinfolk(_id = "h6", tags = listOf("  VIP  "))
        val cond = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = " vip "))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(cond, session(), listOf(dog), padded))
    }

    @Test
    fun kinfolkTag_nullHousehold_readsAsEmptyTagList() {
        val isVip = item(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "VIP"))
        val notVip = item(FieldCondition(source = "KINFOLK_TAG", op = "NOT_EQUALS", value = "VIP"))
        val hasAnyTag = item(FieldCondition(source = "KINFOLK_TAG", op = "EXISTS"))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(isVip, session(), listOf(dog)))
        // NOT_EQUALS on an empty list is TRUE: the tag genuinely is not present.
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(notVip, session(), listOf(dog)))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(hasAnyTag, session(), listOf(dog)))
    }

    // ---- threading the household through the existing scopes ----

    @Test
    fun perPet_andsAKinConditionWithAHouseholdTag() {
        val catInVipHome = item(
            FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"),
            FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"),
            scope = "PER_PET",
        )
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(catInVipHome, session(), listOf(cat), vipHome))
        // kin matches, household does not
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(catInVipHome, session(), listOf(cat), plainHome))
        // household matches, kin does not
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(catInVipHome, session(), listOf(dog), vipHome))
    }

    @Test
    fun addingAKinfolkArg_doesNotChangeAKinOnlyEvaluation() {
        val litter = item(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), scope = "PER_PET")
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(cat)))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(cat), vipHome))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(cat), plainHome))
        assertFalse(KinTaleConditionEngine.isChecklistItemVisible(litter, session(), listOf(dog), vipHome))
    }

    @Test
    fun applicableKin_filtersOutEveryKinWhenTheHouseholdConditionFails() {
        val vipOnly = item(
            FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP"),
            scope = "PER_PET",
        )
        assertEquals(
            listOf(dog, cat),
            KinTaleConditionEngine.applicableKinForChecklistItem(vipOnly, session(), listOf(dog, cat), vipHome),
        )
        assertEquals(
            emptyList<Kin>(),
            KinTaleConditionEngine.applicableKinForChecklistItem(vipOnly, session(), listOf(dog, cat), plainHome),
        )
    }

    @Test
    fun perVisit_householdConditionWorksWithNoKinAtAll() {
        val hasGate = item(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "gateCode"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(hasGate, session(), emptyList(), withGate))
    }

    // ---- fail-open is preserved for genuinely unknown values ----

    @Test
    fun unknownHouseholdSource_stillFailsOpen() {
        val future = item(FieldCondition(source = "KINFOLK_MOOD", op = "EQUALS", value = "x"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(future, session(), listOf(dog), plainHome))
    }

    @Test
    fun unknownOpOnAKnownHouseholdSource_stillFailsOpen() {
        val future = item(FieldCondition(source = "KINFOLK_TAG", op = "REGEX_MATCH", value = "VIP"))
        assertTrue(KinTaleConditionEngine.isChecklistItemVisible(future, session(), listOf(dog), plainHome))
    }

    // ---- catalogs + editor helpers ----

    @Test
    fun everyKinfolkAttributeInCatalog_resolvesOnTheEngine() {
        // A household with every catalogued attribute populated must satisfy an
        // EXISTS condition for each catalogued key, so the editor can never offer
        // a key the engine reads as blank.
        val loadedHome = Kinfolk(
            _id = "HH",
            serviceAddress = "1 Bark Ave",
            gateCode = "4417",
            parkingInstructions = "driveway",
            entryNotes = "side door",
            emergencyContactName = "Sam",
            emergencyContactPhone = "555-0199",
            vetClinicName = "Paws Clinic",
        )
        for (attr in kinfolkAttributeCatalog) {
            val cond = item(FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = attr.key))
            assertTrue(
                KinTaleConditionEngine.isChecklistItemVisible(cond, session(), emptyList(), loadedHome),
                "catalog key '${attr.key}' (${attr.label}) is offered in the editor but the engine can't read it",
            )
        }
    }

    @Test
    fun kinfolkAttributeCatalog_matchesTheReactCatalogExactly() {
        // Keys are wire format and labels are shared copy, so both must stay
        // byte-identical to React's kinfolkAttributeCatalog (engine.ts:284-292).
        assertEquals(
            listOf(
                "serviceAddress" to "Service address",
                "gateCode" to "Gate code",
                "parkingInstructions" to "Parking instructions",
                "entryNotes" to "Entry notes",
                "emergencyContactName" to "Emergency contact",
                "emergencyContactPhone" to "Emergency contact phone",
                "vetClinicName" to "Vet on file",
            ),
            kinfolkAttributeCatalog.map { it.key to it.label },
        )
    }

    @Test
    fun conditionSourceOptions_offersAllFiveSourcesInReactOrder() {
        assertEquals(
            listOf(
                ConditionSource.KIN_SPECIES,
                ConditionSource.KIN_ATTRIBUTE,
                ConditionSource.SERVICE_TYPE,
                ConditionSource.KINFOLK_ATTRIBUTE,
                ConditionSource.KINFOLK_TAG,
            ),
            conditionSourceOptions.map { it.source },
        )
    }

    // ---- user-facing summary copy ----

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
        assertEquals(
            "Only show when the household's Gate code is not 4417",
            conditionSummary(
                FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "NOT_EQUALS", value = "4417", attributeKey = "gateCode"),
            ),
        )
        assertEquals(
            "Only show when the household's Service address contains Bark",
            conditionSummary(
                FieldCondition(
                    source = "KINFOLK_ATTRIBUTE", op = "CONTAINS", value = "Bark", attributeKey = "serviceAddress",
                ),
            ),
        )
    }

    @Test
    fun conditionSummary_householdAttribute_fallsBackToTheRawKeyThenAnAttribute() {
        assertEquals(
            "Only show when the household's wifiPassword is set",
            conditionSummary(
                FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EXISTS", attributeKey = "wifiPassword"),
            ),
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
    fun conditionSummary_blankValue_rendersAsBlankPlaceholder() {
        assertEquals(
            "Only show when the household is tagged (blank)",
            conditionSummary(FieldCondition(source = "KINFOLK_TAG", op = "EQUALS", value = "")),
        )
    }
}

/**
 * Byte-for-byte equivalence table against the React engine
 * (auntieos-admin/src/lib/kinTale/engine.ts). Every [expected] below is the
 * value React's `isChecklistItemVisible` returns for the same input, read off
 * the TypeScript source rather than off the Kotlin behavior, so a Kotlin-side
 * regression shows up as a failure instead of a silently agreed-upon bug.
 *
 * Rows deliberately include the edges the two implementations are most likely to
 * disagree on: KINFOLK_TAG CONTAINS (equality, not substring), a blank expected
 * value, blank-only tag lists, a null household, and the fail-open branches.
 */
class KinTaleConditionEngineReactParityTest {

    /** One row of the parity table. [why] names the React line the value comes from. */
    private data class ParityCase(
        val why: String,
        val condition: FieldCondition,
        val kinList: List<Kin>,
        val kinfolk: Kinfolk?,
        val expected: Boolean,
    )

    private val session = KinCareSession(serviceType = "Dog Walking")
    private val cat = Kin(name = "Mittens", species = "Cat")
    private val dog = Kin(name = "Rex", species = "Dog")

    private val withGate = Kinfolk(_id = "h1", gateCode = "4417")
    private val noGate = Kinfolk(_id = "h2")
    private val vipHome = Kinfolk(_id = "h3", tags = listOf("VIP", "new-2026"))
    private val plainHome = Kinfolk(_id = "h4", tags = emptyList())
    private val blankTagHome = Kinfolk(_id = "h5", tags = listOf("", "  "))
    private val paddedTagHome = Kinfolk(_id = "h6", tags = listOf("  VIP  "))
    private val loadedHome = Kinfolk(
        _id = "HH",
        serviceAddress = "1 Bark Ave",
        gateCode = "4417",
        parkingInstructions = "driveway",
        entryNotes = "side door",
        emergencyContactName = "Sam",
        emergencyContactPhone = "555-0199",
        vetClinicName = "Paws Clinic",
    )

    private fun kinfolkAttr(op: String, value: String = "", key: String = "") =
        FieldCondition(source = "KINFOLK_ATTRIBUTE", op = op, value = value, attributeKey = key)

    private fun kinfolkTag(op: String, value: String = "") =
        FieldCondition(source = "KINFOLK_TAG", op = op, value = value)

    private val cases: List<ParityCase> = listOf(
        // ── KINFOLK_ATTRIBUTE: routed through the generic matches() (engine.ts:109,121-122) ──
        ParityCase("EQUALS on a set attribute (engine.ts:134)", kinfolkAttr("EQUALS", "4417", "gateCode"), listOf(dog), withGate, true),
        ParityCase("EQUALS against a blank attribute", kinfolkAttr("EQUALS", "4417", "gateCode"), listOf(dog), noGate, false),
        ParityCase("EQUALS with no household: actual is '' (engine.ts:122)", kinfolkAttr("EQUALS", "4417", "gateCode"), listOf(dog), null, false),
        ParityCase("EQUALS blank vs blank is true (engine.ts:134)", kinfolkAttr("EQUALS", "", "gateCode"), listOf(dog), noGate, true),
        ParityCase("EQUALS is case-insensitive", kinfolkAttr("EQUALS", "paws clinic", "vetClinicName"), listOf(dog), loadedHome, true),
        ParityCase("EXISTS on a set attribute (engine.ts:140)", kinfolkAttr("EXISTS", key = "gateCode"), listOf(dog), withGate, true),
        ParityCase("EXISTS on a blank attribute", kinfolkAttr("EXISTS", key = "gateCode"), listOf(dog), noGate, false),
        ParityCase("EXISTS with no household", kinfolkAttr("EXISTS", key = "gateCode"), listOf(dog), null, false),
        ParityCase("EXISTS on an uncatalogued key reads '' (engine.ts:219-220)", kinfolkAttr("EXISTS", key = "wifiPassword"), listOf(dog), loadedHome, false),
        ParityCase("CONTAINS is a real substring test (engine.ts:138)", kinfolkAttr("CONTAINS", "Bark", "serviceAddress"), listOf(dog), loadedHome, true),
        ParityCase("CONTAINS misses when absent", kinfolkAttr("CONTAINS", "Oak", "serviceAddress"), listOf(dog), loadedHome, false),
        ParityCase("NOT_EQUALS on a matching attribute (engine.ts:136)", kinfolkAttr("NOT_EQUALS", "4417", "gateCode"), listOf(dog), withGate, false),
        ParityCase("NOT_EQUALS on a blank attribute", kinfolkAttr("NOT_EQUALS", "4417", "gateCode"), listOf(dog), noGate, true),
        ParityCase("NOT_EQUALS with no household", kinfolkAttr("NOT_EQUALS", "4417", "gateCode"), listOf(dog), null, true),
        ParityCase("household attribute needs no kin at all", kinfolkAttr("EXISTS", key = "gateCode"), emptyList(), withGate, true),

        // ── KINFOLK_TAG: intercepted before matches(), list semantics (engine.ts:106-108,149-161) ──
        ParityCase("CONTAINS means 'an equal tag is present' (engine.ts:157-159)", kinfolkTag("CONTAINS", "vip"), listOf(dog), vipHome, true),
        ParityCase("CONTAINS on an untagged household", kinfolkTag("CONTAINS", "vip"), listOf(dog), plainHome, false),
        ParityCase("CONTAINS with a tag that is not present", kinfolkTag("CONTAINS", "gold"), listOf(dog), vipHome, false),
        ParityCase("CONTAINS does NOT substring-match a tag (engine.ts:151)", kinfolkTag("CONTAINS", "VI"), listOf(dog), vipHome, false),
        ParityCase("EQUALS is the same test as CONTAINS", kinfolkTag("EQUALS", "VIP"), listOf(dog), vipHome, true),
        ParityCase("EQUALS matches the second tag too", kinfolkTag("EQUALS", "new-2026"), listOf(dog), vipHome, true),
        ParityCase("EQUALS trims the expected value (engine.ts:150)", kinfolkTag("EQUALS", " vip "), listOf(dog), vipHome, true),
        ParityCase("EQUALS trims the stored tag (engine.ts:151)", kinfolkTag("EQUALS", "VIP"), listOf(dog), paddedTagHome, true),
        ParityCase("EQUALS with no household reads [] (engine.ts:107)", kinfolkTag("EQUALS", "VIP"), listOf(dog), null, false),
        ParityCase("EQUALS on a blank value finds no tag here", kinfolkTag("EQUALS", ""), listOf(dog), vipHome, false),
        ParityCase("EQUALS on a blank value DOES match a blank tag", kinfolkTag("EQUALS", ""), listOf(dog), blankTagHome, true),
        ParityCase("NOT_EQUALS when the tag is present (engine.ts:155-156)", kinfolkTag("NOT_EQUALS", "VIP"), listOf(dog), vipHome, false),
        ParityCase("NOT_EQUALS when the tag is absent", kinfolkTag("NOT_EQUALS", "gold"), listOf(dog), vipHome, true),
        ParityCase("NOT_EQUALS with no household is TRUE", kinfolkTag("NOT_EQUALS", "VIP"), listOf(dog), null, true),
        ParityCase("EXISTS means 'has any non-blank tag' (engine.ts:153-154)", kinfolkTag("EXISTS"), listOf(dog), vipHome, true),
        ParityCase("EXISTS on an empty tag list", kinfolkTag("EXISTS"), listOf(dog), plainHome, false),
        ParityCase("EXISTS ignores blank-only tags", kinfolkTag("EXISTS"), listOf(dog), blankTagHome, false),
        ParityCase("EXISTS with no household", kinfolkTag("EXISTS"), listOf(dog), null, false),
        ParityCase("EXISTS ignores the typed value entirely", kinfolkTag("EXISTS", "gold"), listOf(dog), vipHome, true),

        // ── fail-open survives (engine.ts:101,103) ──
        ParityCase("unknown source fails open", FieldCondition(source = "KINFOLK_MOOD", op = "EQUALS", value = "x"), listOf(dog), plainHome, true),
        ParityCase("unknown op on a known source fails open", kinfolkTag("REGEX_MATCH", "VIP"), listOf(dog), vipHome, true),

        // ── the three original sources are unchanged by the new param (engine.ts:22-23) ──
        ParityCase("KIN_SPECIES with a household supplied", FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), listOf(cat), vipHome, true),
        ParityCase("KIN_SPECIES misses with a household supplied", FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat"), listOf(dog), vipHome, false),
        ParityCase("SERVICE_TYPE with a household supplied", FieldCondition(source = "SERVICE_TYPE", op = "CONTAINS", value = "walk"), emptyList(), vipHome, true),
    )

    @Test
    fun everyCase_matchesTheReactEngine() {
        for (case in cases) {
            // PER_VISIT so a single row is one evaluation, exactly like the React
            // table: PER_PET would additionally fold in kinList.some().
            val item = ChecklistItem(key = "k", text = "t", scope = "PER_VISIT", conditions = listOf(case.condition))
            assertEquals(
                case.expected,
                KinTaleConditionEngine.isChecklistItemVisible(item, session, case.kinList, case.kinfolk),
                "React parity broken: ${case.why} [source=${case.condition.source} op=${case.condition.op} " +
                    "value='${case.condition.value}' key='${case.condition.attributeKey}' household=${case.kinfolk?._id}]",
            )
        }
    }

    @Test
    fun theTableActuallyCoversBothVerdicts() {
        // Guards against a table that silently degenerates to all-true, which a
        // fail-open engine would pass without evaluating anything.
        assertTrue(cases.any { it.expected }, "parity table has no true cases")
        assertTrue(cases.any { !it.expected }, "parity table has no false cases")
    }
}
