package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.screens.booking.sortServiceTypesByDuration

/**
 * #1703: the KinCare types a visit may be named by, the keys of
 * `business_settings.serviceRates`, trimmed and shortest first. Pricing is by
 * exact name against that map (`listUninvoicedSessions`), so a name that is not
 * a key leaves the visit unpriceable at invoice time. Web's
 * `serviceOptionsFromRates` and Android's twin read the same keys.
 *
 * There is no fallback list. The two screens that write a visit's
 * `serviceType` here used to offer hardcoded names ("Pet Sitting", "Drop-In")
 * while Settings had no rates, was still loading, or failed to load, and
 * BookingCreateScreen started on one of them even after the rates arrived.
 */
internal fun rateCardServiceTypes(serviceRates: Map<String, String>?): List<String> =
    sortServiceTypesByDuration(
        serviceRates.orEmpty().keys.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
    )

/** Said when Settings has no KinCare types to book a visit against. */
internal const val NO_KINCARE_TYPES_MESSAGE = "No KinCare types yet. Add one in Business Settings before booking a visit."
