package com.tribetails.auntieos.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** W16/W17 dog-safety maths. Mirror of the web WeatherRiskTest. */
class WeatherRiskTest {

    @Test fun pawBurn_bands() {
        assertEquals(WeatherRisk.Ok, pawBurnRisk(70))
        assertEquals(WeatherRisk.Caution, pawBurnRisk(77))
        assertEquals(WeatherRisk.Caution, pawBurnRisk(84))
        assertEquals(WeatherRisk.High, pawBurnRisk(85))
        assertEquals(WeatherRisk.High, pawBurnRisk(99))
    }

    @Test fun pawBurn_null_isOk() {
        assertEquals(WeatherRisk.Ok, pawBurnRisk(null))
    }

    @Test fun heatIndex_belowThreshold_isAirTemp() {
        assertEquals(72, heatIndexF(72, 90))
        assertEquals(95, heatIndexF(95, 20))
        assertEquals(88, heatIndexF(88, null))
    }

    @Test fun heatIndex_hotAndHumid_feelsHotter() {
        val hi = heatIndexF(90, 70)!!
        assertTrue(hi in 103..107)
    }

    @Test fun heatIndex_nullTemp_isNull() {
        assertEquals(null, heatIndexF(null, 50))
    }

    @Test fun canineHeat_bands() {
        assertEquals(WeatherRisk.Ok, canineHeatRisk(79))
        assertEquals(WeatherRisk.Caution, canineHeatRisk(80))
        assertEquals(WeatherRisk.High, canineHeatRisk(90))
        assertEquals(WeatherRisk.Danger, canineHeatRisk(104))
    }
}
