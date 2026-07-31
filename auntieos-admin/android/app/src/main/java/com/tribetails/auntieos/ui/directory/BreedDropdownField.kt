package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Run-4 #6: breed input with a type-to-search dropdown over the seeded dog/cat bank.
 * The value stays free-text so a mix or rare breed not in the bank is still enterable.
 * An empty [catalog] (other species, a load failure, or the desktop callable stub)
 * degrades to a plain field, with [note] disclosing the degraded state. Mirrors the
 * web BreedField and the inline vet-clinic dropdown idiom.
 */
@Composable
fun BreedDropdownField(
    value: String,
    onValueChange: (String) -> Unit,
    catalog: List<String>,
    note: String?,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    Column(modifier) {
        AuntieField(
            value = value,
            onValueChange = onValueChange,
            label = if (catalog.isEmpty()) "Breed" else "Breed (type to search)",
            modifier = Modifier.fillMaxWidth(),
            // onFocusChanged MUST attach here, not to `modifier` above: AuntieField
            // applies `modifier` to its own outer Column, which is never itself the
            // focused leaf node, so `.isFocused` read there is always false and the
            // suggestion list below could never open, for ANY catalog. fieldModifier
            // is the parameter AuntieField documents for exactly this: it lands on
            // the real BasicTextField (see AdminLoginScreen for the same pattern).
            // The contentDescription also gives this field a stable test/ a11y hook.
            fieldModifier = Modifier
                .semantics { contentDescription = "Breed" }
                .onFocusChanged { focused = it.isFocused },
        )
        if (note != null) {
            Text(
                note,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        val matches = breedSuggestions(value, catalog)
        val exact = catalog.any { it.equals(value.trim(), ignoreCase = true) }
        // B5: show the bank while the field is focused (blank -> bank head, typing ->
        // matches); hide once a breed is committed (exact) or focus leaves, so the
        // dropdown doesn't sit permanently open in the edit form.
        if (focused && matches.isNotEmpty() && !exact) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 6.dp)
                    .background(AuntieTheme.colors.surface2, RoundedCornerShape(12.dp)),
            ) {
                matches.forEach { breed ->
                    Text(
                        breed,
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textPrimary,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onValueChange(breed) }
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
        }
    }
}
