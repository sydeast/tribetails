package com.kinfolk.portal.firebase

import kotlinx.serialization.json.JsonObject

/**
 * Test-only FunctionsClient — feed canned JsonObject responses by name,
 * record the calls for assertions.
 */
class FakeFunctionsClient(
    private val responses: MutableMap<String, JsonObject> = mutableMapOf(),
    private val errors: MutableMap<String, Throwable> = mutableMapOf(),
) : FunctionsClient {

    val calls: MutableList<Pair<String, JsonObject?>> = mutableListOf()

    /** Last stub wins: stubbing a response clears a prior error for [name]
     *  (and vice versa), so tests can model a server that recovers (retry). */
    fun stub(name: String, response: JsonObject) {
        responses[name] = response
        errors.remove(name)
    }

    fun stubError(name: String, t: Throwable) {
        errors[name] = t
        responses.remove(name)
    }

    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        calls += name to payload
        errors[name]?.let { throw it }
        return responses[name] ?: error("FakeFunctionsClient: no stub for '$name'")
    }
}
