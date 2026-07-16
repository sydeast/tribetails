package com.tribetails.auntieos.web.screens.admin.formschemas

import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeListRepo(
    var schemas: MutableMap<String, FormSchema> = mutableMapOf(),
    var nextDeleteResult: WriteResult<Unit>? = null,
) : FormSchemaRepository {
    val deletedIds = mutableListOf<String>()
    override suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>> =
        WriteResult.Ok(schemas.values.map { FormSchemaSummary(id = it.id, name = it.name, version = it.version) })
    override suspend fun getSchema(id: String): WriteResult<FormSchema> =
        schemas[id]?.let { WriteResult.Ok(it) } ?: WriteResult.Err("not found")
    override suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema> = WriteResult.Ok(schema)
    override suspend fun deleteSchema(id: String): WriteResult<Unit> {
        deletedIds += id
        nextDeleteResult?.let { return it }
        schemas.remove(id)
        return WriteResult.Ok(Unit)
    }
}

/**
 * Covers the FormSchema list-row delete wiring: the pure [deleteResultMessage]
 * fail-loud mapper, plus the repository delete path the confirm dialog drives
 * (the deployed deleteFormSchema callable is faked here).
 */
class FormSchemaListDeleteTest {

    @Test
    fun okResultProducesNoBannerMessage() {
        assertNull(deleteResultMessage(WriteResult.Ok(Unit)))
    }

    @Test
    fun errResultProducesFailLoudMessage() {
        val msg = deleteResultMessage(WriteResult.Err("permission-denied"))
        assertTrue(msg != null && msg.contains("deleteFormSchema failed"))
        assertTrue(msg!!.contains("permission-denied"))
    }

    @Test
    fun deleteRemovesTheSchemaAndReportsTheId() = runTest {
        val repo = FakeListRepo(schemas = mutableMapOf("s1" to FormSchema(id = "s1", name = "One")))
        val message = deleteResultMessage(repo.deleteSchema("s1"))
        assertNull(message)
        assertEquals(listOf("s1"), repo.deletedIds)
        assertTrue(repo.schemas.isEmpty(), "deleted schema must be gone so the reloaded list drops it")
    }

    @Test
    fun deleteFailureKeepsSchemaAndFailsLoud() = runTest {
        val repo = FakeListRepo(
            schemas = mutableMapOf("s1" to FormSchema(id = "s1", name = "One")),
            nextDeleteResult = WriteResult.Err("boom"),
        )
        val message = deleteResultMessage(repo.deleteSchema("s1"))
        assertTrue(message != null && message.contains("boom"))
        assertTrue(repo.schemas.containsKey("s1"), "a failed delete must not drop the row")
    }
}
