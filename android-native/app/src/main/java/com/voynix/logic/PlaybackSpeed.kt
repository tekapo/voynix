package com.voynix.logic

// Podcast playback speed, ported from src/playback.ts. One shared speed
// setting applies to every podcast (not per-episode); music always plays at
// 1.0x. Persisted as the "podcast_speed" setting (SettingsDao).

val SPEED_PRESETS: List<Float> = listOf(0.8f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)

/** Parses a stored speed string; anything invalid or outside the preset range falls back to 1.0. */
fun parseSpeed(raw: String?): Float {
    val n = raw?.toFloatOrNull() ?: return 1.0f
    return if (SPEED_PRESETS.contains(n)) n else 1.0f
}

/** Cycles to the next preset, wrapping back to the first after the last. */
fun nextSpeed(current: Float): Float {
    val i = SPEED_PRESETS.indexOf(current)
    return SPEED_PRESETS[(i + 1 + SPEED_PRESETS.size) % SPEED_PRESETS.size]
}

/** Human-readable label, e.g. "1.25x". */
fun formatSpeed(speed: Float): String {
    val trimmed = if (speed == speed.toLong().toFloat()) speed.toLong().toString() else speed.toString()
    return "${trimmed}x"
}

/** Music always plays at 1.0x; only a podcast uses the stored speed. */
fun effectiveSpeed(kind: String?, podcastSpeed: Float): Float =
    if (kind == "podcast") podcastSpeed else 1.0f
