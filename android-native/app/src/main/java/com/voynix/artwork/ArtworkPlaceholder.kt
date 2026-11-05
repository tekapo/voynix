package com.voynix.artwork

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp

/**
 * Initial-letter placeholder for a cover with no image, ported from
 * CoverArt.tsx (Mac) so the same name gets the same color on both.
 * The hash mirrors JS: `hash = (hash * 31 + charCode) >>> 0` over UTF-16 units.
 */
internal fun placeholderHue(name: String): Int {
    var hash = 0L
    for (c in name) hash = (hash * 31 + c.code) and 0xFFFFFFFFL
    return (hash % 360).toInt()
}

internal fun initialOf(name: String): String {
    val first = name.trim().firstOrNull() ?: return "?"
    return first.uppercaseChar().toString()
}

@Composable
internal fun ArtworkInitial(name: String, boxSize: Dp, modifier: Modifier = Modifier) {
    val background = Color.hsl(placeholderHue(name).toFloat(), 0.38f, 0.28f)
    Box(
        modifier = modifier.fillMaxSize().drawBehind { drawRect(background) },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initialOf(name),
            color = Color.White.copy(alpha = 0.85f),
            fontWeight = FontWeight.SemiBold,
            fontSize = (boxSize.value * 0.45f).sp,
        )
    }
}
