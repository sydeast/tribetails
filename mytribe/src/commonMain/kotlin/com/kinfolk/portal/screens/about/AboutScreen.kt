package com.kinfolk.portal.screens.about

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.PhoneActionPills
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.components.businessLabel
import com.kinfolk.portal.config.BusinessPublicCard
import com.kinfolk.portal.config.PUBLIC_HOURS_DAYS
import com.kinfolk.portal.config.appVersionName
import com.kinfolk.portal.config.hoursLabel
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.formatPhone
import com.kinfolk.portal.util.openExternalUrl

/**
 * "About {business}" (#1411, the 2026-11-01 ruling on #1399): where a household
 * finds the business name, its weekly hours, the public number with Call and
 * Text, the privacy policy and the app version. Reached from the avatar menu;
 * the web portal's `screens/About.tsx` is the twin.
 *
 * Everything on it is the [card] the app read at launch (`business_public/card`,
 * the sign-in read, #1321): cached copy first, live copy when it arrives, no
 * callable and no tribe. That is what lets it draw from the cache when the
 * device is offline, and why it takes no PortalApi and no kinfolkId.
 *
 * No value here is ever invented. A blank name titles the page "About your
 * Auntie" ([businessLabel]); a blank number, URL or version leaves that part
 * out; a closed day reads "Closed".
 */
@Composable
fun AboutScreen(
    card: BusinessPublicCard,
    appVersion: String = appVersionName(),
    openUrl: (String) -> Unit = { openExternalUrl(it) },
) {
    val type = LocalKinfolkTypography.current
    val privacyUrl = card.privacyPolicyUrl.trim()
    val version = appVersion.trim()
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "About ${businessLabel(card.name)}")

        GlassCard(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text("Hours", style = type.heritageSection)
                PUBLIC_HOURS_DAYS.forEach { day ->
                    Row(
                        modifier = Modifier.fillMaxWidth().testTag("about-hours-$day"),
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(day, style = type.sansBody.copy(color = KinfolkBrand.NavySoft))
                        Text(hoursLabel(card.hours[day].orEmpty()), style = type.sansBody)
                    }
                }
            }
        }

        if (card.phone.isNotBlank()) {
            GlassCard(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("Phone", style = type.heritageSection)
                    SelectionContainer {
                        Text(formatPhone(card.phone), style = type.sansBody, modifier = Modifier.testTag("about-phone"))
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                    ) {
                        PhoneActionPills(phone = card.phone, openUrl = openUrl)
                    }
                }
            }
        }

        if (privacyUrl.isNotEmpty() || version.isNotEmpty()) {
            GlassCard(modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l)) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("MyTribe", style = type.heritageSection)
                    if (privacyUrl.isNotEmpty()) {
                        Text(
                            "Privacy policy",
                            style = type.sansBody.copy(color = KinfolkBrand.KinTeal),
                            modifier = Modifier
                                .clickable { openUrl(privacyUrl) }
                                .testTag("about-privacy"),
                        )
                    }
                    if (version.isNotEmpty()) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Version", style = type.sansBody.copy(color = KinfolkBrand.NavySoft))
                            Text(version, style = type.sansBody, modifier = Modifier.testTag("about-version"))
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(KinfolkSpacing.xl))
    }
}
