package com.voynix.playback

/**
 * Package names of the car-side controllers that bind to [PlaybackService]'s
 * MediaSession: Android Auto (phone-projected) and Android Automotive OS
 * (embedded head unit). Used by [PlaybackService.LibrarySessionCallback]'s
 * onDisconnected to pause playback the moment the car disconnects — e.g. the
 * engine is turned off — even when no ACTION_AUDIO_BECOMING_NOISY broadcast
 * fires for that disconnect (not guaranteed for a USB Android Auto drop).
 */
private val CAR_CONTROLLER_PACKAGES = setOf(
    "com.google.android.projection.gearhead", // Android Auto
    "com.google.android.gms.car",
    "com.google.android.autos", // Android Automotive OS
)

fun isCarController(packageName: String): Boolean = packageName in CAR_CONTROLLER_PACKAGES

/**
 * Whether a controller disconnect should trigger the "car went away" pause.
 * Android Auto rebinds its MediaBrowser (browse-tree refreshes, head-unit app
 * switches) far more often than the car itself actually disconnects, and each
 * of those transient unbinds fired onDisconnected — pausing music/podcasts
 * every few minutes even mid-drive. A disconnect only means the car is gone
 * when [disconnectedPackage] was itself a car controller *and* no other car
 * controller is still connected to the session afterwards.
 */
fun shouldPauseOnCarDisconnect(
    disconnectedPackage: String,
    remainingControllerPackages: Collection<String>,
): Boolean = isCarController(disconnectedPackage) && remainingControllerPackages.none(::isCarController)
