package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.domain.TestMode
import com.tribetails.auntieos.domain.kinfolkScopeFilter
import kotlinx.coroutines.tasks.await

/**
 * Stage 0I seam: applies the test-admin sandbox constraint to every
 * kinfolk-scoped read, count, and query so a call site cannot forget it.
 *
 * A test admin (custom claim `testTribeId`, no `admin: true`) is HARD-restricted
 * by Firestore rules to docs where `kinfolkId == testTribeId` (and the single
 * kinfolk doc whose id == testTribeId). Rules cannot filter list queries, so the
 * client must constrain every kinfolk-scoped read itself or the broad
 * normal-admin reads are permission-denied. Before this seam existed that
 * constraint was a hand-inlined `if (mode.active)` fork copy-pasted into each
 * repository method - and a NEW read that forgot the fork silently leaked real
 * data into test mode. This class holds [mode] itself and applies the
 * constraint before any caller code runs, so the fork lives in exactly one
 * place. Decision logic stays in the pure, unit-tested [TestMode] selectors;
 * this seam only APPLIES it to Firestore access shapes.
 *
 * Three access shapes cover every kinfolk-scoped read in the app:
 *  - [scopedQuery]: a query over a collection carrying a `kinfolkId` field
 *    (invoices, payments, kin, ...). Sandbox mode adds
 *    `whereEqualTo(field, testTribeId)`; normal admin gets the query untouched.
 *  - [scopedRead]: a read over the `kinfolk` collection itself, which is scoped
 *    by DOC ID, not a field - in sandbox mode only `kinfolk/{testTribeId}` is
 *    reachable, so the read collapses to that single doc.
 *  - [scopedCount]: a count over a `kinfolkId`-scoped collection.
 *
 * [mode] is suspending and resolved once per call (parity with the old
 * per-method `requireTestMode()`): fail-loud, so a claim that cannot be read
 * propagates instead of silently running an unscoped query.
 */
class ScopedFirestore(
    private val firestore: FirebaseFirestore,
    private val mode: suspend () -> TestMode,
) {

    /**
     * Query a kinfolk-scoped collection and return the snapshot. In sandbox
     * mode the query is constrained with `whereEqualTo(field, testTribeId)`
     * BEFORE [build] runs; the normal-admin query is untouched. [build] appends
     * clauses common to both modes (e.g. a date range + orderBy).
     */
    suspend fun scopedQuery(
        collection: String,
        field: String = "kinfolkId",
        build: Query.() -> Query = { this },
    ): QuerySnapshot {
        // Resolve the mode BEFORE touching Firestore (parity with the old
        // requireTestMode()-first call sites): an unreadable claim fails loud
        // here instead of leaking an unscoped query.
        val filter = mode().kinfolkScopeFilter()
        val base: Query = firestore.collection(collection)
        val scoped = filter?.let { base.whereEqualTo(field, it) } ?: base
        return scoped.build().get().await()
    }

    /**
     * Divergent-shape query: for reads whose sandbox and normal-admin paths
     * differ beyond the scoping clause (e.g. `generated_drafts`, where the
     * sandbox sorts client-side to avoid a composite index while the operator
     * uses a server `orderBy` + `limit`). [sandbox] receives the query with the
     * scoping constraint ALREADY applied - it cannot be forgotten - plus the
     * active [TestMode] as receiver; [unscoped] receives the bare collection.
     */
    suspend fun <T> scopedQuery(
        collection: String,
        field: String = "kinfolkId",
        sandbox: suspend TestMode.(Query) -> T,
        unscoped: suspend (CollectionReference) -> T,
    ): T {
        val m = mode()
        val filter = m.kinfolkScopeFilter()
            ?: return unscoped(firestore.collection(collection))
        return m.sandbox(firestore.collection(collection).whereEqualTo(field, filter))
    }

    /**
     * Read over a collection scoped by DOC ID (the `kinfolk` collection): in
     * sandbox mode only `{collection}/{testTribeId}` is reachable, so the read
     * collapses to that single doc fetch and [sandbox] receives its snapshot
     * (with the active [TestMode] as receiver, e.g. for
     * [com.tribetails.auntieos.domain.allowsKinfolkDoc]); the normal admin's
     * [unscoped] receives the bare collection. Fail-loud: fetch errors propagate.
     */
    suspend fun <T> scopedRead(
        collection: String,
        sandbox: suspend TestMode.(DocumentSnapshot) -> T,
        unscoped: suspend (CollectionReference) -> T,
    ): T {
        val m = mode()
        val docId = m.kinfolkScopeFilter()
            ?: return unscoped(firestore.collection(collection))
        return m.sandbox(firestore.collection(collection).document(docId).get().await())
    }

    /**
     * Count over a kinfolk-scoped collection. Sandbox mode fetches the
     * `whereEqualTo(field, testTribeId)` snapshot and applies [sandbox] to it
     * (default: its size; override to count client-side, e.g. by status,
     * avoiding a composite index on the tiny sandbox set). The normal-admin
     * path sizes the collection with [unscoped] clauses applied.
     */
    suspend fun scopedCount(
        collection: String,
        field: String = "kinfolkId",
        sandbox: suspend (QuerySnapshot) -> Int = { it.size() },
        unscoped: Query.() -> Query = { this },
    ): Int {
        val filter = mode().kinfolkScopeFilter()
            ?: return firestore.collection(collection).unscoped().get().await().size()
        return sandbox(firestore.collection(collection).whereEqualTo(field, filter).get().await())
    }
}
