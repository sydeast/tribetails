package com.kinfolk.portal.screens.kin
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1852: the Kin field reads "Gender" on every client; the stored `sex` values do not change. */
class KinGenderFieldTest {
    @Test
    fun theLabelIsGender() {
        assertEquals("GENDER", KIN_GENDER_LABEL)
    }
    @Test
    fun theThreeChoicesMatchTheAdminList() {
        assertEquals(listOf("Male", "Female", "Unknown"), kinGenderOptions(""))
        assertEquals(listOf("Male", "Female", "Unknown"), kinGenderOptions("Female"))
    }
    @Test
    fun aStoredValueOutsideTheListStaysItsOwnChoice() {
        assertEquals(listOf("Male", "Female", "Unknown", "F"), kinGenderOptions("F"))
    }
}
