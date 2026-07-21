package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.api.RetrofitClient
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

/**
 * Address field that shows Mapbox Geocoding suggestions as the user types.
 * Debounces 300 ms; fires only for 3+ character queries.
 */
@Composable
fun AddressAutocompleteField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String = "Service Address",
    modifier: Modifier = Modifier,
) {
    val geocodingApi = remember { RetrofitClient.buildMapboxGeocoding() }
    var suggestions  by remember { mutableStateOf<List<String>>(emptyList()) }
    var expanded     by remember { mutableStateOf(false) }

    LaunchedEffect(value) {
        if (value.length < 3) {
            suggestions = emptyList()
            expanded    = false
            return@LaunchedEffect
        }
        delay(300)
        runCatching {
            geocodingApi.suggest(query = value, token = MapboxConfig.ACCESS_TOKEN)
                .features.map { it.placeName }
        }.onSuccess { results ->
            suggestions = results
            expanded    = results.isNotEmpty()
        }
    }

    Box(modifier = modifier) {
        AuntieField(
            value         = value,
            onValueChange = {
                onValueChange(it)
                if (it.length < 3) {
                    suggestions = emptyList()
                    expanded    = false
                }
            },
            placeholder  = label,
            modifier     = Modifier.fillMaxWidth(),
            singleLine   = true,
        )
        DropdownMenu(
            expanded         = expanded && suggestions.isNotEmpty(),
            onDismissRequest = { expanded = false },
            containerColor   = AuntieTheme.colors.surface,
            border           = BorderStroke(1.dp, AuntieTheme.colors.border),
        ) {
            suggestions.forEach { suggestion ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            onValueChange(suggestion)
                            suggestions = emptyList()
                            expanded    = false
                        }
                        .padding(horizontal = 16.dp, vertical = 12.dp)
                ) {
                    Text(
                        text  = suggestion,
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textPrimary,
                    )
                }
            }
        }
    }
}
