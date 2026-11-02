package com.kinfolk.portal.config

/**
 * Public-facing business contact. Now sourced from `business_settings/singleton`
 * via `PortalApi.getBusinessContact()` instead of a hard-coded constant — the
 * admin updates contact info on AuntieOS and it propagates to MyTribe without
 * a kinfolk-app release.
 *
 * UI (e.g. TribeScreen's `ContactAuntieCard`) hides Call/Text/Email buttons
 * when their respective field is blank — fail-loud per project policy.
 */
data class BusinessContact(
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val address: String = "",
    /**
     * #1410: the operator's privacy policy link, blank until one is set. The
     * server hands out only a plain https URL, so a screen may open it as is;
     * while blank the link is omitted, like the buttons above.
     */
    val privacyPolicyUrl: String = "",
)
