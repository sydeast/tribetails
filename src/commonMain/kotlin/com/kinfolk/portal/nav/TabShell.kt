package com.kinfolk.portal.nav

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavController
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.currentBackStackEntryAsState
import com.kinfolk.portal.portal.PortalBanner
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.BannerDismissStore
import kotlin.reflect.KClass

/** Max content width of the wide top-nav row, matching the design's 1140px shell. */
private val NavMaxWidth = 1140.dp

/** Bottom inset so scrollable bodies clear the floating narrow tab bar. */
private val NarrowTabBarClearance = 84.dp

/**
 * Responsive chrome wrapper for the signed-in shell, replacing the old drawer
 * + Material NavigationBar. Wide (>= 880dp): sticky glass top nav — wordmark,
 * link pills, bell, avatar menu. Narrow: slim top bar (wordmark + bell +
 * avatar) plus a floating bottom tab bar. Selection is read from the live
 * back-stack entry; taps drive the NavController. Operator status surfaces the
 * same way as before: [onBackToDirectory] is non-null only for operators who
 * entered via the directory picker.
 */
@Composable
fun TabShell(
    familyName: String,
    logoUrl: String? = null,
    navController: NavController,
    onSignOut: () -> Unit,
    onBackToDirectory: (() -> Unit)? = null,
    banner: PortalBanner = PortalBanner(),
    bannerDismissedByUser: Boolean = false,
    onDismissBannerPerUser: ((bannerId: String) -> Unit)? = null,
    content: @Composable (Modifier) -> Unit,
) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination

    // Local dismissal state for the top banner. perDevice persists via
    // BannerDismissStore (localStorage on web); perUser additionally fires the
    // synced callback. Keyed by banner id so editing the id re-shows it.
    var locallyDismissed by remember(banner.id) {
        mutableStateOf(banner.dismissMode == "perDevice" && BannerDismissStore.isDismissed(banner.id))
    }
    val bannerHidden = !banner.enabled ||
        locallyDismissed ||
        (banner.dismissMode == "perUser" && bannerDismissedByUser)

    val bannerBar: @Composable () -> Unit = {
        if (!bannerHidden) {
            TopBannerBar(
                banner = banner,
                onDismiss = if (banner.dismissMode == "none") null else {
                    {
                        locallyDismissed = true
                        when (banner.dismissMode) {
                            "perDevice" -> BannerDismissStore.dismiss(banner.id)
                            "perUser" -> onDismissBannerPerUser?.invoke(banner.id)
                        }
                    }
                },
            )
        }
    }

    fun navigateTab(route: Any) {
        // saveState/restoreState only apply when we're leaving a chrome-level
        // destination. Saving the stack while on a detail/wizard leaf captures
        // a corrupt state that — with the browser-history binding on web —
        // silently drops every later navigate/pop until reload; from a leaf we
        // pop clean and land on a fresh tab instead.
        val fromChrome = isShellChromeDestination { currentDestination.isOn(it) }
        navController.navigate(route) {
            // findStartDestination resolves the HomeRoute LEAF inside the
            // nested ShellGraph. graph.startDestinationId is the ShellGraph
            // node itself — popping to it re-saves the whole graph and wedges
            // the back stack.
            popUpTo(navController.graph.findStartDestination().id) {
                saveState = fromChrome
            }
            launchSingleTop = true
            restoreState = fromChrome
        }
    }

    // Menu/drawer destinations (Account, Notifications, Tribe) use the SAME
    // pop-to-start + saveState/restoreState machinery as tabs. Without it they
    // pile on TOP of the current tab, and tapping a tab restores a saved stack
    // that still has the menu screen on top — the "Account Settings locks the
    // page" bug. Mirroring navigateTab makes them switch cleanly.
    fun navigateMenu(route: Any) = navigateTab(route)

    // Re-tapping the active tab reloads it: pop the current entry and push a
    // fresh one so the screen recomposes and its load effects re-run. Tapping a
    // different tab is the normal save/restore switch.
    fun onTabLink(dest: ShellDestination) {
        if (currentDestination.isOn(dest.routeClass)) {
            navController.navigate(dest.route) {
                popUpTo(dest.route) { inclusive = true }
                launchSingleTop = true
            }
        } else {
            navigateTab(dest.route)
        }
    }

    fun onMenuItem(item: AccountMenuItem) {
        when (item) {
            is AccountMenuItem.Open -> navigateMenu(item.destination.route)
            AccountMenuItem.BackToDirectory -> onBackToDirectory?.invoke()
            AccountMenuItem.SignOut -> onSignOut()
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        if (wide) {
            val active = resolveActiveDestination(ShellNav.wideLinks) { currentDestination.isOn(it) }
            Column(modifier = Modifier.fillMaxSize()) {
                bannerBar()
                WideTopNav(
                    familyName = familyName,
                    logoUrl = logoUrl,
                    active = active,
                    isOperator = onBackToDirectory != null,
                    onLink = { onTabLink(it) },
                    onBell = { navigateMenu(NotificationsRoute) },
                    onMenuItem = ::onMenuItem,
                )
                // Cap + center the body so wide web reads as a real desktop
                // column, not an enlarged mobile layout stretched edge-to-edge.
                Box(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    content(Modifier.fillMaxWidth().widthIn(max = NavMaxWidth))
                }
                AppFooter()
            }
        } else {
            val active = resolveActiveDestination(ShellNav.narrowTabs) { currentDestination.isOn(it) }
            Box(modifier = Modifier.fillMaxSize()) {
                Column(modifier = Modifier.fillMaxSize()) {
                    bannerBar()
                    NarrowTopBar(
                        familyName = familyName,
                        logoUrl = logoUrl,
                        isOperator = onBackToDirectory != null,
                        onBell = { navigateMenu(NotificationsRoute) },
                        onMenuItem = ::onMenuItem,
                    )
                    content(
                        Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .padding(bottom = NarrowTabBarClearance),
                    )
                }
                NarrowTabBar(
                    active = active,
                    onSelect = { onTabLink(it) },
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(start = 12.dp, end = 12.dp, bottom = 12.dp),
                )
            }
        }
    }
}

