package com.tribetails.auntieos.web.screens.home

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Raw local conditions from the getLocalWeather callable (NWS). Risk maths in [WeatherRisk]. */
data class LocalWeather(
    val city: String,
    val state: String,
    val tempF: Int?,
    val humidityPct: Int?,
    val shortForecast: String,
    val isDaytime: Boolean,
    val alerts: List<WeatherAlert>,
    val observedAtMs: Long,
    val cached: Boolean,
)

data class WeatherAlert(val event: String, val severity: String, val headline: String)

private val weatherJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Pure parse of the getLocalWeather JSON ack. Mirror of the android decoder. */
fun decodeLocalWeather(raw: String): LocalWeather {
    val o: JsonObject = weatherJson.parseToJsonElement(raw).jsonObject
    fun str(k: String) = o[k]?.jsonPrimitive?.contentOrNull ?: ""
    val alerts = o["alerts"]?.jsonArray?.mapNotNull { el ->
        val a = el.jsonObject
        val event = a["event"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        WeatherAlert(
            event = event,
            severity = a["severity"]?.jsonPrimitive?.contentOrNull ?: "",
            headline = a["headline"]?.jsonPrimitive?.contentOrNull ?: "",
        )
    }.orEmpty()
    return LocalWeather(
        city = str("city"),
        state = str("state"),
        tempF = o["tempF"]?.jsonPrimitive?.intOrNull,
        humidityPct = o["humidityPct"]?.jsonPrimitive?.intOrNull,
        shortForecast = str("shortForecast"),
        isDaytime = o["isDaytime"]?.jsonPrimitive?.booleanOrNull ?: true,
        alerts = alerts,
        observedAtMs = o["observedAtMs"]?.jsonPrimitive?.longOrNull ?: 0L,
        cached = o["cached"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}
