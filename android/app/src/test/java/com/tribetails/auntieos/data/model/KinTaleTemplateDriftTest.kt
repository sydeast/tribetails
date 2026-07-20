package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Guards two contract-drift bugs in the android KinTale model (I7 port).
 *
 * 1. ConditionSource was three-valued while React authors five. `source` is
 *    stored as a plain String and the engine fails OPEN on an unknown value, so
 *    every KINFOLK_ATTRIBUTE / KINFOLK_TAG condition authored in the React admin
 *    silently evaluated TRUE on android. The constant NAME is the wire format,
 *    so these assertions are byte-level contract checks against
 *    auntieos-admin/src/lib/kinTale/model.ts:25-40.
 *
 * 2. ChecklistItem had no `required` field while React (model.ts:88) and
 *    commonMain (KinTaleModels.kt ChecklistItem.required) both do. Android
 *    writes the WHOLE template object back (`AuntieRepository` .set(template)),
 *    so a field absent from the android model is WIPED from the doc on any
 *    android edit. The round-trip test below reproduces load-then-save.
 */
class KinTaleTemplateDriftTest {

    // ── Firestore mapper mimic ───────────────────────────────────────────────
    // Firebase's CustomClassMapper decodes by invoking the bean setter for each
    // stored key and encodes by reading every bean getter. Reproducing that with
    // reflection (the same technique as ModelNullSafetyDecodeTest) proves the
    // drift without needing Firebase runtime or Android statics. It deliberately
    // does not model Firestore's numeric widening (ints arrive as Long), which is
    // not what these tests are about, so raw docs here use Int for Int fields.

    private val modelPackage = "com.tribetails.auntieos.data.model"

    /** Decode a raw Firestore doc onto [target], failing loud if the model has no
     *  setter for a stored key (that is exactly the field-drops-on-save bug). */
    private fun decodeOnto(target: Any, raw: Map<String, Any?>) {
        raw.forEach { (key, value) ->
            val setterName = "set" + key.replaceFirstChar { it.uppercaseChar() }
            val setter = target.javaClass.methods.firstOrNull {
                it.name == setterName && it.parameterCount == 1
            } ?: throw AssertionError(
                "${target.javaClass.simpleName} has no setter for stored field '$key'. " +
                    "Firestore would drop it on decode and the whole-object write would " +
                    "then WIPE it from the document."
            )
            setter.invoke(target, *arrayOf(value))
        }
    }

    /** Encode a model object the way CustomClassMapper writes it back. */
    private fun encode(obj: Any): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        obj.javaClass.methods
            .filter { it.parameterCount == 0 && it.name != "getClass" }
            .filter { it.name.startsWith("get") || it.name.startsWith("is") }
            .forEach { m ->
                val prop = (if (m.name.startsWith("get")) m.name.drop(3) else m.name.drop(2))
                    .replaceFirstChar { it.lowercaseChar() }
                if (prop.isNotEmpty()) out[prop] = encodeValue(m.invoke(obj))
            }
        return out
    }

    private fun encodeValue(v: Any?): Any? = when {
        v == null -> null
        v is List<*> -> v.map { encodeValue(it) }
        v.javaClass.isEnum -> (v as Enum<*>).name
        v.javaClass.name.startsWith(modelPackage) -> encode(v)
        else -> v
    }

    // ── 1. ConditionSource wire contract ─────────────────────────────────────

    @Test fun `ConditionSource carries all five React sources`() {
        assertEquals(
            listOf("KIN_SPECIES", "KIN_ATTRIBUTE", "SERVICE_TYPE", "KINFOLK_ATTRIBUTE", "KINFOLK_TAG"),
            ConditionSource.values().map { it.name },
        )
    }

    @Test fun `ConditionSource parses the two new React wire strings`() {
        assertEquals(ConditionSource.KINFOLK_ATTRIBUTE, ConditionSource.valueOf("KINFOLK_ATTRIBUTE"))
        assertEquals(ConditionSource.KINFOLK_TAG, ConditionSource.valueOf("KINFOLK_TAG"))
    }

    @Test fun `a KINFOLK_TAG condition round-trips as the exact wire string`() {
        val raw = mapOf<String, Any?>(
            "source" to "KINFOLK_TAG",
            "op" to "EQUALS",
            "value" to "VIP",
            "attributeKey" to "",
        )
        val decoded = FieldCondition()
        decodeOnto(decoded, raw)
        assertEquals(ConditionSource.KINFOLK_TAG.name, decoded.source)

        val saved = encode(decoded)
        assertEquals("KINFOLK_TAG", saved["source"])
        assertEquals("EQUALS", saved["op"])
        assertEquals("VIP", saved["value"])
    }

    @Test fun `a KINFOLK_ATTRIBUTE condition keeps its attributeKey through save`() {
        val raw = mapOf<String, Any?>(
            "source" to "KINFOLK_ATTRIBUTE",
            "op" to "EXISTS",
            "value" to "",
            "attributeKey" to "gateCode",
        )
        val decoded = FieldCondition()
        decodeOnto(decoded, raw)
        val saved = encode(decoded)
        assertEquals("KINFOLK_ATTRIBUTE", saved["source"])
        assertEquals("gateCode", saved["attributeKey"])
    }

    // ── 2. ChecklistItem.required ────────────────────────────────────────────

    @Test fun `ChecklistItem required defaults to false so existing docs are unaffected`() {
        assertFalse(ChecklistItem().required)
    }

    @Test fun `a required checklist item survives android load-then-save`() {
        // A doc written by React or by the Compose app, carrying required = true.
        val storedItem = mapOf<String, Any?>(
            "key" to "meds",
            "text" to "Meds given",
            "scope" to "PER_PET",
            "showWhenUnchecked" to false,
            "required" to true,
            "order" to 0,
        )

        // LOAD: android decodes the doc onto its model.
        val loaded = ChecklistItem()
        decodeOnto(loaded, storedItem)
        assertTrue("required must decode onto the android model", loaded.required)

        // SAVE: android writes the WHOLE template back, so the re-encoded
        // checklist item is literally what lands in Firestore.
        val template = KinTaleTemplate(name = "Default Pet Care Report", checklistItems = listOf(loaded))
        val saved = encode(template)

        @Suppress("UNCHECKED_CAST")
        val savedItems = saved["checklistItems"] as List<Map<String, Any?>>
        assertEquals(1, savedItems.size)
        assertEquals(
            "required was stripped by the android whole-object write",
            true,
            savedItems[0]["required"],
        )
        assertEquals("meds", savedItems[0]["key"])
        assertEquals("PER_PET", savedItems[0]["scope"])
    }

    @Test fun `a not-required item saves required false rather than dropping the key`() {
        val loaded = ChecklistItem()
        decodeOnto(loaded, mapOf<String, Any?>("key" to "water", "text" to "Fresh water", "required" to false))
        val saved = encode(KinTaleTemplate(checklistItems = listOf(loaded)))

        @Suppress("UNCHECKED_CAST")
        val savedItems = saved["checklistItems"] as List<Map<String, Any?>>
        assertEquals(false, savedItems[0]["required"])
    }
}
