package com.tribetails.auntieos.web.screens.sessions

/**
 * Does a service address look too thin to drive to? (#1602)
 *
 * The 2026-11-05 walk's visit and Auntie Time chip read "18605" with nothing
 * saying it was incomplete. Only a HINT: it never blocks a save or hides the
 * address. Same rule and words as the admin web (`lib/addressCompleteness.ts`)
 * and Android (`domain/AddressCompleteness.kt`).
 */
const val INCOMPLETE_ADDRESS_HINT = "This address looks incomplete. Fix it on the household profile."

fun addressLooksIncomplete(raw: String): Boolean {
    val address = raw.trim()
    if (address.isEmpty()) return false
    if (address.none { it.isLetter() }) return true
    val words = address.split(Regex("\\s+")).filter { it.isNotEmpty() }
    return words.size < 3 && !address.contains(',')
}
