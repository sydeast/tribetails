package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Pins the SENT KinTale report's checklist resolution. The sent report must render
 * off the REAL template the visit used (custom item labels + custom keys), not the
 * built-in default, and must honor conditions - so it never shows a checklist item
 * a condition excludes. Before this resolver, the web report read from
 * DefaultKinTaleTemplate, which silently dropped any custom checklist key and
 * showed the default label for renamed items.
 */
class SentChecklistResolverTest {

    private val dog = Kin(_id = "dog1", name = "Rex", species = "Dog")
    private val cat = Kin(_id = "cat1", name = "Mittens", species = "Cat")
    private val kinById = mapOf("dog1" to dog, "cat1" to cat)

    // A real, customised template (renamed "fed", custom "walk", a cat-only "litter", a per-visit item).
    private val template = KinTaleTemplate(
        checklistItems = listOf(
            ChecklistItem(key = "fed", text = "Morning meal", scope = "PER_PET", order = 0),
            ChecklistItem(key = "walk", text = "Neighborhood walk", scope = "PER_PET", order = 1),
            ChecklistItem(
                key = "litter", text = "Litter scooped", scope = "PER_PET", order = 2,
                conditions = listOf(FieldCondition(source = "KIN_SPECIES", op = "EQUALS", value = "Cat")),
            ),
            ChecklistItem(key = "locked", text = "Doors locked", scope = "PER_VISIT", order = 0),
        ),
    )

    private fun checked(fieldKey: String, kinId: String, value: Boolean = true) =
        FieldResponse(fieldKey = fieldKey, kinId = kinId, boolValue = value)

    private fun report(vararg responses: FieldResponse, serviceType: String = "Dog Walking") =
        KinCareReport(
            serviceType = serviceType,
            kinIds = listOf("dog1", "cat1"),
            fieldResponses = responses.associateBy { responseKey(it.fieldKey, it.kinId) },
        )

    // ── I7 household conditions on the SENT report ───────────────────────────
    // The resolver never passed a Kinfolk, so KINFOLK_* conditions evaluated
    // against a null household: KINFOLK_ATTRIBUTE read "" and KINFOLK_TAG read an
    // empty list. An EQUALS rule therefore never matched and the checked item was
    // silently HIDDEN from the sent report, which is the bug the I7 port existed
    // to fix on web and desktop.

    private val vipTemplate = KinTaleTemplate(
        checklistItems = listOf(
            ChecklistItem(
                key = "vip_note", text = "VIP welcome note", scope = "PER_PET", order = 0,
                conditions = listOf(FieldCondition(source = "KINFOLK_TAG", op = "CONTAINS", value = "VIP")),
            ),
            ChecklistItem(
                key = "gate", text = "Gate code used", scope = "PER_VISIT", order = 0,
                conditions = listOf(
                    // gateCode is a catalogued household attribute. An UNcatalogued
                    // key would read blank on purpose, so it would not prove the
                    // household was threaded through at all.
                    FieldCondition(source = "KINFOLK_ATTRIBUTE", op = "EQUALS", value = "1234", attributeKey = "gateCode"),
                ),
            ),
        ),
    )

    @Test
    fun kinfolkTagCondition_isHonoredWhenHouseholdSupplied() {
        val household = Kinfolk(_id = "hh1", tags = listOf("VIP"))
        val r = resolveSentChecklist(vipTemplate, report(checked("vip_note", "dog1")), kinById, household)
        assertEquals(listOf("VIP welcome note"), r.perKin.flatMap { it.items }.map { it.label })
    }

    @Test
    fun kinfolkTagCondition_hidesItemWhenHouseholdLacksTag() {
        val household = Kinfolk(_id = "hh1", tags = listOf("Standard"))
        val r = resolveSentChecklist(vipTemplate, report(checked("vip_note", "dog1")), kinById, household)
        assertTrue(r.perKin.isEmpty(), "non-VIP household must not render the VIP item")
    }

    @Test
    fun kinfolkAttributeCondition_isHonoredOnPerVisitItems() {
        val household = Kinfolk(_id = "hh1", gateCode = "1234")
        val r = resolveSentChecklist(vipTemplate, report(checked("gate", "")), kinById, household)
        assertEquals(listOf("Gate code used"), r.perVisit.map { it.label })
    }

    @Test
    fun kinfolkAttributeCondition_hidesItemWhenHouseholdIsUnresolved() {
        // The regression this whole block exists for: with no household the
        // attribute reads blank, EQUALS never matches, and a checked item
        // silently vanishes from the sent report.
        val r = resolveSentChecklist(vipTemplate, report(checked("gate", "")), kinById, kinfolk = null)
        assertTrue(r.perVisit.isEmpty(), "unresolved household cannot satisfy an EQUALS rule")
    }

    @Test
    fun customTemplateKey_checked_appearsWithRealLabel() {
        // "walk" is not in the built-in default template; the old code dropped it.
        val r = resolveSentChecklist(template, report(checked("walk", "dog1")), kinById)
        val items = r.perKin.single { it.kinId == "dog1" }.items
        assertEquals(listOf("Neighborhood walk"), items.map { it.label })
    }

    @Test
    fun renamedKey_usesRealTemplateLabel_notDefault() {
        // "fed" exists in the default template as "Fed"; the real template renamed it.
        val r = resolveSentChecklist(template, report(checked("fed", "dog1")), kinById)
        assertEquals(listOf("Morning meal"), r.perKin.single().items.map { it.label })
    }

    @Test
    fun perVisitItem_checked_appears() {
        val r = resolveSentChecklist(template, report(checked("locked", "")), kinById)
        assertEquals(listOf("Doors locked"), r.perVisit.map { it.label })
    }

    @Test
    fun conditionedOutItem_checkedButKinMismatches_isHidden() {
        // "litter" is cat-only; a stale check against a dog must not render.
        val r = resolveSentChecklist(template, report(checked("litter", "dog1")), kinById)
        assertTrue(r.perKin.none { it.items.any { i -> i.key == "litter" } })
    }

    @Test
    fun conditionedItem_checkedForMatchingKin_isShown() {
        val r = resolveSentChecklist(template, report(checked("litter", "cat1")), kinById)
        assertEquals(listOf("Litter scooped"), r.perKin.single { it.kinId == "cat1" }.items.map { it.label })
    }

    @Test
    fun checkedItem_kinUnresolvable_isStillShown() {
        // No regression: if the kin can't be resolved we can't evaluate KIN conditions,
        // so keep the checked item rather than silently dropping it.
        val r = resolveSentChecklist(template, report(checked("fed", "ghost")), kinById)
        assertEquals(listOf("Morning meal"), r.perKin.single { it.kinId == "ghost" }.items.map { it.label })
    }

    @Test
    fun items_followTemplateOrder() {
        val r = resolveSentChecklist(template, report(checked("walk", "dog1"), checked("fed", "dog1")), kinById)
        assertEquals(listOf("Morning meal", "Neighborhood walk"), r.perKin.single().items.map { it.label })
    }

    @Test
    fun uncheckedResponse_isExcluded() {
        val r = resolveSentChecklist(template, report(checked("fed", "dog1", value = false)), kinById)
        assertTrue(r.perKin.isEmpty())
    }

    @Test
    fun keyNotInTemplate_isDropped() {
        // A checked response for a key the current template no longer has can't be
        // labeled; drop it (parity with android, which iterates template items).
        val r = resolveSentChecklist(template, report(checked("ghost_key", "dog1")), kinById)
        assertTrue(r.perKin.isEmpty())
    }
}
