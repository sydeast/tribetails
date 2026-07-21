package com.tribetails.auntieos.ui.home

import kotlin.math.roundToInt

/**
 * A8 W16/W17 weather widgets: pure dog-safety maths over the raw NWS conditions the
 * getLocalWeather callable returns. Compose-free mirror of the web WeatherRisk so both
 * platforms compute IDENTICAL levels (the server never decides the verdict). See
 * [WeatherRiskTest]. Thresholds use widely-published public guidance, easy to tune later.
 */
enum class WeatherRisk { Ok, Caution, High, Danger }

/**
 * W16 paw-burn risk from air temp. Asphalt in direct sun runs ~40-60F hotter than air, so
 * ~77F air ≈ 125F asphalt (burns possible), ~87F ≈ 143F (burns in seconds). Conservative:
 * >=85F High · >=77F Caution · else Ok.
 */
fun pawBurnRisk(tempF: Int?): WeatherRisk = when {
    tempF == null -> WeatherRisk.Ok
    tempF >= 85 -> WeatherRisk.High
    tempF >= 77 -> WeatherRisk.Caution
    else -> WeatherRisk.Ok
}

/**
 * NWS Rothfusz heat-index regression (F, RH%). Below ~80F or ~40% RH the apparent temp ≈
 * the air temp, so we return the air temp there. Returns "feels-like" temperature in F.
 */
fun heatIndexF(tempF: Int?, humidityPct: Int?): Int? {
    val t = tempF ?: return null
    val r = humidityPct ?: return t
    if (t < 80 || r < 40) return t
    val td = t.toDouble()
    val rd = r.toDouble()
    val hi = -42.379 + 2.04901523 * td + 10.14333127 * rd -
        0.22475541 * td * rd - 0.00683783 * td * td - 0.05481717 * rd * rd +
        0.00122874 * td * td * rd + 0.00085282 * td * rd * rd - 0.00000199 * td * td * rd * rd
    return hi.roundToInt()
}

/**
 * W17 canine heat-stroke risk from the heat index, mapped onto NWS human heat-index
 * categories read conservatively for dogs:
 * >=104 Danger · >=90 High · >=80 Caution · else Ok.
 */
fun canineHeatRisk(heatIndexF: Int?): WeatherRisk = when {
    heatIndexF == null -> WeatherRisk.Ok
    heatIndexF >= 104 -> WeatherRisk.Danger
    heatIndexF >= 90 -> WeatherRisk.High
    heatIndexF >= 80 -> WeatherRisk.Caution
    else -> WeatherRisk.Ok
}
