package com.kinfolk.portal.util

import kotlinx.datetime.LocalDate
import kotlin.js.Date

actual fun todayLocal(): LocalDate {
    val d = Date()
    return LocalDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
}
