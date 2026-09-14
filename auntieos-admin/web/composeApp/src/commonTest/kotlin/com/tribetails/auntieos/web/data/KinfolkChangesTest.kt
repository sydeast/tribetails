package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** #829 review: per-key custom field writes and Firestore field-path quoting. */
class KinfolkChangesTest {

    @Test
    fun fieldPathsQuoteAnythingThatIsNotAPlainIdentifier() {
        assertEquals("gateCode", firestoreFieldPath(listOf("gateCode")))
        assertEquals("formValues.petName", firestoreFieldPath(listOf("formValues", "petName")))
        assertEquals("formValues.`pet.vet`", firestoreFieldPath(listOf("formValues", "pet.vet")))
        assertEquals("formValues.`pet name`", firestoreFieldPath(listOf("formValues", "pet name")))
        assertEquals("formValues.`2nd-vet`", firestoreFieldPath(listOf("formValues", "2nd-vet")))
        assertEquals("formValues.`a\\`b\\\\c`", firestoreFieldPath(listOf("formValues", "a`b\\c")))
        assertFailsWith<IllegalArgumentException> { firestoreFieldPath(listOf("formValues", "")) }
    }

    @Test
    fun onlyTheChangedCustomKeyIsAChange() {
        val loaded = Kinfolk(_id = "kf1", formValues = mapOf("a" to "1", "b" to "2"))
        val edited = loaded.copy(formValues = mapOf("a" to "1", "b" to "3", "c" to "new"))
        val changes = kinfolkChanges(loaded, edited)
        assertEquals(
            listOf(
                KinfolkFieldChange(listOf("formValues", "b"), JsonPrimitive("3")),
                KinfolkFieldChange(listOf("formValues", "c"), JsonPrimitive("new")),
            ),
            changes,
        )
    }

    @Test
    fun theBodyNestsSetsAndLeavesDeletesOut() {
        val body = kinfolkChangesBody(
            listOf(
                KinfolkFieldChange(listOf("gateCode"), JsonPrimitive("9999")),
                KinfolkFieldChange(listOf("formValues", "pet.vet"), JsonPrimitive("Dr Ruiz")),
                KinfolkFieldChange(listOf("formValues", "notes"), null),
            ),
        )
        assertEquals(Json.parseToJsonElement("""{"gateCode":"9999","formValues":{"pet.vet":"Dr Ruiz"}}"""), body)
    }

    @Test
    fun removingEveryCustomKeyDeletesEachOneAndNothingElse() {
        val loaded = Kinfolk(_id = "kf1", formValues = mapOf("a" to "1"))
        val changes = kinfolkChanges(loaded, loaded.copy(formValues = emptyMap()))
        assertEquals(listOf(KinfolkFieldChange(listOf("formValues", "a"), null)), changes)
        assertTrue(kinfolkChangesBody(changes).isEmpty())
    }
}
