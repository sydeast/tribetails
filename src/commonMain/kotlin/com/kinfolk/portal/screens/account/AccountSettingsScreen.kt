package com.kinfolk.portal.screens.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.SchemaFormRenderer
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.Account
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch

@Composable
fun AccountSettingsScreen(
    familyName: String,
    portalApi: PortalApi,
    kinfolkId: String? = null,
    onSignOut: () -> Unit = {},
    onOpenTribeProfile: () -> Unit = {},
    repo: AuthRepository? = null,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<Account?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    var showSignOutConfirm by remember { mutableStateOf(false) }

    var displayName by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var photoUrl by remember { mutableStateOf("") }
    var backupEmail by remember { mutableStateOf("") }
    var backupPhone by remember { mutableStateOf("") }
    var secondaryEmail by remember { mutableStateOf("") }
    var secondaryLabel by remember { mutableStateOf("") }
    var inviting by remember { mutableStateOf(false) }

    /** Optional admin-driven schema. When present, schema-rendered values replace
     *  the static editable fields; persistence stays typed via saveMyAccount. */
    var accountSchema by remember { mutableStateOf<FormSchema?>(null) }
    var accountValues by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    LaunchedEffect(Unit) {
        try {
            val a = portalApi.getMyAccount()
            loaded = a
            // Older accounts seeded displayName with the email (onAuthUserCreate);
            // never pre-fill the name field with the email — start blank so the
            // "First & Last Name" label acts as the prompt.
            displayName = a.displayName?.takeIf { it != a.email }.orEmpty()
            phone = a.phone.orEmpty()
            photoUrl = a.photoUrl.orEmpty()
            backupEmail = a.backupEmail.orEmpty()
            backupPhone = a.backupPhone.orEmpty()
            error = null
        } catch (t: Throwable) {
            error = t.message ?: "Could not load account"
        }
        // Best-effort schema load. Fall back silently to static fields if missing.
        try {
            val s = portalApi.getFormSchema("account")
            accountSchema = s
            // Seed schema values from the current account. secondaryEmail/secondaryRole
            // start blank (they drive the invite flow, not stored account fields).
            accountValues = mapOf(
                "displayName" to displayName,
                "phone" to phone,
                "secondaryEmail" to secondaryEmail,
                "secondaryRole" to secondaryLabel,
                "backupEmail" to backupEmail,
                "backupPhone" to backupPhone,
            )
        } catch (_: Throwable) { /* admin has not set up schema yet, keep static fields */ }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(title = "Account Settings", kicker = "Account")
        // "First & Last Name" below is the user's OWN name, not the household/tribe
        // name (that lives on the Tribe profile) — quick link so they don't conflate them.
        Text(
            "Manage your family, home & vet → Tribe profile",
            style = type.sansLabel.copy(color = KinfolkBrand.KinTeal),
            modifier = Modifier
                .clickable { onOpenTribeProfile() }
                .padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.xs),
        )
        if (loaded == null && error == null) {
            Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
            }
            return@Column
        }
        if (error != null) {
            Text(error!!, style = type.sansBody, modifier = Modifier.padding(horizontal = KinfolkSpacing.l))
            return@Column
        }

        // Editable contact fields. Admin schema (when present) drives the form;
        // otherwise the static three-card stack. Both paths feed the same typed save.
        val schema = accountSchema
        if (schema != null) {
            SchemaFormRenderer(
                schema = schema,
                values = accountValues,
                onChange = { accountValues = it },
            )
            // The email + avatar are not schema fields, so they ride alongside the
            // schema-rendered Profile section.
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text(loaded?.email ?: "Not set", style = type.sansBody)
                    AvatarPickerRow(
                        portalApi = portalApi,
                        photoUrl = photoUrl,
                        onPhotoUrl = { photoUrl = it },
                        onError = { msg -> status = msg },
                    )
                }
            }
            // Send Invite stays as a dedicated action against the schema's secondary
            // contact values (the schema renders only the fields, not the button).
            KinButton(
                label = if (inviting) "Sending…" else "Send Invite",
                onClick = {
                    inviting = true
                    status = null
                    scope.launch {
                        try {
                            portalApi.addSecondaryContact(
                                kinfolkId = kinfolkId,
                                invitedEmail = accountValues["secondaryEmail"].orEmpty().trim(),
                                secondaryLabel = accountValues["secondaryRole"].orEmpty().trim().ifBlank { null },
                            )
                            accountValues = accountValues + ("secondaryEmail" to "") + ("secondaryRole" to "")
                            status = "Invite sent."
                        } catch (t: Throwable) {
                            status = "Invite failed: ${t.message ?: t}"
                        } finally {
                            inviting = false
                        }
                    }
                },
                enabled = !inviting && accountValues["secondaryEmail"].orEmpty().contains("@"),
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
            )
        } else {
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("Profile", style = type.sansLabel)
                    Text(loaded?.email ?: "Not set", style = type.sansBody)
                    KinField(
                        value = displayName,
                        onValueChange = { displayName = it },
                        label = "First & Last Name *",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    // Save is gated on a name; say so instead of a silently dead button.
                    if (displayName.isBlank()) {
                        Text(
                            "Add your name to save.",
                            style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                        )
                    }
                    KinField(
                        value = phone,
                        onValueChange = { phone = it },
                        label = "Phone",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    AvatarPickerRow(
                        portalApi = portalApi,
                        photoUrl = photoUrl,
                        onPhotoUrl = { photoUrl = it },
                        onError = { msg -> status = msg },
                    )
                }
            }

            // Secondary-Kinfolk invite moved to the Tribe page (per smoke-test).
            // The schema-driven path below still offers it for admin-schema accounts.

            Text("Recovery Contacts", style = type.heritageSection, modifier = Modifier.padding(start = KinfolkSpacing.l, end = KinfolkSpacing.l, top = KinfolkSpacing.m))
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    KinField(
                        value = backupEmail,
                        onValueChange = { backupEmail = it },
                        label = "Backup Email",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    KinField(
                        value = backupPhone,
                        onValueChange = { backupPhone = it },
                        label = "Backup Phone",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }

        if (repo != null) SecuritySection(repo)

        Text("Billing Details", style = type.heritageSection, modifier = Modifier.padding(start = KinfolkSpacing.l, end = KinfolkSpacing.l, top = KinfolkSpacing.m))
        GlassCard(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text(
                    text = if (loaded?.hasPaymentMethod == true) "Payment method on file" else "No payment method on file",
                    style = type.sansBody,
                )
                Text(
                    "Card payments are coming soon. Until then, settle up directly with your Auntie.",
                    style = type.sansMeta,
                )
            }
        }

        if (status != null) {
            Text(status!!, style = type.sansLabel.copy(color = KinfolkBrand.KinTeal), modifier = Modifier.padding(horizontal = KinfolkSpacing.l))
        }
        KinButton(
            label = if (saving) "Saving…" else "Save Changes",
            onClick = {
                saving = true
                status = null
                scope.launch {
                    try {
                        // Persistence stays typed: read the schema values map when the
                        // schema drives the form, otherwise the static field state.
                        val schema = accountSchema
                        if (schema != null) {
                            portalApi.saveMyAccount(
                                displayName = accountValues["displayName"].orEmpty().trim().takeIf { it.isNotBlank() },
                                phone = accountValues["phone"].orEmpty().trim().takeIf { it.isNotBlank() },
                                photoUrl = photoUrl.trim().takeIf { it.isNotBlank() },
                                backupEmail = accountValues["backupEmail"].orEmpty().trim().takeIf { it.isNotBlank() },
                                backupPhone = accountValues["backupPhone"].orEmpty().trim().takeIf { it.isNotBlank() },
                            )
                        } else {
                            portalApi.saveMyAccount(
                                displayName = displayName.trim().takeIf { it.isNotBlank() },
                                phone = phone.trim().takeIf { it.isNotBlank() },
                                photoUrl = photoUrl.trim().takeIf { it.isNotBlank() },
                                backupEmail = backupEmail.trim().takeIf { it.isNotBlank() },
                                backupPhone = backupPhone.trim().takeIf { it.isNotBlank() },
                            )
                        }
                        // Verify persistence by reloading from the server, so a
                        // silent write failure surfaces instead of a false "Saved."
                        val fresh = portalApi.getMyAccount()
                        loaded = fresh
                        val freshName = fresh.displayName?.takeIf { it != fresh.email }.orEmpty()
                        displayName = freshName
                        phone = fresh.phone.orEmpty()
                        photoUrl = fresh.photoUrl.orEmpty()
                        backupEmail = fresh.backupEmail.orEmpty()
                        backupPhone = fresh.backupPhone.orEmpty()
                        if (accountSchema != null) {
                            accountValues = accountValues + mapOf(
                                "displayName" to freshName,
                                "phone" to phone,
                                "backupEmail" to backupEmail,
                                "backupPhone" to backupPhone,
                            )
                        }
                        status = "Saved."
                    } catch (t: Throwable) {
                        status = "Save failed: ${t.message ?: t}"
                    } finally {
                        saving = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
            // "First & Last Name" is required: block save when it's blank.
            enabled = !saving && (if (accountSchema != null) accountValues["displayName"].orEmpty() else displayName).isNotBlank(),
        )

        KinGhostButton(
            label = "Sign Out",
            onClick = { showSignOutConfirm = true },
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l, vertical = KinfolkSpacing.s),
        )
        Spacer(Modifier.height(KinfolkSpacing.l))
    }

    // Confirm before ending the session — a stray tap shouldn't log anyone out.
    if (showSignOutConfirm) {
        AlertDialog(
            onDismissRequest = { showSignOutConfirm = false },
            title = { Text("Sign out of MyTribe?") },
            confirmButton = {
                TextButton(onClick = {
                    showSignOutConfirm = false
                    onSignOut()
                }) { Text("Sign Out") }
            },
            dismissButton = {
                TextButton(onClick = { showSignOutConfirm = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun AvatarPickerRow(
    portalApi: com.kinfolk.portal.portal.PortalApi,
    photoUrl: String,
    onPhotoUrl: (String) -> Unit,
    onError: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var uploading by remember { mutableStateOf(false) }

    val launchPicker = com.kinfolk.portal.media.rememberPhotoPicker { picked ->
        if (picked == null) return@rememberPhotoPicker
        // Parity with Kin photos: enforce the same 2MB / image-type cap before upload
        // (the kinfolk avatar previously had no client-side limit at all).
        com.kinfolk.portal.media.KinPhotoPolicy.validate(picked)?.let { problem ->
            onError(problem)
            return@rememberPhotoPicker
        }
        scope.launch {
            uploading = true
            try {
                val signed = portalApi.signKinfolkAvatar()
                if (signed.cloudName.isBlank()) {
                    onError("Photo uploads aren't available right now. Try again later.")
                    return@launch
                }
                val secureUrl = com.kinfolk.portal.media.uploadImageToCloudinary(signed, picked)
                if (secureUrl.isNullOrBlank()) {
                    onError("Upload failed, try again")
                    return@launch
                }
                onPhotoUrl(secureUrl)
            } catch (t: Throwable) {
                onError("Upload failed: ${t.message ?: t}")
            } finally {
                uploading = false
            }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
        Text("Profile Photo", style = type.sansLabel)
        KinfolkAvatar(
            url = photoUrl,
            contentDescription = "Profile photo",
            size = 96.dp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            KinGhostButton(
                label = if (uploading) "Uploading…" else if (photoUrl.isBlank()) "Pick Photo" else "Replace Photo",
                onClick = launchPicker,
                enabled = !uploading,
                modifier = Modifier.weight(1f),
            )

            if (photoUrl.isNotBlank()) {
                KinGhostButton(
                    label = "Clear",
                    onClick = { onPhotoUrl("") },
                    enabled = !uploading,
                )
            }
        }
    }
}

/** Change Password + Change Email via Firebase Auth (re-auth required).
 *  Password fields are masked; email change sends a verification link to the
 *  new address before it takes effect. */
@Composable
private fun SecuritySection(repo: AuthRepository) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var curPw by remember { mutableStateOf("") }
    var newPw by remember { mutableStateOf("") }
    var pwBusy by remember { mutableStateOf(false) }
    var pwMsg by remember { mutableStateOf<String?>(null) }
    var emailPw by remember { mutableStateOf("") }
    var newEmail by remember { mutableStateOf("") }
    var emailBusy by remember { mutableStateOf(false) }
    var emailMsg by remember { mutableStateOf<String?>(null) }

    Text("Security", style = type.heritageSection, modifier = Modifier.padding(start = KinfolkSpacing.l, end = KinfolkSpacing.l, top = KinfolkSpacing.m))
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Change Password", style = type.sansLabel)
            OutlinedTextField(
                value = curPw, onValueChange = { curPw = it },
                label = { Text("Current Password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = newPw, onValueChange = { newPw = it },
                label = { Text("New Password (min 6 chars)") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            KinButton(
                label = if (pwBusy) "Updating…" else "Update Password",
                onClick = {
                    pwBusy = true
                    pwMsg = null
                    scope.launch {
                        try {
                            repo.changePassword(curPw, newPw)
                            curPw = ""; newPw = ""
                            pwMsg = "Password updated."
                        } catch (t: Throwable) {
                            pwMsg = "Couldn't update: ${t.message ?: t}"
                        } finally {
                            pwBusy = false
                        }
                    }
                },
                enabled = !pwBusy && curPw.isNotBlank() && newPw.length >= 6,
                modifier = Modifier.fillMaxWidth(),
            )
            pwMsg?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.KinTeal)) }

            Spacer(Modifier.height(KinfolkSpacing.s))
            Text("Change Email", style = type.sansLabel)
            OutlinedTextField(
                value = emailPw, onValueChange = { emailPw = it },
                label = { Text("Current Password") },
                visualTransformation = PasswordVisualTransformation(),
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = newEmail, onValueChange = { newEmail = it },
                label = { Text("New Email") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            KinButton(
                label = if (emailBusy) "Sending…" else "Update Email",
                onClick = {
                    emailBusy = true
                    emailMsg = null
                    scope.launch {
                        try {
                            repo.changeEmail(emailPw, newEmail)
                            emailPw = ""
                            emailMsg = "Check your new inbox to confirm the change."
                        } catch (t: Throwable) {
                            emailMsg = "Couldn't update: ${t.message ?: t}"
                        } finally {
                            emailBusy = false
                        }
                    }
                },
                enabled = !emailBusy && emailPw.isNotBlank() && newEmail.contains("@"),
                modifier = Modifier.fillMaxWidth(),
            )
            emailMsg?.let { Text(it, style = type.sansLabel.copy(color = KinfolkBrand.KinTeal)) }
        }
    }
}
