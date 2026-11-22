package com.tribetails.auntieos.ui.components

/**
 * The admin rail as the web console and the desktop console draw it: a section
 * and the rail's name for each screen (#1598, #1894). The phone has a bottom bar
 * rather than a rail, so its headings borrow the rail's words, which keeps one
 * screen's breadcrumb the same on every client. Mirrors `NAV` in the web
 * `lib/nav.ts`; a screen not pinned in the rail takes the entry it is reached
 * from (a Kin or a household reads Directory, vet clinics read Settings).
 */
enum class RailScreen(val section: String, val title: String) {
    DIRECTORY("The Den", "Directory"),
    INVITES("The Den", "Invites"),
    KINTALES("The Den", "KinTales"),
    GALLERY("The Den", "Gallery"),
    PACKAGES("Care Ops", "Packages"),
    SCHEDULE("Care Ops", "Schedule"),
    AUNTIE_TIME("Care Ops", "Auntie Time"),
    INVOICES("Care Ops", "Invoices"),
    COMMUNICATE("Care Ops", "Communicate"),
    MARKETING_BLASTS("Care Ops", "Marketing blasts"),
    INBOX("More", "Inbox"),
    NOTIFICATIONS("More", "Notifications"),
    ACTIVITY("More", "Activity Log"),
    SETTINGS("More", "Settings"),
    TRIBAL_INTEL("More", "Tribal Intel"),
    TEMPLATES("More", "Templates"),
    KINTALE_TEMPLATES("More", "KinTale templates"),
    FORM_SCHEMAS("More", "Form Schemas"),
    FEATURE_FLAGS("More", "Feature Flags"),
    ACCOUNT("More", "Account"),
}

/** A screen heading's kicker, "<rail section> · <rail title>". */
fun railKicker(screen: RailScreen): String = "${screen.section} · ${screen.title}"
