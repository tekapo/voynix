package com.voynix

import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import com.voynix.artwork.AlbumArtResolver
import com.voynix.artwork.ArtistArtResolver
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.library.LibraryViewModel
import com.voynix.lyrics.LrclibApi
import com.voynix.playback.PlaybackService
import com.voynix.playback.PlayerController
import com.voynix.sync.SyncViewModel
import com.voynix.ui.VoynixApp
import com.voynix.ui.theme.VoynixTheme
import kotlinx.coroutines.launch
import java.util.UUID

class MainActivity : ComponentActivity() {

    private lateinit var db: VoynixDatabase
    private lateinit var libraryViewModel: LibraryViewModel
    private lateinit var syncViewModel: SyncViewModel
    private lateinit var albumArtResolver: AlbumArtResolver
    private lateinit var artistArtResolver: ArtistArtResolver
    private val lrclibApi = LrclibApi()

    // Playback now lives in PlaybackService so it survives this
    // Activity being destroyed — screen off, task swipe, or Android Auto
    // binding without MainActivity ever starting. The service is started
    // (not just bound) so it isn't killed the moment the Activity unbinds;
    // once actually playing, MediaSessionService promotes itself to a
    // foreground service with the standard media notification automatically.
    private var boundController = mutableStateOf<PlayerController?>(null)
    private var serviceConnection: ServiceConnection? = null

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op either way — playback still works without the notification */ }

    /** Android 13+ requires this at runtime or PlaybackService's media notification never posts. */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        db = VoynixDatabase.get(this)
        libraryViewModel = ViewModelProvider(this, LibraryViewModelFactory(db))[LibraryViewModel::class.java]
        syncViewModel = ViewModelProvider(this, SyncViewModelFactory(applicationContext, db))[SyncViewModel::class.java]
        albumArtResolver = AlbumArtResolver(applicationContext, db)
        artistArtResolver = ArtistArtResolver(db)
        startService(Intent(this, PlaybackService::class.java))
        requestNotificationPermissionIfNeeded()

        setContent {
            VoynixTheme {
                val player = boundController.value
                if (player == null) {
                    // Near-instant (in-process bind) — no need for a spinner.
                } else {
                    VoynixApp(
                        db = db,
                        player = player,
                        vm = libraryViewModel,
                        syncVm = syncViewModel,
                        albumArt = albumArtResolver,
                        artistArt = artistArtResolver,
                        lrclibApi = lrclibApi,
                        onImportTrack = { uri -> importTrack(uri) },
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                val local = binder as? PlaybackService.LocalBinder ?: return
                boundController.value = local.service.playerController
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                boundController.value = null
            }
        }
        serviceConnection = connection
        bindService(
            Intent(this, PlaybackService::class.java).setAction(PlaybackService.ACTION_LOCAL_BIND),
            connection,
            Context.BIND_AUTO_CREATE,
        )
    }

    override fun onStop() {
        super.onStop()
        serviceConnection?.let { unbindService(it) }
        serviceConnection = null
    }

    private fun importTrack(uri: Uri) {
        contentResolver.takePersistableUriPermission(
            uri,
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
        lifecycleScope.launch {
            val (title, artist, album, durationSecs) = readMetadata(contentResolver, uri)
            val fileName = queryDisplayName(contentResolver, uri) ?: uri.lastPathSegment ?: "unknown"
            val id = UUID.randomUUID().toString()
            db.trackDao().insert(
                TrackEntity(
                    id = id,
                    title = title ?: fileName,
                    artist = artist,
                    album = album,
                    filePath = uri.toString(),
                    fileName = fileName,
                    duration = durationSecs,
                    // The content_hash-based identity backfill (matching the Mac's
                    // algorithm) replaces this once sync exists; until then
                    // a locally-added track needs *some* track_key for play_events to
                    // join against (see TRACK_COLUMNS_WITH_STATS in db.ts).
                    trackKey = id,
                    addedAt = System.currentTimeMillis(),
                )
            )
        }
    }

    private data class Meta(val title: String?, val artist: String?, val album: String?, val durationSecs: Double?)

    private fun readMetadata(resolver: ContentResolver, uri: Uri): Meta {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(this, uri)
            val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
            val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
            val album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
            Meta(title, artist, album, durationMs?.let { it / 1000.0 })
        } catch (e: Exception) {
            Meta(null, null, null, null)
        } finally {
            retriever.release()
        }
    }

    private fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? {
        val projection = arrayOf(android.provider.OpenableColumns.DISPLAY_NAME)
        resolver.query(uri, projection, null, null, null)?.use { cursor ->
            val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && cursor.moveToFirst()) return cursor.getString(idx)
        }
        return null
    }
}

private class LibraryViewModelFactory(private val db: VoynixDatabase) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = LibraryViewModel(db) as T
}

private class SyncViewModelFactory(
    private val context: Context,
    private val db: VoynixDatabase,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = SyncViewModel(context, db) as T
}
