package com.tribetails.auntieos.data.model

/**
 * What a Coverage Package Builder save is allowed to write: the fields that
 * ACTUALLY CHANGED since the document was read, and nothing else.
 *
 * WHY A DIFF AND NOT THE MODEL. `saveCoveragePackageConfig` used to hand Firestore
 * the whole [CoveragePackageConfig] under `SetOptions.merge()`. `merge()` protects
 * fields OUTSIDE the written map; it does nothing about stale fields INSIDE it.
 * That is the shape PR #312 fixed on `household_data`, #315 on `kinfolk` and
 * `kin`, and #327 on `business_settings`, and `saveCoveragePackageConfig` was the
 * site #327 named as still carrying it.
 *
 * WHAT THAT SHAPE COSTS ON THIS PARTICULAR DOCUMENT IS SMALL, AND SAYING SO IS
 * PART OF THE FIX. `coverage_package_config/config` models exactly one writable
 * field, `durations`, and it is the field every save intends to change. There is
 * no sibling field for a stale copy to revert - so the reversion #327 fixed on
 * `business_settings`, where 46 fields rode along inside one write, has no surface
 * here today. The write shape was dangerous; the damage was latent.
 *
 * TWO REAL LOSSES REMAIN, and this file plus [coveragePackageConfigFieldChanges]
 * exist for them:
 *
 *  1. A SAVE THAT CHANGED NOTHING still wrote the menu it read. The React admin
 *     writes the same document (`auntieos-admin/src/api/coveragePackageWrite.ts`
 *     sends `{ durations, updatedAt, updatedBy }` under `merge: true`), so a phone
 *     that loaded the menu and re-saved it unchanged put its own stale copy over a
 *     web edit made in between, and moved `updatedAt` to claim a change that never
 *     happened. Nothing changed now means nothing is written, not even the stamp.
 *  2. THE MODEL GAINING A FIELD would reopen the real thing. The moment
 *     `CoveragePackageConfig` carries a second writable field - a default booking
 *     lead time, a currency, anything - a whole-model write reverts it on every
 *     menu save, silently, exactly as `business_settings` did. `COVERAGE_PACKAGE_
 *     CONFIG_DIFF_FIELDS` is hand-written and `CoveragePackageConfigDiffTest`
 *     reflects over the model and fails if the two ever drift, so that field
 *     cannot arrive unnoticed.
 *
 * WHAT A FIELD-LEVEL DIFF CANNOT DO, stated so nobody reads more into it. Two
 * operators editing the visit menu at once still resolve last-write-wins: both
 * sides write `durations` as one whole array, so a duration added on the web
 * between this screen's load and its save is lost when the phone saves a menu
 * edit of its own. That is the design on BOTH sides - React writes the whole array
 * too - not a residual bug this change declined to fix. Element-level merging of
 * the menu would be a different feature with a different shape.
 */

/**
 * Fields on `coverage_package_config/config` this client may write, keyed by
 * Firestore field name.
 *
 * Absent ON PURPOSE, see [COVERAGE_PACKAGE_CONFIG_SERVER_OWNED]: the document id
 * and the two stamp fields. Named there rather than merely omitted so the drift
 * guard can tell "deliberately not ours" from "forgotten".
 *
 * Written out by hand rather than reflected, so it survives R8 and reads as the
 * contract it is. Note the single entry is the point, not an oversight: this
 * document really does model one writable field, and the guard is what keeps that
 * true on purpose rather than by luck.
 */
internal val COVERAGE_PACKAGE_CONFIG_DIFF_FIELDS: Map<String, (CoveragePackageConfig) -> Any?> =
    linkedMapOf(
        "durations" to { it.durations },
    )

/**
 * `coverage_package_config/config` fields this client must never write, and who
 * owns each.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `updatedAt`  stamped at write time by the repository, never round-tripped
 * - `updatedBy`  same, from the caller's actor string
 *
 * The legacy `rules` field an old document may still carry is not listed because
 * it is not on this model at all: it is ignored on read on both clients, and
 * `SetOptions.merge()` is what leaves it alone on write.
 */
internal val COVERAGE_PACKAGE_CONFIG_SERVER_OWNED = setOf("id", "updatedAt", "updatedBy")

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field name.
 * Empty when nothing changed, which the caller must treat as "do not write" rather
 * than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A menu cleared to empty IS a change and is written as `[]`. Skipping it would
 * make "take every visit length off the menu" the one edit no screen can perform.
 */
internal fun coveragePackageConfigFieldChanges(
    loaded: CoveragePackageConfig,
    edited: CoveragePackageConfig,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in COVERAGE_PACKAGE_CONFIG_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
