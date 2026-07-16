package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.screens.home.WeatherRisk
import com.tribetails.auntieos.web.screens.home.canineHeatRisk
import com.tribetails.auntieos.web.screens.home.heatIndexF
import com.tribetails.auntieos.web.screens.home.pawBurnRisk
import kotlin.test.Test
import kotlin.test.assertEquals

/** W16/W17 dog-safety maths. Mirror of the android WeatherRiskTest. */
class WeatherRiskTest {

    @Test fun pawBurn_bands() {
        assertEquals(WeatherRisk.Ok, pawBurnRisk(70))
        assertEquals(WeatherRisk.Caution, pawBurnRisk(77))
        assertEquals(WeatherRisk.Caution, pawBurnRisk(84))
        assertEquals(WeatherRisk.High, pawBurnRisk(85))
        assertEquals(WeatherRisk.High, pawBurnRisk(99))
    }

    @Test fun pawBurn_null_is_ok() {
        assertEquals(WeatherRisk.Ok, pawBurnRisk(null))
    }

    @Test fun heatIndex_below_threshold_is_air_temp() {
        // Cool or dry → apparent temp ≈ air temp.
        assertEquals(72, heatIndexF(72, 90))
        assertEquals(95, heatIndexF(95, 20))
        assertEquals(88, heatIndexF(88, null)) // unknown humidity → air temp
    }

    @Test fun heatIndex_hot_and_humid_feels_hotter() {
        // NWS table: 90F + 70% RH ≈ 105F apparent (±1).
        val hi = heatIndexF(90, 70)!!
        assertEquals(true, hi in 103..107)
    }

    @Test fun heatIndex_null_temp_is_null() {
        assertEquals(null, heatIndexF(null, 50))
    }

    @Test fun canineHeat_bands() {
        assertEquals(WeatherRisk.Ok, canineHeatRisk(79))
        assertEquals(WeatherRisk.Caution, canineHeatRisk(80))
        assertEquals(WeatherRisk.High, canineHeatRisk(90))
        assertEquals(WeatherRisk.Danger, canineHeatRisk(104))
    }
}
