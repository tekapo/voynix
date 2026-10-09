package com.voynix.logic

/**
 * Whether to open the first-launch welcome guide: only if it was never shown
 * and no Mac is paired yet (someone who already paired doesn't need it).
 */
fun shouldShowWelcome(seen: Boolean, paired: Boolean): Boolean = !seen && !paired
