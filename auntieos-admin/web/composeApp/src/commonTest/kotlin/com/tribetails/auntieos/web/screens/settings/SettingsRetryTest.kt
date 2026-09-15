package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs

/** #867 review: the Settings load error banner's Retry reads business settings again. */
class SettingsRetryTest {

    @Test
    fun retryAsksForTheSettingsStreamAgainAndSettlesWhenItAnswers() {
        val fake = FakeAuntieDataSource()
        val vm = SettingsViewModel(fake)
        assertEquals(1, fake.businessSettingsStreamCalls)

        fake.emitBusinessSettings(FirestoreResult.Error("Timed out"))
        assertIs<FirestoreResult.Error>(vm.uiState.value.settingsResult)

        vm.retrySettings()
        assertEquals(2, fake.businessSettingsStreamCalls)
        // The fake answers at once with its current value, so the retry has settled.
        assertFalse(vm.uiState.value.reloadingSettings)

        fake.emitBusinessSettings(FirestoreResult.Data(BusinessSettings()))
        assertIs<FirestoreResult.Data<BusinessSettings>>(vm.uiState.value.settingsResult)
        assertEquals(2, fake.businessSettingsStreamCalls)
    }
}
