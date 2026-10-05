package com.voynix.playback

import android.net.Uri
import java.io.File

/**
 * Builds a playable [Uri] from a track's stored `filePath`. Synced files are plain absolute
 * paths (e.g. from `SyncApi.downloadFile`) and must go through [Uri.fromFile], which percent-
 * encodes reserved characters (`%`, `#`, `?`, ...) — `Uri.parse` on a raw path instead
 * misinterprets a literal `%` in a filename as the start of an escape sequence, corrupting the
 * path and silently failing to load (e.g. "シカト100万% [Live].m4a"). Locally-imported tracks
 * are already `content://...` strings and must stay as `Uri.parse`.
 */
fun trackUri(filePath: String): Uri =
    if (filePath.startsWith("/")) Uri.fromFile(File(filePath)) else Uri.parse(filePath)
