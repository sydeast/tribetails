package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.ConditionOp
import com.tribetails.auntieos.web.data.ConditionSource
import com.tribetails.auntieos.web.data.DefaultKinTaleTemplate
import com.tribetails.auntieos.web.data.FieldCondition
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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

    /**
     * #452: was assertIsNotBlank, enforcing the exact canned-message bug
     * #394/#431 ruled out on the other two platforms - the message is the
     * story of the visit, and a canned default invites sending it unedited.
     * `defaultEmailMessage` must stay on the [KinTaleTemplate] class default
     * ("") until a real template supplies its own.
     */
    @Test
    fun defaultTemplate_defaultEmailMessage_isBlank() {
        assertEquals("", DefaultKinTaleTemplate.template.defaultEmailMessage)
    }

    // ---- ConditionSource / ConditionOp wire format ----
    // FieldCondition.source and .op are plain Strings holding the CONSTANT NAME,
    // so these identifiers ARE the Firestore wire format. They must match the
    // React admin (src/lib/kinTale/model.ts) and the Android enums exactly, or a
    // condition authored on one platform stops parsing on another.

    @Test
    fun conditionSource_hasFiveWireNames_inParseWhitelistOrder() {
        // Order mirrors the React parse whitelist (engine.ts SOURCE_NAMES) and is
        // also the order the condition editor offers, so it is load-bearing.
        assertEquals(
            listOf("KIN_SPECIES", "KIN_ATTRIBUTE", "SERVICE_TYPE", "KINFOLK_ATTRIBUTE", "KINFOLK_TAG"),
            ConditionSource.entries.map { it.name },
        )
    }

    @Test
    fun conditionOp_hasFourWireNames_inParseWhitelistOrder() {
        assertEquals(
            listOf("EQUALS", "NOT_EQUALS", "CONTAINS", "EXISTS"),
            ConditionOp.entries.map { it.name },
        )
    }

    @Test
    fun conditionSource_kinfolkAttribute_parsesFromWireString() {
        assertEquals(ConditionSource.KINFOLK_ATTRIBUTE, ConditionSource.valueOf("KINFOLK_ATTRIBUTE"))
    }

    @Test
    fun conditionSource_kinfolkTag_parsesFromWireString() {
        assertEquals(ConditionSource.KINFOLK_TAG, ConditionSource.valueOf("KINFOLK_TAG"))
    }

    @Test
    fun conditionSource_unknownName_doesNotParse_documentingFailOpen() {
        // Documents the deliberate fail-open contract: an unrecognised source name
        // does not parse, and KinTaleConditionEngine turns that null into "always
        // visible" instead of throwing. Kept for FORWARD compatibility (a newer app
        // writing a source this build has never heard of must not hide the item).
        assertNull(runCatching { ConditionSource.valueOf("SOMETHING_NEWER") }.getOrNull())
    }

    @Test
    fun conditionSource_kinfolkNames_noLongerHitTheFailOpenBranch() {
        // The live bug this port closes. Both names were authored in the React admin
        // but missing from this enum, so they fell through to the fail-open branch
        // above and every KINFOLK_ATTRIBUTE / KINFOLK_TAG condition silently
        // evaluated TRUE on web and desktop. They must parse now.
        listOf("KINFOLK_ATTRIBUTE", "KINFOLK_TAG").forEach { wire ->
            assertNotNull(
                runCatching { ConditionSource.valueOf(wire) }.getOrNull(),
                "$wire must parse, or the engine fails open and the condition silently evaluates true",
            )
        }
    }

    @Test
    fun fieldCondition_defaults_matchWireContract() {
        val c = FieldCondition()
        assertEquals("KIN_SPECIES", c.source)
        assertEquals("EQUALS", c.op)
        assertEquals("", c.value)
        assertEquals("", c.attributeKey)
    }
}
