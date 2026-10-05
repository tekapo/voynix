package com.voynix.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A shuffle/repeat-style mode toggle that shows on/off through color and icon — a plain
 * M3 [FilledIconToggleButton] only differs by container tint, which reads as "on" or "off"
 * depending on the dynamic color palette. OFF has a transparent container so only the
 * checked state is ever filled.
 */
@Composable
fun ModeToggleButton(
    checked: Boolean,
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: String? = null,
) {
    Box(modifier = modifier) {
        FilledIconToggleButton(
            checked = checked,
            onCheckedChange = { onClick() },
            colors = IconButtonDefaults.filledIconToggleButtonColors(
                containerColor = Color.Transparent,
                contentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                checkedContainerColor = MaterialTheme.colorScheme.primary,
                checkedContentColor = MaterialTheme.colorScheme.onPrimary,
            ),
        ) {
            Icon(icon, contentDescription = contentDescription)
        }
        if (badge != null) {
            // Bold marker for modes the icon alone can't tell apart (repeat-one's tiny "1").
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .size(24.dp)
                    .background(MaterialTheme.colorScheme.onPrimary, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(badge, color = MaterialTheme.colorScheme.primary, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            }
        }
    }
}