// ---- Wide (>= 880dp) chrome ----

@Composable
private fun WideTopNav(
    familyName: String,
    logoUrl: String?,
    active: ShellDestination?,
    isOperator: Boolean,
    onLink: (ShellDestination) -> Unit,
    onBell: () -> Unit,
    onMenuItem: (AccountMenuItem) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().background(KinfolkBrand.Cream.copy(alpha = 0.72f))) {
        Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(
                modifier = Modifier
                    .widthIn(max = NavMaxWidth)
                    .fillMaxWidth()
                    .padding(horizontal = KinfolkSpacing.l, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandLogo(logoUrl)
                Wordmark()
                Spacer(Modifier.width(KinfolkSpacing.l))
                Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                    ShellNav.wideLinks.forEach { link ->
                        NavLinkPill(
                            label = link.label,
                            selected = link == active,
                            onClick = { onLink(link) },
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                BellButton(onClick = onBell)
                Spacer(Modifier.width(10.dp))
                AvatarMenuButton(
                    familyName = familyName,
                    isOperator = isOperator,
                    onMenuItem = onMenuItem,
                )
            }
        }
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(KinfolkBrand.NavyHairline))
    }
}

@Composable
private fun NavLinkPill(label: String, selected: Boolean, onClick: () -> Unit) {
    val type = LocalKinfolkTypography.current
    val source = remember { MutableInteractionSource() }
    val hovered by source.collectIsHoveredAsState()
    val background = when {
        selected -> KinfolkBrand.Navy
        hovered -> KinfolkBrand.KinfolkOrange.copy(alpha = 0.12f)
        else -> Color.Transparent
    }
    val textColor = when {
        selected -> Color.White
        hovered -> KinfolkBrand.Navy
        else -> KinfolkBrand.NavySoft
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(11.dp))
            .background(background)
            .hoverable(source)
            .clickable(interactionSource = source, indication = null) { onClick() }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = type.sansLabel.copy(
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
                color = textColor,
            ),
        )
    }
}

// ---- Narrow (< 880dp) chrome ----

@Composable
private fun NarrowTopBar(
    familyName: String,
    logoUrl: String?,
    isOperator: Boolean,
    onBell: () -> Unit,
    onMenuItem: (AccountMenuItem) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth().background(KinfolkBrand.Cream.copy(alpha = 0.72f))) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = KinfolkSpacing.m, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BrandLogo(logoUrl)
            Wordmark()
            Spacer(Modifier.weight(1f))
            BellButton(onClick = onBell)
            Spacer(Modifier.width(10.dp))
            AvatarMenuButton(
                familyName = familyName,
                isOperator = isOperator,
                onMenuItem = onMenuItem,
            )
        }
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(KinfolkBrand.NavyHairline))
    }
}

