package com.kinfolk.portal.components

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * How household prose names the business (#1381).
 *
 * The name is `getMyHome.businessName`, the same business-settings source the
 * shell footer reads (#1369). When the operator has not set one, prose says
 * "your Auntie". No business name is ever invented here.
 *
 * The footer ("Cared for by ...") does NOT use this: an unset name omits it. This
 * is for sentences, which need a subject or an object.
 */
const val BUSINESS_FALLBACK = "your Auntie"

/**
 * The business name for the whole signed-in tree, provided once by
 * `KinfolkPortalAppGuarded` from the home payload. Blank means "not set, or not
 * loaded yet", and both read as [BUSINESS_FALLBACK]. The default is blank so a
 * screen drawn outside that tree (a preview, a test) still says something true.
 */
val LocalBusinessName = staticCompositionLocalOf { "" }

/**
 * Fills the `{business}` / `{Business}` / `{business's}` placeholders the static fallback
 * catalog carries (the server fills them in the live catalog). Text without them is
 * returned unchanged.
 */
fun fillBusinessPlaceholders(text: String, name: String?): String =
    text.replace("{Business's}", businessLabel(name, capital = true, possessive = true))
        .replace("{business's}", businessLabel(name, possessive = true))
        .replace("{Business}", businessLabel(name, capital = true))
        .replace("{business}", businessLabel(name))

/**
 * [name] as it reads in a sentence. [capital] when the label opens a sentence
 * ("Your Auntie could not take that time."), [possessive] for "'s".
 */
fun businessLabel(name: String?, capital: Boolean = false, possessive: Boolean = false): String {
    var label = name?.trim().orEmpty().ifEmpty { BUSINESS_FALLBACK }
    if (possessive) label += "'s"
    if (capital) label = label.replaceFirstChar { it.uppercaseChar() }
    return label
}
