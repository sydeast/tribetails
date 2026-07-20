package com.kinfolk.portal.util

import kotlinx.datetime.LocalDate

actual fun todayLocal(): LocalDate {
    val now = java.time.LocalDate.now()
    return LocalDate(now.year, now.monthValue, now.dayOfMonth)
}
