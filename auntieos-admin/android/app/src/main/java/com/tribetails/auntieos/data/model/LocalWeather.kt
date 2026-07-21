package com.tribetails.auntieos.data.model

/** Raw local conditions from the getLocalWeather callable (NWS). Risk maths in ui.home.WeatherRisk. */
data class LocalWeather(
    val city: String = "",
    val state: String = "",
    val tempF: Int? = null,
    val humidityPct: Int? = null,
    val shortForecast: String = "",
    val isDaytime: Boolean = true,
    val alerts: List<WeatherAlert> = emptyList(),
    val observedAtMs: Long = 0L,
    val cached: Boolean = false,
)

data class WeatherAlert(val event: String, val severity: String, val headline: String)
