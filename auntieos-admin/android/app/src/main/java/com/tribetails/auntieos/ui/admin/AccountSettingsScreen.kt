package com.tribetails.auntieos.ui.admin

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Account Settings (punch list #4): the operator's own Profile + Security (login
 * email/password), moved out of the business Admin Settings screen. Reuses the same
 * AdminSettingsViewModel + the internal [ProfilePanel] + [SecurityPanel] verbatim, so
 * the profile-save + credential flows are identical; only their home changed. Reached
 * from the "Your account" entry on Admin Settings.
 */
@Composable
fun AccountSettingsScreen(
    onBack: () -> Unit,
    viewModel: AdminSettingsViewModel = viewModel<AdminSettingsViewModel>(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val dims = AuntieTheme.dims

    val avatarPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) viewModel.uploadAvatar(context, uri) }

    var toastMessage by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind by remember { mutableStateOf(ToastKind.Info) }

    LaunchedEffect(Unit) { viewModel.loadUserProfile() }
    LaunchedEffect(uiState.profileSaveSuccess) {
        if (uiState.profileSaveSuccess) {
            toastMessage = "Profile saved"; toastKind = ToastKind.Success; toastVisible = true
            viewModel.clearProfileSaveSuccess()
        }
    }
    LaunchedEffect(uiState.passwordResetSent) {
        if (uiState.passwordResetSent) {
            toastMessage = "Password reset email sent"; toastKind = ToastKind.Success; toastVisible = true
            viewModel.clearPasswordResetSent()
        }
    }
    LaunchedEffect(uiState.error) {
        val err = uiState.error
        if (err != null) {
            toastMessage = err; toastKind = ToastKind.Error; toastVisible = true
            viewModel.clearError()
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AuntieScreenScaffold(title = "Account", onBack = onBack, imePaddingEnabled = true) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(dims.space4)
                    .verticalScroll(rememberScrollState()),
            ) {
                DenScreenHeading(
                    kicker = "The Den · Account",
                    title = "Your",
                    accentTail = "account.",
                    subtitle = "Your personal profile and login. Business settings live under Admin Settings.",
                )
                Spacer(Modifier.height(dims.space5))

                ProfilePanel(
                    profile = uiState.profile,
                    isUploadingAvatar = uiState.isUploadingAvatar,
                    isLoading = uiState.isLoading,
                    onPickAvatar = {
                        avatarPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                        )
                    },
                    onProfileField = viewModel::updateProfileField,
                    onSaveProfile = { viewModel.saveProfile() },
                )
                Spacer(Modifier.height(dims.space5))

                SecurityPanel(
                    email = uiState.profile.email,
                    isSending = uiState.isSendingPasswordReset,
                    busy = uiState.credentialBusy,
                    message = uiState.credentialMessage,
                    onSendReset = { viewModel.sendPasswordResetEmail(uiState.profile.email) },
                    onChangeEmail = { curPw, newEmail -> viewModel.changeLoginEmail(curPw, newEmail) },
                    onChangePassword = { curPw, newPw, confirm -> viewModel.changeLoginPassword(curPw, newPw, confirm) },
                )
            }
        }

        StatusToast(
            visible = toastVisible,
            message = toastMessage,
            kind = toastKind,
            onDismiss = { toastVisible = false },
            modifier = Modifier.align(Alignment.BottomCenter).padding(dims.space4),
        )
    }
}
