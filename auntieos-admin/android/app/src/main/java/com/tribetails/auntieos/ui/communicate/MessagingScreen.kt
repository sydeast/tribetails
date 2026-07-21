package com.tribetails.auntieos.ui.communicate

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.data.model.MessageEvent
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun MessagingScreen(viewModel: MessagingViewModel) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) {
            listState.animateScrollToItem(0)
        }
    }

    AuntieScreenScaffold(
        title = null,
        imePaddingEnabled = true,
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.surface)
                .padding(16.dp)
        ) {
            Column {
                Text(
                    text = state.selectedKinfolk?.displayName ?: "Select a Kinfolk",
                    style = AuntieTheme.typography.titleLarge,
                    color = AuntieTheme.colors.kinfolkOrange,
                    fontWeight = FontWeight.Bold
                )
                if (state.selectedKinfolk != null) {
                    Text(
                        text = state.selectedKinfolk?.phoneNumber ?: "",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim
                    )
                }
            }
        }

        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            reverseLayout = true,
            contentPadding = PaddingValues(vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(state.messages) { message ->
                MessageBubble(message)
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(AuntieTheme.colors.surface)
        ) {
            Row(
                modifier = Modifier
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                AuntieField(
                    value = state.currentInput,
                    onValueChange = { viewModel.onInputChange(it) },
                    modifier = Modifier.weight(1f),
                    placeholder = "Type a message...",
                    singleLine = false,
                    maxLines = 4
                )

                Spacer(Modifier.width(8.dp))

                AuntieIconBtn(
                    onClick = { viewModel.sendMessage() },
                    enabled = state.currentInput.isNotBlank() && !state.isSending
                ) {
                    if (state.isSending) {
                        AuntieSpinner(
                            modifier = Modifier.size(24.dp),
                            color = AuntieTheme.colors.kinfolkOrange,
                            strokeWidth = 2.dp
                        )
                    } else {
                        Icon(
                            Lucide.Send,
                            contentDescription = "Send",
                            tint = if (state.currentInput.isNotBlank()) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textDim
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun MessageBubble(message: MessageEvent) {
    val isOutbound = message.direction == "outbound"
    val alignment = if (isOutbound) Alignment.End else Alignment.Start
    val bubbleColor = if (isOutbound) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.9f) else AuntieTheme.colors.surface
    val textColor = if (isOutbound) Color.Black else AuntieTheme.colors.textPrimary

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = alignment
    ) {
        Box(
            modifier = Modifier
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isOutbound) 16.dp else 2.dp,
                        bottomEnd = if (isOutbound) 2.dp else 16.dp
                    )
                )
                .background(bubbleColor)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .widthIn(max = 280.dp)
        ) {
            Column {
                Text(
                    text = message.body,
                    color = textColor,
                    style = AuntieTheme.typography.bodyMedium
                )
                Text(
                    text = formatTime(message.timestamp),
                    color = if (isOutbound) Color.Black.copy(alpha = 0.6f) else AuntieTheme.colors.textDim,
                    style = AuntieTheme.typography.labelSmall,
                    modifier = Modifier.align(Alignment.End),
                    fontSize = 10.sp
                )
            }
        }
    }
}

private fun formatTime(millis: Long): String {
    return SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(millis))
}
