package com.tribetails.auntieos.web.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Form schema field - one editable input on a form. `type` enum is documented
 * in the formSchemas spec; only the 9 values in [FormSchema.SUPPORTED_TYPES]
 * are accepted by the Cloud Function on write.
 */
@Serializable
data class FormFieldSpec(
    val key: String = "",
    val label: String = "",
    val type: String = "text",
    val required: Boolean = false,
    val helperText: String? = null,
    val placeholder: String? = null,
    val options: List<String>? = null,
    val defaultValue: String? = null,
    val group: String? = null,
)

@Serializable
data class FormSectionSpec(
    val title: String = "",
    val description: String? = null,
    val fields: List<FormFieldSpec> = emptyList(),
)

/**
 * Full schema document. Server bumps [version] + stamps [updatedAt] + [updatedBy]
 * on every save; client sends the value it last saw (last-write-wins v1).
 */
@Serializable
data class FormSchema(
    val id: String = "",
    val name: String = "",
    val description: String? = null,
    // 1C placement: which entity this schema attaches to (NONE = global/standalone).
    val appliesTo: String = "NONE",
    val version: Int = 0,
    val sections: List<FormSectionSpec> = emptyList(),
    val createdAt: String = "",
    val updatedAt: String = "",
    val updatedBy: String = "",
) {
    companion object {
        val SUPPORTED_TYPES = listOf(
            "text", "textarea", "select", "multiselect",
            "date", "number", "checkbox", "phone", "email",
        )

        // Mirrors the server APPLIES_TO enum. NONE = global schema (e.g. tribeProfile).
        val APPLIES_TO = listOf("NONE", "KINFOLK", "KIN", "HOUSEHOLD", "SESSION", "BOOKING", "KINTALE")

        fun typeRequiresOptions(type: String): Boolean =
            type == "select" || type == "multiselect"
    }
}

/**
 * Summary row returned by listFormSchemas - keeps the wire payload small for
 * the admin list view; full schema only fetched on edit.
 */
@Serializable
data class FormSchemaSummary(
    val id: String = "",
    val name: String = "",
    val appliesTo: String = "NONE",
    val version: Int = 0,
    val updatedAt: String = "",
    val updatedBy: String = "",
)

/**
 * Ids of the form_schemas placed on a given entity ([target] = an APPLIES_TO value
 * such as "KIN", "KINFOLK", "SESSION", "BOOKING", "KINTALE"). Pure + case-insensitive;
 * the single shared filter every dynamic-fields consumer screen uses (Phase 14).
 */
fun appliesToSchemaIds(summaries: List<FormSchemaSummary>, target: String): List<String> =
    summaries.filter { it.appliesTo.equals(target, ignoreCase = true) }.map { it.id }

/**
 * Repository surface for the formSchemas Cloud Functions. Defined as an
 * interface so the editor ViewModel can be unit-tested against a fake.
 */
interface FormSchemaRepository {
    suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>>
    suspend fun getSchema(id: String): WriteResult<FormSchema>
    suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema>
    suspend fun deleteSchema(id: String): WriteResult<Unit>
}

/**
 * Production implementation - wraps the four callables documented in the
 * formSchemas spec. Mirrors [TemplateService]'s pattern: hand-built JSON
 * payloads, decode through [Json] to keep `ignoreUnknownKeys` semantics
 * (so newer backend fields don't crash the wasm client).
 */
