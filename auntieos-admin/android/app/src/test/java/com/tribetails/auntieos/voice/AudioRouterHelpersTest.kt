package com.tribetails.auntieos.voice

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for selectCommunicationDevice. No Android runtime, no Robolectric -
 * the helper takes a thin AudioDeviceInfoLike adapter so it stays testable on the JVM.
 */
class AudioRouterHelpersTest {

    private fun earpiece() = AudioDeviceInfoLike(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, "earpiece")
    private fun speaker()  = AudioDeviceInfoLike(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,  "speaker")
    private fun btSco()    = AudioDeviceInfoLike(AudioDeviceInfo.TYPE_BLUETOOTH_SCO,    "Sony WH-1000XM5")

    @Test
    fun `empty device list returns Missing`() {
        val result = selectCommunicationDevice(emptyList(), AudioRoute.Earpiece)
        assertTrue(result is SelectionResult.Missing)
        assertEquals("No communication devices available", (result as SelectionResult.Missing).reason)
    }

    @Test
    fun `only earpiece available, requested earpiece, returns earpiece`() {
        val result = selectCommunicationDevice(listOf(earpiece()), AudioRoute.Earpiece)
        assertTrue(result is SelectionResult.Match)
        assertEquals(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, (result as SelectionResult.Match).device.type)
    }

    @Test
    fun `earpiece plus speaker, requested Speaker, returns speaker`() {
        val result = selectCommunicationDevice(listOf(earpiece(), speaker()), AudioRoute.Speaker)
        assertTrue(result is SelectionResult.Match)
        assertEquals(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, (result as SelectionResult.Match).device.type)
    }

    @Test
    fun `earpiece plus speaker, requested Earpiece, returns earpiece`() {
        val result = selectCommunicationDevice(listOf(earpiece(), speaker()), AudioRoute.Earpiece)
        assertTrue(result is SelectionResult.Match)
        assertEquals(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, (result as SelectionResult.Match).device.type)
    }

    @Test
    fun `earpiece plus speaker plus BT, requested Bluetooth, returns BT`() {
        val result = selectCommunicationDevice(listOf(earpiece(), speaker(), btSco()), AudioRoute.Bluetooth)
        assertTrue(result is SelectionResult.Match)
        assertEquals(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, (result as SelectionResult.Match).device.type)
    }

    @Test
    fun `requested Bluetooth but BT not in list, returns Missing with reason`() {
        val result = selectCommunicationDevice(listOf(earpiece(), speaker()), AudioRoute.Bluetooth)
        assertTrue(result is SelectionResult.Missing)
        assertEquals("No Bluetooth device available", (result as SelectionResult.Missing).reason)
    }
}
