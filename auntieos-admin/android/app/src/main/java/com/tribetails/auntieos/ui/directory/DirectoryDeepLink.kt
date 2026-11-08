package com.tribetails.auntieos.ui.directory
/**
 * A one-shot request to open the Directory on its Kin tab, narrowed to pets in
 * care (#1601). Home's "Kin in care" card sets it and navigates; the Directory
 * reads it once as it opens.
 *
 * A plain singleton rather than a navigation argument, the same shape as
 * `SessionEndedNotice`: the Directory is a bottom-bar tab whose route identity
 * the bar matches on, and an argument on that route would split it into two
 * destinations. [consume] clears as it reads, so a later visit by the bar opens
 * the Directory as usual.
 */
object DirectoryDeepLink {
    @Volatile
    private var kinInCare = false
    fun requestKinInCare() {
        kinInCare = true
    }
    fun consumeKinInCare(): Boolean {
        val requested = kinInCare
        kinInCare = false
        return requested
    }
    /** Test seam: forget any pending request. */
    fun clear() {
        kinInCare = false
    }
}