@Composable
private fun NarrowTabBar(
    active: ShellDestination?,
    onSelect: (ShellDestination) -> Unit,
    modifier: Modifier = Modifier,
) {
    val type = LocalKinfolkTypography.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(Color.White.copy(alpha = 0.85f))
            .border(1.dp, KinfolkBrand.GlassBorder, RoundedCornerShape(22.dp))
            .padding(horizontal = 6.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ShellNav.narrowTabs.forEach { tab ->
            val selected = tab == active
            val tint = if (selected) KinfolkBrand.KinfolkOrange else KinfolkBrand.NavyMuted
            Column(
                modifier = Modifier
                    .clip(RoundedCornerShape(12.dp))
                    .clickable { onSelect(tab) }
                    .padding(horizontal = 10.dp, vertical = 2.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Icon(
                    imageVector = tab.icon,
                    contentDescription = tab.tabLabel,
                    tint = tint,
                    modifier = Modifier.size(22.dp),
                )
                Text(tab.tabLabel, style = type.sansMeta.copy(fontSize = 10.sp, color = tint))
            }
        }
    }
}

// ---- Shared pieces ----

/** Operating-business logo, left of the wordmark. Data-driven from
 *  business_settings.logoUrl (getMyHome → shell); renders nothing until set,
 *  so an admin can upload one from AuntieOS later without a code change. */
@Composable
private fun BrandLogo(logoUrl: String?) {
    if (logoUrl.isNullOrBlank()) return
    com.kinfolk.portal.components.KinfolkRemoteImage(
        url = logoUrl,
        contentDescription = "Logo",
        modifier = Modifier.size(36.dp).clip(CircleShape),
    )
    Spacer(Modifier.width(10.dp))
}

@Composable
private fun Wordmark() {
    val type = LocalKinfolkTypography.current
    Text(
        text = buildAnnotatedString {
            append("My")
            withStyle(SpanStyle(brush = KinfolkGradients.tribe)) { append("Tribe") }
        },
        style = type.heritageDisplay.copy(
            fontWeight = FontWeight.Normal,
            fontSize = 23.sp,
            letterSpacing = (-0.2).sp,
        ),
        maxLines = 1,
    )
}

@Composable
private fun BellButton(onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(42.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(KinfolkBrand.GlassSurface)
            .border(1.dp, KinfolkBrand.GlassBorder, RoundedCornerShape(13.dp))
            .clickable { onClick() },
    ) {
        Icon(
            imageVector = Icons.Filled.Notifications,
            contentDescription = "Notifications",
            tint = KinfolkBrand.Navy,
            modifier = Modifier.size(20.dp).align(Alignment.Center),
        )
        // Coral ping dot with a cream ring, top-right like the design's .ping.
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 6.dp, end = 7.dp)
                .size(13.dp)
                .background(KinfolkBrand.Cream, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(modifier = Modifier.size(8.dp).background(KinfolkBrand.SnuggleCoral, CircleShape))
        }
    }
}

@Composable
private fun AvatarMenuButton(
    familyName: String,
    isOperator: Boolean,
    onMenuItem: (AccountMenuItem) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(CircleShape)
                .background(KinfolkGradients.tribe)
                .clickable { menuOpen = true },
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = avatarInitial(familyName),
                style = type.heritageTitle.copy(fontSize = 18.sp, color = Color.White),
            )
        }
        DropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
        ) {
            ShellNav.accountMenu(isOperator).forEach { item ->
                DropdownMenuItem(
                    text = { Text(item.label, style = type.sansBody) },
                    onClick = {
                        menuOpen = false
                        onMenuItem(item)
                    },
                )
            }
        }
    }
}

/**
 * App-wide footer (the mockup's footnote), mounted under the wide web body.
 * Mobile keeps the floating tab bar and no footer, matching app convention.
 */
@Composable
private fun AppFooter() {
    val type = LocalKinfolkTypography.current
    Column(modifier = Modifier.fillMaxWidth().background(KinfolkBrand.Cream.copy(alpha = 0.72f))) {
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(KinfolkBrand.NavyHairline))
        Box(
            modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "Cared for by Tribe Tails Pet Care",
                style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
            )
        }
    }
}

/**
 * Operator-controlled alert ribbon, mounted at the very top of the shell (above
 * the nav) on both wide and narrow layouts. Tone tints the background + sets a
 * readable accent: info/success → KinTeal, warning → KinfolkOrange, alert →
 * SnuggleCoral. An [onDismiss] of null (dismissMode "none") renders no X.
 */
@Composable
private fun TopBannerBar(banner: PortalBanner, onDismiss: (() -> Unit)?) {
    val type = LocalKinfolkTypography.current
    val accent = when (banner.tone) {
        "warning" -> KinfolkBrand.KinfolkOrange
        "alert" -> KinfolkBrand.SnuggleCoral
        else -> KinfolkBrand.KinTeal // info + success
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(accent.copy(alpha = 0.14f))
            .padding(horizontal = KinfolkSpacing.l, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(accent))
        Text(
            text = banner.message,
            style = type.sansLabel.copy(
                fontWeight = FontWeight.SemiBold,
                color = KinfolkBrand.Navy,
            ),
            modifier = Modifier.weight(1f),
        )
        if (onDismiss != null) {
            Box(
                modifier = Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .clickable { onDismiss() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = "Dismiss",
                    tint = KinfolkBrand.NavyMuted,
                    modifier = Modifier.size(18.dp),
                )
            }
        }
    }
}

/** True when [this] destination (or an ancestor) is the given route type. */
private fun NavDestination?.isOn(routeClass: KClass<*>): Boolean =
    this?.hierarchy?.any { it.hasRoute(routeClass) } == true
