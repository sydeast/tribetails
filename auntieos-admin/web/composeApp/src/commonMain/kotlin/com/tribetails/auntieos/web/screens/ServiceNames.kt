package com.tribetails.auntieos.web.screens

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.ui.components.ServicePill

/**
 * #1592: the KinCare catalog every screen names a stored `serviceType` against.
 * The app root provides it from its one live `business_settings` stream, so a
 * rename in Settings reaches every open screen; the Schedule re-provides the
 * same value from its own read. Empty until the read lands, and
 * [bookingServiceName] answers an empty catalog with the stored text, so a row
 * never shows a made-up name.
 */
val LocalServiceCatalog = staticCompositionLocalOf { ServiceCatalog() }

/** The catalog fields of the operator's settings. */
fun BusinessSettings.serviceCatalog(): ServiceCatalog = ServiceCatalog(serviceRates, serviceDurations)

/**
 * A service pill for a STORED `serviceType`: it says the KinCare's name and
 * wears that name's tone, the key the Schedule legend and blocks use
 * ([bookingServiceTone]). The web `ServicePill` with a `label`.
 */
@Composable
fun BookingServicePill(serviceType: String, catalog: ServiceCatalog = LocalServiceCatalog.current) {
    ServicePill(catalog.nameOf(serviceType), bookingServiceTone(serviceType, catalog))
}
