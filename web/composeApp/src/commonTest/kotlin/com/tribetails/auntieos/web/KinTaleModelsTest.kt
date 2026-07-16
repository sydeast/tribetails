package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Tests for KinTale model helpers and the built-in [DefaultKinTaleTemplate].
 */
class KinTaleModelsTest {

    @Test
    fun defaultTemplate_isActive() {
        assertTrue(DefaultKinTaleTemplate.template.isActive)
    }

    @Test
    fun defaultTemplate_isDefault() {
        assertTrue(DefaultKinTaleTemplate.template.isDefault)
    }

    @Test
    fun defaultTemplate_hasBuiltinId() {
        assertEquals(DefaultKinTaleTemplate.ID, DefaultKinTaleTemplate.template._id)
        assertEquals("__builtin_default__", DefaultKinTaleTemplate.template._id)
    }

    @Test
    fun defaultTemplate_hasNonEmptyName() {
        assertTrue(DefaultKinTaleTemplate.template.name.isNotBlank())
    }

    @Test
    fun defaultTemplate_checklistEnabled() {
        assertTrue(DefaultKinTaleTemplate.template.checklistEnabled)
    }

    @Test
    fun defaultTemplate_visitNotesEnabled() {
        assertTrue(DefaultKinTaleTemplate.template.visitNotesEnabled)
    }

    @Test
    fun defaultTemplate_photoShowcaseEnabled() {
        assertTrue(DefaultKinTaleTemplate.template.photoShowcaseEnabled)
    }

    @Test
    fun defaultTemplate_petMoodEnabled() {
        // Pet mood is live: the default template ships it on with options.
        assertTrue(DefaultKinTaleTemplate.template.petMoodEnabled)
    }

    @Test
    fun defaultTemplate_moodOptions_nonEmptyWithStableKeysAndOrder() {
        val moods = DefaultKinTaleTemplate.template.moodOptions
        assertTrue(moods.isNotEmpty(), "Default template must ship mood options")
        // Stable keys mirroring the Android default (KinTaleTemplateEngine).
        val keys = moods.map { it.key }
        assertEquals(
            listOf("happy", "playful", "calm", "cuddly", "anxious", "shy", "energetic", "sleepy"),
            keys,
        )
        // Order field matches list position so a round-tripped doc renders identically.
        moods.forEachIndexed { i, m -> assertEquals(i, m.order, "mood ${m.key} order") }
        // No blank labels/emojis (would render an empty pill).
        assertTrue(moods.all { it.label.isNotBlank() && it.emoji.isNotBlank() })
    }

    @Test
    fun defaultTemplate_reviewBoosterDisabled() {
        assertFalse(DefaultKinTaleTemplate.template.reviewBoosterEnabled)
    }

    @Test
    fun defaultTemplate_hasChecklistItems() {
        assertTrue(DefaultKinTaleTemplate.template.checklistItems.isNotEmpty())
    }

    @Test
    fun defaultTemplate_checklistContains_perPetItems() {
        val perPet = DefaultKinTaleTemplate.template.checklistItems.filter { it.scope == "PER_PET" }
        assertTrue(perPet.isNotEmpty(), "Default template must have PER_PET checklist items")
    }

    @Test
    fun defaultTemplate_checklistContains_perVisitItems() {
        val perVisit = DefaultKinTaleTemplate.template.checklistItems.filter { it.scope == "PER_VISIT" }
        assertTrue(perVisit.isNotEmpty(), "Default template must have PER_VISIT checklist items")
    }

    @Test
    fun defaultTemplate_peedItem_isRequired() {
        val peed = DefaultKinTaleTemplate.template.checklistItems.firstOrNull { it.key == "peed" }
        assertTrue(peed != null, "peed checklist item must exist")
        assertTrue(peed.required, "peed checklist item must be required")
    }

    @Test
    fun defaultTemplate_poedItem_isRequired() {
        val poed = DefaultKinTaleTemplate.template.checklistItems.firstOrNull { it.key == "pooed" }
        assertTrue(poed != null, "pooed checklist item must exist")
        assertTrue(poed.required, "pooed checklist item must be required")
    }

    @Test
    fun defaultTemplate_serviceTypeKeys_isEmpty() {
        // The default/catch-all template should not have specific service type keys
        // so it matches anything via the fallback logic
        assertTrue(DefaultKinTaleTemplate.template.serviceTypeKeys.isEmpty())
    }

    @Test
    fun defaultTemplate_defaultEmailMessage_isNotBlank() {
        assertTrue(DefaultKinTaleTemplate.template.defaultEmailMessage.isNotBlank())
    }
}
