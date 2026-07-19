package com.tribetails.auntieos.data.model

import com.google.firebase.Timestamp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date

/**
 * Guards the Firestore-decode crash cluster (0.2.0+2). Firebase `toObject()`
 * calls the Kotlin-generated bean setter for each field; a non-null `String`
 * setter carries an `Intrinsics.checkNotNullParameter` and throws
 * InvocationTargetException when the doc stores `null`, blanking the whole
 * query. Two proofs per class of fix:
 *   1. constructing the model with null values compiles + runs (a reversion to a
 *      non-null type would fail to COMPILE this file), and
 *   2. invoking the setter reflectively with null / a Timestamp reproduces the
 *      exact toObject() mechanism and must not throw.
 */
class ModelNullSafetyDecodeTest {

    /** Reflectively invoke a Kotlin `var` setter with [value] - mirrors Firebase's
     *  CustomClassMapper. Throws (InvocationTargetException) iff the setter has a
     *  non-null intrinsic check and [value] is null. */
    private fun setVia(obj: Any, setter: String, paramType: Class<*>, value: Any?) {
        val m = obj.javaClass.getMethod(setter, paramType)
        m.invoke(obj, *arrayOf(value))
    }

    // ── Class B: null -> String? ─────────────────────────────────────────────

    @Test fun `KinCareSession accepts null lifecycle timestamps`() {
        val s = KinCareSession(
            onMyWayAt = null, arrivedAt = null, departedAt = null, completedAt = null,
        )
        assertEquals(null, s.arrivedAt)
        // Firebase-style: setter invoked with null must not throw.
        setVia(s, "setArrivedAt", String::class.java, null)
        setVia(s, "setDepartedAt", String::class.java, null)
        setVia(s, "setOnMyWayAt", String::class.java, null)
        setVia(s, "setCompletedAt", String::class.java, null)
    }

    @Test fun `KinCareReport accepts null sentAt arrivedAt departedAt`() {
        val r = KinCareReport(sentAt = null, arrivedAt = null, departedAt = null)
        assertEquals(null, r.sentAt)
        setVia(r, "setSentAt", String::class.java, null)
        setVia(r, "setArrivedAt", String::class.java, null)
        setVia(r, "setDepartedAt", String::class.java, null)
    }

    @Test fun `Kin411 accepts null repaired-for-UI strings`() {
        val k = Kin411(
            vetName = null, vetPhone = null,
            feedingAmount = null, feedingFrequency = null, pottyRoutine = null,
        )
        assertEquals(null, k.vetName)
        setVia(k, "setVetName", String::class.java, null)
        setVia(k, "setVetPhone", String::class.java, null)
        setVia(k, "setPottyRoutine", String::class.java, null)
    }

    @Test fun `Invoice accepts null paymentsHistory`() {
        val i = Invoice(paymentsHistory = null)
        assertEquals(null, i.paymentsHistory)
        setVia(i, "setPaymentsHistory", String::class.java, null)
    }

    @Test fun `Draft accepts null kinfolk fields and approvedAt`() {
        val d = Draft(kinfolkId = null, kinfolkName = null, approvedAt = null)
        assertEquals(null, d.kinfolkName)
        setVia(d, "setKinfolkId", String::class.java, null)
        setVia(d, "setKinfolkName", String::class.java, null)
        setVia(d, "setApprovedAt", String::class.java, null)
    }

    // ── Class A: Timestamp OR String (mixed) -> Any? ─────────────────────────

    @Test fun `createdAtIso converts a Firestore Timestamp to ISO`() {
        val s = KinCareSession(createdAt = Timestamp(Date(0L)))
        assertTrue(s.createdAtIso().startsWith("1970-01-01"))
    }

    @Test fun `createdAtIso passes an ISO String through unchanged`() {
        val s = KinCareSession(createdAt = "2026-06-27T17:07:24.579Z")
        assertEquals("2026-06-27T17:07:24.579Z", s.createdAtIso())
    }

    @Test fun `createdAtIso and updatedAtIso are blank for null`() {
        val s = KinCareSession(createdAt = null, updatedAt = null)
        assertEquals("", s.createdAtIso())
        assertEquals("", s.updatedAtIso())
    }

    @Test fun `KinCareSession createdAt setter tolerates Timestamp and String and null`() {
        val s = KinCareSession()
        setVia(s, "setCreatedAt", Any::class.java, Timestamp(Date(0L)))
        setVia(s, "setUpdatedAt", Any::class.java, "2026-01-01T00:00:00Z")
        setVia(s, "setCreatedAt", Any::class.java, null)
    }

    @Test fun `firestoreInstantToIso handles Timestamp Date String and null`() {
        assertTrue(firestoreInstantToIso(Timestamp(Date(0L))).startsWith("1970-01-01"))
        assertTrue(firestoreInstantToIso(Date(0L)).startsWith("1970-01-01"))
        assertEquals("2026-06-27T00:00:00Z", firestoreInstantToIso("2026-06-27T00:00:00Z"))
        assertEquals("", firestoreInstantToIso(null))
        assertEquals("", firestoreInstantToIso(42))
    }

    // ── Class C #7: enum-case mismatch, entityType stored as String ──────────

    @Test fun `MediaFile entityType decodes lowercase web value case-insensitively`() {
        assertEquals(MediaEntityType.KINFOLK, MediaFile(entityType = "kinfolk").entityTypeEnum)
        assertEquals(MediaEntityType.VISIT_LOG, MediaFile(entityType = "VISIT_LOG").entityTypeEnum)
        assertEquals(MediaEntityType.BUSINESS, MediaFile(entityType = " business ").entityTypeEnum)
    }

    @Test fun `MediaFile entityType unknown or blank falls back to KIN`() {
        assertEquals(MediaEntityType.KIN, MediaFile(entityType = "").entityTypeEnum)
        assertEquals(MediaEntityType.KIN, MediaFile(entityType = "not_a_type").entityTypeEnum)
        assertEquals(MediaEntityType.KIN, MediaFile().entityTypeEnum)
    }

    @Test fun `MediaFile entityType setter accepts a raw String`() {
        val f = MediaFile()
        setVia(f, "setEntityType", String::class.java, "kinfolk")
        assertEquals(MediaEntityType.KINFOLK, f.entityTypeEnum)
    }

    @Test fun `MediaEntityType fromWire is case-insensitive and null-safe`() {
        assertEquals(MediaEntityType.USER, MediaEntityType.fromWire("user"))
        assertEquals(MediaEntityType.KIN, MediaEntityType.fromWire(null))
    }
}
