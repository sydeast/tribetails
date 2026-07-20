package com.kinfolk.portal.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.launch

/**
 * Breach-tripwire screen: kinfolk lands here after clicking
 * "Secure my account and notify Tribe Tails" from the unsolicited
 * password-reset email.
 *
 * UI states:
 *   Form        — new + confirm password fields
 *   Submitting  — in-flight; fields + button disabled
 *   Success     — confirmation banner with sign-in prompt
 *   Error       — visible banner with reason; never silent
 *
 * Primitives: Kin* components only — no M3 visual components.
 * Color scheme: alert-orange (#C45A3A = KinfolkBrand.SnuggleCoral) throughout
 * to signal this is a security event, not a routine password change.
 *
 * @param oobCode  Firebase oobCode from the email link.
 * @param email    Kinfolk email pre-filled from query param.
 * @param fetcher  Platform HTTP client for [confirmSecureReset] function.
 *                 Defaults to [makeSecureResetFetcher] for production.
 */
@Composable
fun SecureResetScreen(
    oobCode: String,
    email: String,
    fetcher: SecureResetFetcher = remember { makeSecureResetFetcher() },
) {
    val c = KinfolkTheme.colors
    val type = KinfolkTheme.typography
    val scope = rememberCoroutineScope()

    // Alert-orange — security event color. Per design spec, this is the same
    // orange CTA used in the email template for the "Secure my account" button.
    val alertOrange = KinfolkBrand.SnuggleCoral  // #D5535A — closest in palette to #C45A3A

    var newPassword by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var successIncidentId by remember { mutableStateOf<String?>(null) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // Validation helpers
    fun passwordsMatch(): Boolean = newPassword == confirmPassword
    fun passwordLongEnough(): Boolean = newPassword.length >= 8

    fun submit() {
        if (submitting) return
        errorMessage = null

        when {
            newPassword.isBlank() -> {
                errorMessage = "Please enter a new password."
                return
            }
            !passwordLongEnough() -> {
                errorMessage = "Password must be at least 8 characters."
                return
            }
            confirmPassword.isBlank() -> {
                errorMessage = "Please confirm your new password."
                return
            }
            !passwordsMatch() -> {
                errorMessage = "Passwords do not match. Please re-enter them."
                return
            }
        }

        submitting = true
        scope.launch {
            try {
                val incidentId = fetcher.confirmReset(
                    oobCode = oobCode,
                    newPassword = newPassword,
                    email = email,
                    userAgent = platformUserAgent(),
                )
                successIncidentId = incidentId
            } catch (e: SecureResetException) {
                errorMessage = e.message ?: "Something went wrong. Please try again."
            } catch (e: Throwable) {
                // Fail-loud: never silently swallow unknown errors.
                errorMessage = "Unexpected error: ${e.message ?: "unknown"}. Please try again or contact support."
            } finally {
                submitting = false
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(KinfolkGradients.tribe),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
        ) {
            // ── Alert icon + heading ──────────────────────────────────────────────
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Box(
                    modifier = Modifier
                        .size(96.dp)
                        .clip(CircleShape)
                        .background(alertOrange.copy(alpha = 0.15f))
                        .border(2.dp, alertOrange.copy(alpha = 0.60f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "🔒",
                        style = type.heritageTitle.copy(color = alertOrange),
                    )
                }
                Text(
                    text = "Secure your account",
                    style = type.heritageTitle.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
                    textAlign = TextAlign.Center,
                )
            }

            val incidentId = successIncidentId

            if (incidentId != null) {
                // ── Success state ─────────────────────────────────────────────────
                GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                    Column(
                        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        // Alert-orange top border on success card signals this was
                        // a security event even after it resolves.
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(4.dp)
                                .background(alertOrange),
                        )
                        Column(
                            modifier = Modifier.padding(
                                start = KinfolkSpacing.m,
                                end = KinfolkSpacing.m,
                                bottom = KinfolkSpacing.m,
                            ),
                            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                text = "Your account is secured.",
                                style = type.heritageTitle,
                                textAlign = TextAlign.Center,
                            )
                            Text(
                                text = "Your password has been reset and the Tribe Tails team has been alerted. I am looking into this personally.",
                                style = type.sansBody.copy(color = c.navySoft),
                                textAlign = TextAlign.Center,
                            )
                            Text(
                                text = "You may now sign in with your new password. If you have any concerns, reply directly to the email you received.",
                                style = type.sansBody.copy(color = c.navySoft),
                                textAlign = TextAlign.Center,
                            )
                            Text(
                                text = "Investigation ID: $incidentId",
                                style = type.sansMeta.copy(color = c.navyMuted),
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
            } else {
                // ── Warning banner ────────────────────────────────────────────────
                GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        // Alert-orange left accent strip
                        Row {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(alertOrange.copy(alpha = 0.08f))
                                    .border(
                                        width = 0.dp,
                                        color = Color.Transparent,
                                        shape = KinfolkShapes.cardSmall,
                                    )
                                    .padding(KinfolkSpacing.m),
                            ) {
                                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                                    Text(
                                        text = "You flagged a password reset you did not request.",
                                        style = type.heritageSection.copy(color = alertOrange),
                                    )
                                    Text(
                                        text = "Set a new password now to lock your account. The Tribe Tails team is being alerted the moment you submit.",
                                        style = type.sansBody.copy(color = c.navySoft),
                                    )
                                    Text(
                                        text = "Account: $email",
                                        style = type.sansMeta.copy(color = c.navyMuted, fontWeight = FontWeight.SemiBold),
                                    )
                                }
                            }
                        }
                    }
                }

                // ── Password form ─────────────────────────────────────────────────
                GlassCard(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        KinField(
                            value = newPassword,
                            onValueChange = { newPassword = it; errorMessage = null },
                            label = "New Password (min 8 characters)",
                            enabled = !submitting,
                            isError = errorMessage != null && newPassword.isNotBlank() && !passwordLongEnough(),
                        )
                        KinField(
                            value = confirmPassword,
                            onValueChange = { confirmPassword = it; errorMessage = null },
                            label = "Confirm New Password",
                            enabled = !submitting,
                            isError = errorMessage != null && confirmPassword.isNotBlank() && !passwordsMatch(),
                        )

                        // Error banner — always visible, never silently swallowed.
                        val err = errorMessage
                        if (err != null) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(alertOrange.copy(alpha = 0.10f), KinfolkShapes.cardSmall)
                                    .border(1.dp, alertOrange.copy(alpha = 0.35f), KinfolkShapes.cardSmall)
                                    .padding(KinfolkSpacing.m),
                            ) {
                                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                                    Text(
                                        text = err,
                                        style = type.sansBody.copy(color = alertOrange),
                                    )
                                    Text(
                                        text = "Tap Dismiss to clear, or correct the fields above.",
                                        style = type.sansMeta.copy(color = alertOrange.copy(alpha = 0.70f)),
                                        modifier = Modifier.clickable { errorMessage = null },
                                    )
                                }
                            }
                        }

                        // Submit button — uses alert-orange gradient via a custom box
                        // to distinguish this CTA from the normal orange→pink gradient.
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(KinfolkShapes.pill)
                                .background(
                                    if (submitting)
                                        alertOrange.copy(alpha = 0.45f).let {
                                            androidx.compose.ui.graphics.SolidColor(it)
                                        }
                                    else
                                        androidx.compose.ui.graphics.SolidColor(alertOrange),
                                )
                                .clickable(enabled = !submitting) { submit() }
                                .padding(vertical = 14.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (submitting) {
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        color = Color.White,
                                        strokeWidth = 2.dp,
                                    )
                                    Text(
                                        text = "Securing your account…",
                                        style = type.sansButton.copy(color = Color.White),
                                    )
                                }
                            } else {
                                Text(
                                    text = "Reset password and alert team",
                                    style = type.sansButton.copy(color = Color.White, fontWeight = FontWeight.SemiBold),
                                )
                            }
                        }

                        Spacer(Modifier.height(KinfolkSpacing.xs))
                        Text(
                            text = "With urgency, Auntie at Tribe Tails",
                            style = type.sansMeta.copy(color = c.navyMuted),
                            modifier = Modifier.fillMaxWidth(),
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Returns the platform's user-agent string for the incident audit record.
 * On web this is the browser UA; on Android/JVM returns a descriptive stub.
 */
expect fun platformUserAgent(): String
