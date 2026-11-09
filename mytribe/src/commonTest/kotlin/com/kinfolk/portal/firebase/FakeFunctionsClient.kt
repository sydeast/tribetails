package com.kinfolk.portal.firebase

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Test-only FunctionsClient — feed canned JsonObject responses by name,
 * record the calls for assertions.
 */
class FakeFunctionsClient(
    private val responses: MutableMap<String, JsonObject> = mutableMapOf(),
    private val errors: MutableMap<String, Throwable> = mutableMapOf(),
) : FunctionsClient {

    val calls: MutableList<Pair<String, JsonObject?>> = mutableListOf()
    /**
     * #1504: the warm-on-open calls (payload exactly `{"__warm": true}`), by
     * callable name, kept apart from [calls]. A form now warms its own save as
     * it opens, and every assertion on [calls] is about what the household
     * SAVED: how many bookings went out, which rows a save sent. A warm call is
     * not a save, so it is recorded here, where the warm tests read it, instead
     * of shifting those counts. It answers like the server does
     * (`{ok: true, warm: true}`), unless [stubError] names the callable, so a
     * test can prove a failed warm stays silent.
     */
    val warmCalls: MutableList<String> = mutableListOf()

    /** Last stub wins: stubbing a response clears a prior error for [name]
     *  (and vice versa), so tests can model a server that recovers (retry). */
    fun stub(name: String, response: JsonObject) {
        responses[name] = response
        errors.remove(name)
    }

    private val sequences: MutableMap<String, ArrayDeque<JsonObject>> = mutableMapOf()
    /** Answers [name] with each response in turn, then keeps answering with the last one. */
    fun stubSequence(name: String, vararg answers: JsonObject) {
        errors.remove(name)
        responses[name] = answers.last()
        sequences[name] = ArrayDeque(answers.toList())
    }
    fun stubError(name: String, t: Throwable) {
        errors[name] = t
        responses.remove(name)
    }

    override suspend fun call(name: String, payload: JsonObject?): JsonObject {
        if (payload == WARM) {
            warmCalls += name
            errors[name]?.let { throw it }
            return WARM_REPLY
        }
        calls += name to payload
        errors[name]?.let { throw it }
        sequences[name]?.let { q -> if (q.size > 1) return q.removeFirst() }
        return responses[name] ?: error("FakeFunctionsClient: no stub for '$name'")
    }

    private companion object {
        val WARM = buildJsonObject { put("__warm", true) }
        val WARM_REPLY = buildJsonObject { put("ok", true); put("warm", true) }
    }
}
