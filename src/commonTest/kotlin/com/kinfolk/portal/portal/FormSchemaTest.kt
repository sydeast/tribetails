package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class FormSchemaTest {

    @Test
    fun `getFormSchema decodes sections + fields`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getFormSchema", buildJsonObject {
            put("id", "tribeProfile")
            put("name", "Tribe Profile")
            put("version", 1L)
            put("sections", buildJsonArray {
                add(buildJsonObject {
                    put("title", "Contact")
                    put("fields", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "displayName")
                            put("label", "Family Display Name")
                            put("type", "text")
                            put("required", true)
                        })
                        add(buildJsonObject {
                            put("key", "preferredCallTime")
                            put("label", "Best time to call")
                            put("type", "select")
                            put("options", buildJsonArray { add("Morning"); add("Afternoon") })
                        })
                    })
                })
            })
        })
        val s = PortalApi(fake).getFormSchema("tribeProfile")
        assertEquals("tribeProfile", s.id)
        assertEquals(1, s.sections.size)
        val f1 = s.sections[0].fields[0]
        assertEquals("displayName", f1.key)
        assertEquals(FormFieldType.Text, f1.type)
        assertTrue(f1.required)
        val f2 = s.sections[0].fields[1]
        assertEquals(FormFieldType.Select, f2.type)
        assertEquals(listOf("Morning", "Afternoon"), f2.options)
    }

    @Test
    fun `getFormSchema unknown type defaults to Text`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getFormSchema", buildJsonObject {
            put("id", "x")
            put("name", "X")
            put("sections", buildJsonArray {
                add(buildJsonObject {
                    put("title", "T")
                    put("fields", buildJsonArray {
                        add(buildJsonObject {
                            put("key", "k")
                            put("label", "L")
                            put("type", "bogus_type")
                        })
                    })
                })
            })
        })
        val s = PortalApi(fake).getFormSchema("x")
        assertEquals(FormFieldType.Text, s.sections[0].fields[0].type)
    }
}
