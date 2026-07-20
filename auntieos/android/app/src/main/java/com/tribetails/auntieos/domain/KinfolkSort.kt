package com.tribetails.auntieos.domain

/**
 * 03-directory item 3: surname-primary sort key for Kinfolk (parity with the web
 * `kinfolkSurnameSortKey`). The directory orders by LAST name with a first-name
 * tiebreak, falling back to the display name when the last name is blank.
 */
fun kinfolkSurnameSortKey(firstName: String, lastName: String, displayName: String): String =
    (if (lastName.isNotBlank()) "$lastName $firstName" else displayName).trim().lowercase()
