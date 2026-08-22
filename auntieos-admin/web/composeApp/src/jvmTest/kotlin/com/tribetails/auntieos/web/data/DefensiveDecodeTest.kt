package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * WARNING-41/42 regression guard: the defensive-decode pattern used in both
 * JvmFirestoreRest.kt (WARNING-42) must satisfy three invariants. WARNING-41 was
 * the same pattern in FirestoreInterop.wasmJs.kt, deleted with the wasm admin in
 * #481; the invariants below are what that pattern has to keep meaning:
 *
 *  1. One malformed document does NOT discard the rest of the list.
 *  2. The number of successfully decoded items is (total - dropped).
 *  3. The drop count is computed correctly (zero when all valid).
 *
 * This test exercises the pure runCatching+mapNotNull+count pattern in isolation
 * so it can compile and run on JVM without any Firestore connection.
 */
class DefensiveDecodeTest {

    @Serializable
    private data class TestModel(val id: String, val value: Int)

    private val codec = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * Mirrors the pattern used in both platform-specific decode sites:
     *   decoded = raw.mapNotNull { runCatching { decode<T>(it) }.getOrNull() }
     *   dropped = raw.size - decoded.size
     */
    private inline fun <reified T> defensiveDecode(elements: List<JsonElement>): Pair<List<T>, Int> {
        val decoded = elements.mapNotNull { el ->
            runCatching { codec.decodeFromJsonElement<T>(el) }.getOrNull()
        }
        val dropped = elements.size - decoded.size
        return decoded to dropped
    }

    private fun parseArray(json: String): List<JsonElement> =
        codec.parseToJsonElement(json).let { it as JsonArray }.toList()

    @Test
    fun allValid_noneDropped() {
        val elements = parseArray(
            """[{"id":"a","value":1},{"id":"b","value":2},{"id":"c","value":3}]"""
        )
        val (decoded, dropped) = defensiveDecode<TestModel>(elements)
        assertEquals(3, decoded.size, "all 3 docs should decode")
        assertEquals(0, dropped, "zero docs should be dropped")
    }

    @Test
    fun oneMalformed_rest_survive() {
        // Middle element is missing required `value` field but has ignoreUnknownKeys —
        // a truly undecodable element: value is a string when an Int is expected.
        val elements = parseArray(
            """[{"id":"a","value":1},{"id":"bad","value":"not-an-int"},{"id":"c","value":3}]"""
        )
        // With isLenient + coerceInputValues = false (codec), a bad type should fail.
        // Actually with isLenient=true the parse may coerce. Test with a structurally
        // invalid element instead (null where a required nested object is expected).
        val elementsMixed = parseArray(
            """[{"id":"a","value":1},null,{"id":"c","value":3}]"""
        )
        val (decoded, dropped) = defensiveDecode<TestModel>(elementsMixed)
        // The null element cannot be decoded as TestModel; the other two should survive.
        assertEquals(2, decoded.size, "2 valid docs should survive the malformed one")
        assertEquals(1, dropped, "exactly 1 doc should be dropped")
        assertTrue(decoded.any { it.id == "a" }, "doc 'a' must survive")
        assertTrue(decoded.any { it.id == "c" }, "doc 'c' must survive")
    }

    @Test
    fun allMalformed_emptyListReturned_dropCountEqualsTotal() {
        // Every element is null (undecodable as TestModel).
        val elements = parseArray("""[null,null,null]""")
        val (decoded, dropped) = defensiveDecode<TestModel>(elements)
        assertEquals(0, decoded.size, "no valid docs should be returned")
        assertEquals(3, dropped, "all 3 docs should be counted as dropped")
    }

    @Test
    fun emptyArray_noDrops() {
        val (decoded, dropped) = defensiveDecode<TestModel>(emptyList())
        assertEquals(0, decoded.size)
        assertEquals(0, dropped)
    }

    @Test
    fun dropCount_isCorrect_forPartialFailure() {
        // 5 elements, 2 malformed.
        val elements = parseArray(
            """[{"id":"a","value":1},null,{"id":"c","value":3},null,{"id":"e","value":5}]"""
        )
        val (decoded, dropped) = defensiveDecode<TestModel>(elements)
        assertEquals(3, decoded.size)
        assertEquals(2, dropped)
    }
}
