package com.tribetails.auntieos.web.util

/**
 * Household display label from a household (last) name, e.g. "the Halbrooks".
 *
 * Pluralizes the surname the way English family names work: add "es" when the
 * name ends in a sibilant (s, x, z, ch, sh) so "Brooks" -> "the Brookses" and
 * "Marx" -> "the Marxes", otherwise add "s" ("Halbrook" -> "the Halbrooks",
 * "Kennedy" -> "the Kennedys"). Previously every name just got a bare "s"
 * appended, which produced "the Brookss" / "the Bs"-style doubling.
 *
 * Kept in util (not a screen) so it is testable on the JVM and both the
 * directory card subtitle and the kinfolk-profile hero agree.
 */
fun householdLabel(lastName: String): String {
    val name = lastName.trim()
    if (name.isEmpty()) return ""
    val lower = name.lowercase()
    val plural = if (
        lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z") ||
        lower.endsWith("ch") || lower.endsWith("sh")
    ) "${name}es" else "${name}s"
    return "the $plural"
}
