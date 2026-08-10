package com.tribetails.auntieos.data.model

/**
 * What a base-service save is allowed to write: the fields that ACTUALLY
 * CHANGED since the document was read, and nothing else.
 *
 * WHY THIS DOCUMENT IS DIFFERENT FROM THE FOUR BEFORE IT. PRs #312
 * (`household_data`), #315 (`kinfolk`/`kin`), #327 (`business_settings`) and
 * #332 (`coverage_package_config`) each removed a whole-model
 * `.set(model, merge())`. `merge()` protects fields OUTSIDE the written map and
 * does nothing about stale fields inside it, so those saves reverted concurrent
 * edits. `ServiceRepository.updateBaseService` carried the WORSE shape: a bare
 * `.set(model)` with NO merge option at all. A bare set REPLACES the document,
 * so every field not present in the written object is DELETED, not merely
 * written back stale.
 *
 * AND `base_services/{id}` CARRIES SEVEN FIELDS THIS MODEL HAS NEVER DECLARED,
 * every one of them read server-side. See [BASE_SERVICE_PORTAL_OWNED]. The
 * whole-model write deleted all seven on every edit an operator made on the
 * phone, and nothing put them back: no callable, no script and no React admin
 * path writes this collection, so android is its only writer
 * (`mytribe/firestore.rules:805` grants `write: if isAuntie()`).
 *
 * WHAT THAT COST, in plain terms:
 *
 *  1. `portal/requestBooking.ts#resolveService` reads `priceCents` as the
 *     canonical, server-trusted price for a kinfolk booking, precisely so a
 *     client cannot assert its own. It has NO fallback to `basePrice`. With
 *     `priceCents` deleted the booking is persisted with `priceCents: null` and
 *     the amount is deferred to invoice time - silently.
 *  2. `portal/getServiceCatalog.ts` hides a service from the kinfolk portal with
 *     `d.data()?.active !== false`. Delete `active` and the comparison is true
 *     again, so a service deliberately hidden from clients REAPPEARS in their
 *     catalog the next time an operator edits it. This one does not depend on
 *     which pricing shape a given production document carries, which is why
 *     it is the clearest statement of the defect.
 *
 * HONEST LIMIT ON (1). `getServiceCatalog.ts:96` says the field names on these
 * documents "drifted" - it accepts both the `name`/`priceCents` shape and the
 * `title`/`basePrice` shape - so a production document may already carry only
 * the shape this model declares, in which case the `priceCents` deletion is
 * latent rather than something happening today. The exposure is structural
 * either way: the server reads seven names this client cannot write, and a bare
 * set guarantees the two can never coexist on one document.
 *
 * WHAT A FIELD-LEVEL DIFF CANNOT DO. `businessRules` is diffed and written as
 * one whole nested object, so two operators editing different rules on the same
 * service at once still resolve last-write-wins on that field. Element-level
 * merging would be a different feature with a different shape.
 */

/**
 * Fields on `base_services/{id}` this client may write, keyed by Firestore
 * field name.
 *
 * Written out by hand rather than reflected, so it survives R8 and reads as the
 * contract it is. Absent ON PURPOSE, see [BASE_SERVICE_SERVER_OWNED] and
 * [BASE_SERVICE_PORTAL_OWNED] - named there rather than merely omitted so the
 * drift guard can tell "deliberately not ours" from "forgotten".
 */
internal val BASE_SERVICE_DIFF_FIELDS: Map<String, (BaseService) -> Any?> =
    linkedMapOf(
        "title" to { it.title },
        "description" to { it.description },
        "durationMinutes" to { it.durationMinutes },
        "basePrice" to { it.basePrice },
        "isActive" to { it.isActive },
        "category" to { it.category },
        "tags" to { it.tags },
        "requiresSpecialEquipment" to { it.requiresSpecialEquipment },
        "equipmentNotes" to { it.equipmentNotes },
        "businessRules" to { it.businessRules },
    )

/**
 * `base_services/{id}` fields this client must never write, and who owns each.
 *
 * - `id`         the document id (`@DocumentId`, never serialised anyway)
 * - `createdAt`  stamped once at create; round-tripping it is how it gets lost
 * - `updatedAt`  stamped at write time by the repository, never round-tripped
 */
internal val BASE_SERVICE_SERVER_OWNED = setOf("id", "createdAt", "updatedAt")

/**
 * Fields the MyTribe portal functions READ off `base_services/{id}` that
 * [BaseService] does not declare, and must not start declaring.
 *
 * - `name`, `priceCents`            `portal/requestBooking.ts#resolveService`
 * - `active`                        `portal/getServiceCatalog.ts` visibility filter
 * - `priceMinCents`, `priceMaxCents`,
 *   `isOvernight`, `iconKey`        `portal/getServiceCatalog.ts#mapBaseServiceDoc`
 *
 * DECLARING THEM WOULD BE THE WRONG FIX, and this list exists to say so. Adding
 * `priceCents` to [BaseService] would make this app an owner of the
 * server-trusted price, so a save that races an edit elsewhere would write the
 * stale amount it read back over the real one - trading a loud absence for a
 * quiet wrong number, on money. Only a write that cannot NAME these fields can
 * be trusted not to change them, and only merge preserves a field the client
 * cannot name. `BaseServiceCatalogFieldsTest` pins both halves.
 */
internal val BASE_SERVICE_PORTAL_OWNED = setOf(
    "name",
    "priceCents",
    "priceMinCents",
    "priceMaxCents",
    "isOvernight",
    "iconKey",
    "active",
)

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as blank. Skipping it
 * would make "remove the equipment note" the one edit no screen can perform.
 */
internal fun baseServiceFieldChanges(
    loaded: BaseService,
    edited: BaseService,
): Map<String, Any?> {
    val changes = LinkedHashMap<String, Any?>()
    for ((field, read) in BASE_SERVICE_DIFF_FIELDS) {
        if (read(edited) != read(loaded)) changes[field] = read(edited)
    }
    return changes
}