class CloudFormSchemaRepository(
    private val invoke: suspend (name: String, payloadJson: String) -> WriteResult<String> = ::platformInvokeCallable,
) : FormSchemaRepository {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override suspend fun listSchemas(): WriteResult<List<FormSchemaSummary>> {
        return when (val r = invoke("listFormSchemas", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching {
                val obj = json.parseToJsonElement(r.value).jsonObject
                val arr = obj["schemas"] as? JsonArray ?: JsonArray(emptyList())
                WriteResult.Ok(arr.map { decodeSummary(it.jsonObject) })
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    override suspend fun getSchema(id: String): WriteResult<FormSchema> {
        // Backend Zod parses `{ schemaId: string }` - must match the function contract.
        val payload = buildJsonObject { put("schemaId", JsonPrimitive(id)) }
        return when (val r = invoke("getFormSchema", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching {
                val obj = json.parseToJsonElement(r.value).jsonObject
                val schemaObj = (obj["schema"] as? JsonObject) ?: obj
                WriteResult.Ok(decodeSchema(schemaObj))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    override suspend fun saveSchema(schema: FormSchema): WriteResult<FormSchema> {
        val payload = buildJsonObject {
            put("schema", encodeSchema(schema))
        }
        return when (val r = invoke("saveFormSchema", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching {
                val obj = json.parseToJsonElement(r.value).jsonObject
                val id = obj["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
                val version = obj["version"]?.jsonPrimitive?.intOrNull ?: schema.version
                // Server is authoritative for id + version; merge into local snapshot.
                WriteResult.Ok(schema.copy(id = id.ifBlank { schema.id }, version = version))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    override suspend fun deleteSchema(id: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("id", JsonPrimitive(id)) }
        return when (val r = invoke("deleteFormSchema", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> WriteResult.Ok(Unit)
        }
    }

    // ---- JSON helpers ----

    private fun decodeSummary(o: JsonObject): FormSchemaSummary = FormSchemaSummary(
        id        = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        name      = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        appliesTo = o["appliesTo"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } ?: "NONE",
        version   = o["version"]?.jsonPrimitive?.intOrNull ?: 0,
        updatedAt = o["updatedAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        updatedBy = o["updatedBy"]?.jsonPrimitive?.contentOrNull.orEmpty(),
    )

    private fun decodeSchema(o: JsonObject): FormSchema = FormSchema(
        id          = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        name        = o["name"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        description = o["description"]?.jsonPrimitive?.contentOrNull,
        appliesTo   = o["appliesTo"]?.jsonPrimitive?.contentOrNull?.ifBlank { null } ?: "NONE",
        version     = o["version"]?.jsonPrimitive?.intOrNull ?: 0,
        sections    = (o["sections"] as? JsonArray)?.map { decodeSection(it.jsonObject) }.orEmpty(),
        createdAt   = o["createdAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        updatedAt   = o["updatedAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        updatedBy   = o["updatedBy"]?.jsonPrimitive?.contentOrNull.orEmpty(),
    )

    private fun decodeSection(o: JsonObject): FormSectionSpec = FormSectionSpec(
        title       = o["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        description = o["description"]?.jsonPrimitive?.contentOrNull,
        fields      = (o["fields"] as? JsonArray)?.map { decodeField(it.jsonObject) }.orEmpty(),
    )

    private fun decodeField(o: JsonObject): FormFieldSpec = FormFieldSpec(
        key          = o["key"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        label        = o["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        type         = o["type"]?.jsonPrimitive?.contentOrNull.orEmpty().ifBlank { "text" },
        required     = o["required"]?.jsonPrimitive?.booleanOrNull ?: false,
        helperText   = o["helperText"]?.jsonPrimitive?.contentOrNull,
        placeholder  = o["placeholder"]?.jsonPrimitive?.contentOrNull,
        options      = (o["options"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull },
        defaultValue = o["defaultValue"]?.jsonPrimitive?.contentOrNull,
        group        = o["group"]?.jsonPrimitive?.contentOrNull,
    )

    private fun encodeSchema(s: FormSchema): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(s.id))
        put("name", JsonPrimitive(s.name))
        s.description?.let { put("description", JsonPrimitive(it)) }
        put("appliesTo", JsonPrimitive(s.appliesTo))
        put("version", JsonPrimitive(s.version))
        put("sections", buildJsonArray { s.sections.forEach { add(encodeSection(it)) } })
    }

    private fun encodeSection(s: FormSectionSpec): JsonObject = buildJsonObject {
        put("title", JsonPrimitive(s.title))
        s.description?.let { put("description", JsonPrimitive(it)) }
        put("fields", buildJsonArray { s.fields.forEach { add(encodeField(it)) } })
    }

    private fun encodeField(f: FormFieldSpec): JsonObject = buildJsonObject {
        put("key", JsonPrimitive(f.key))
        put("label", JsonPrimitive(f.label))
        put("type", JsonPrimitive(f.type))
        put("required", JsonPrimitive(f.required))
        f.helperText?.let { put("helperText", JsonPrimitive(it)) }
        f.placeholder?.let { put("placeholder", JsonPrimitive(it)) }
        f.options?.let { opts ->
            put("options", buildJsonArray { opts.forEach { add(JsonPrimitive(it)) } })
        }
        f.defaultValue?.let { put("defaultValue", JsonPrimitive(it)) }
        f.group?.let { put("group", JsonPrimitive(it)) }
    }
}
