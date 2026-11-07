package com.tribetails.auntieos.domain

/**
 * Does a service address look too thin to drive to? (#1602)
 *
 * On the 2026-11-05 walk Dre East's address was stored as "18605", and the
 * visit and the Auntie Time map chip showed just that with nothing saying it
 * was incomplete. Only a HINT: it never blocks a save or hides the address.
 *
 * Incomplete means no letters at all (a bare number or ZIP), or fewer than
 * three words and no comma (no street name and town). Same rule and words as
 * the admin web's `lib/addressCompleteness.ts`.
 */
const val INCOMPLETE_ADDRESS_HINT = "This address looks incomplete. Fix it on the household profile."

fun addressLooksIncomplete(raw: String): Boolean {
    val address = raw.trim()
    if (address.isEmpty()) return false
    if (address.none { it.isLetter() }) return true
    val words = address.split(Regex("\\s+")).filter { it.isNotEmpty() }
    return words.size < 3 && !address.contains(',')
}
