package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Kin
/**
 * Whether a pet counts as "in care": anything not marked inactive or archived.
 * A blank status counts, since no writer sets the field on every `kin` doc.
 *
 * ONE RULE FOR TWO SURFACES (#1601). Home's "Kin in care" card counts with it
 * and the Directory's Kin tab "In care" filter lists with it, so the card's
 * number is the length of the list it opens. It used to count every kin
 * record, which put an inactive pet in the total.
 */
fun isKinInCare(status: String): Boolean {
    val s = status.trim().lowercase()
    return s != "inactive" && s != "archived"
}
fun kinInCareCount(kin: List<Kin>): Int = kin.count { isKinInCare(it.status) }
