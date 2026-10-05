package com.voynix.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Platform default typeface (Roboto Flex on modern Android) — no bundled/
// downloadable font, since a Latin-only display font would silently fall
// back for Japanese labels (曲/アーティスト/...) and break the type rhythm.
private val base = Typography()

val VoynixTypography = base.copy(
    headlineLarge = base.headlineLarge.withEmphasis(),
    headlineMedium = base.headlineMedium.withEmphasis(),
    headlineSmall = base.headlineSmall.withEmphasis(),
    titleLarge = base.titleLarge.withEmphasis(),
)

private fun TextStyle.withEmphasis(): TextStyle =
    copy(fontWeight = FontWeight.Medium, letterSpacing = (letterSpacing.value - 0.1f).sp)
