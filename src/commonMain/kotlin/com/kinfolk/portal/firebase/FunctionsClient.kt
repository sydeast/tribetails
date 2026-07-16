package com.kinfolk.portal.firebase

import kotlinx.serialization.json.JsonObject

/**
 * Cross-platform Firebase Functions facade.
 * Backed by gitlive on android+js, by REST on jvm.
 *
 * Translation-layer (Path C) — every Firestore read goes through a Function so
 * AuntieOS schema can evolve independently of the kinfolk client.
 *
 * Wire format = `JsonObject`. Callers decode their own response shape.
 * Both impls deserialize to JsonObject natively, so no Map ↔ Json round-trip.
 */
interface FunctionsClient {
    /**
     * Invokes a callable Function. Returns the decoded `result` JsonObject.
     * Throws on permission/auth/network errors.
     */
    suspend fun call(name: String, payload: JsonObject?): JsonObject
}
