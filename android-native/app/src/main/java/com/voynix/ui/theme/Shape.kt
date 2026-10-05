package com.voynix.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

// M3 1.4.0's ShapeDefaults expressive tokens are marked internal to the
// module (compile-time visible via bytecode but blocked by Kotlin metadata),
// so these are spelled out directly — same corner radii M3's own defaults use.
val VoynixShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Large artwork (Now Playing) — bigger than the theme's extraLarge token. */
val VoynixArtworkShape = RoundedCornerShape(28.dp)
