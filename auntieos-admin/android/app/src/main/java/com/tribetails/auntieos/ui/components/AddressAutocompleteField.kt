package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.api.MapboxSuggestion
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Address field with Mapbox suggestions, driven entirely by the caller.
 *
 * MIGRATED 2026-07-25. This used to hold a Retrofit `MapboxGeocodingApi` and
 * call `api.mapbox.com` directly with `MapboxConfig.ACCESS_TOKEN`, which shipped
 * a live Mapbox key inside the APK where anyone could pull it out and spend the
 * account's quota. The lookup now goes through the `mapboxSearch` /
 * `mapboxRetrieve` callables, which hold the token as a Functions secret, so the
 * key ships in zero clients.
 *
 * That moved the work off the composable: suggestions arrive from a view model
 * (which owns the debounce, the reused session token and the rotation after a
 * retrieve, per Mapbox's session billing), and this is the dumb view. Errors
 * fail LOUD in a red inline banner and never block typing, because a household
 * on a new build or an unnamed drive still has to be enterable by hand.
 */
@Composable
fun AddressAutocompleteField(
    value: String,
    onValueChange: (String) -> Unit,
    suggestions: List<MapboxSuggestion>,
    onQueryChange: (String) -> Unit,
    onPick: (MapboxSuggestion) -> Unit,
    errorMessage: String? = null,
    label: String = "Service Address",
    modifier: Modifier = Modifier,
) {
    var dismissed by remember { mutableStateOf(false) }
    val expanded = suggestions.isNotEmpty() && !dismissed

    Column(modifier = modifier) {
        Box(modifier = Modifier.fillMaxWidth()) {
            AuntieField(
                value = value,
                onValueChange = {
                    onValueChange(it)
                    // Typing reopens a list the operator previously dismissed;
                    // dismissal shuts the dropdown, it does not mute the field.
                    dismissed = false
                    onQueryChange(it)
                },
                placeholder = label,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { dismissed = true },
                containerColor = AuntieTheme.colors.surface,
                border = BorderStroke(1.dp, AuntieTheme.colors.border),
            ) {
                suggestions.forEach { suggestion ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable {
                                onPick(suggestion)
                                dismissed = true
                            }
                            .padding(horizontal = 16.dp, vertical = 10.dp)
                    ) {
                        Text(
                            text = suggestion.name.ifBlank { suggestion.fullAddress },
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        if (suggestion.fullAddress.isNotBlank() && suggestion.fullAddress != suggestion.name) {
                            Text(
                                text = suggestion.fullAddress,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }
                }
            }
        }

        if (errorMessage != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(AuntieTheme.colors.error.copy(alpha = 0.10f))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text(
                    text = "Address lookup failed: $errorMessage. Type the full street address manually.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
        }
    }
}
