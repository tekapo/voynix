package com.voynix.ui.settings

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CleaningServices
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.voynix.BuildConfig
import com.voynix.R
import com.voynix.data.db.VoynixDatabase
import com.voynix.playback.PlayerController
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    context: Context,
    db: VoynixDatabase,
    player: PlayerController,
    onBack: () -> Unit,
    onOpenSync: () -> Unit,
    onOpenLicenses: () -> Unit,
) {
    var deviceId by remember { mutableStateOf<String?>(null) }
    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val podcastNoShuffle by player.podcastNoShuffle.collectAsState()

    LaunchedEffect(Unit) {
        deviceId = db.settingsDao().get("device_id")
    }

    val cacheClearedMessage = stringResource(R.string.settings_album_art_cache_cleared)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.settings_back))
                    }
                },
            )
        },
        snackbarHost = {
            SnackbarHost(snackbarHostState) { data ->
                Snackbar(snackbarData = data)
            }
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_wifi_sync)) },
                supportingContent = { Text(stringResource(R.string.settings_wifi_sync_detail)) },
                leadingContent = { Icon(Icons.Filled.Sync, contentDescription = null) },
                modifier = Modifier.clickable(onClick = onOpenSync),
            )
            // Android 13+ (API 33) exposes a per-app language override via
            // LocaleManager; below that, this app has no in-app language
            // switch (system settings still work via generateLocaleConfig)
            // rather than pulling in AppCompat just for this one row.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                LanguageSetting()
            }
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_dont_shuffle_podcasts)) },
                supportingContent = { Text(stringResource(R.string.settings_dont_shuffle_podcasts_detail)) },
                leadingContent = { Icon(Icons.Filled.Shuffle, contentDescription = null) },
                trailingContent = {
                    Switch(checked = podcastNoShuffle, onCheckedChange = { player.setPodcastNoShuffle(it) })
                },
                modifier = Modifier.clickable { player.setPodcastNoShuffle(!podcastNoShuffle) },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_clear_album_art_cache)) },
                supportingContent = { Text(stringResource(R.string.settings_clear_album_art_cache_detail)) },
                leadingContent = { Icon(Icons.Filled.CleaningServices, contentDescription = null) },
                modifier = Modifier.clickable {
                    scope.launch {
                        clearAlbumArtCache(context)
                        snackbarHostState.showSnackbar(cacheClearedMessage)
                    }
                },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_device_id)) },
                supportingContent = { Text(deviceId ?: stringResource(R.string.settings_device_id_placeholder)) },
                leadingContent = { Icon(Icons.Filled.Fingerprint, contentDescription = null) },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.app_name)) },
                supportingContent = { Text(stringResource(R.string.settings_version, BuildConfig.VERSION_NAME)) },
                leadingContent = { Icon(Icons.Filled.Info, contentDescription = null) },
                colors = ListItemDefaults.colors(
                    supportingColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.settings_licenses)) },
                leadingContent = { Icon(Icons.Filled.Description, contentDescription = null) },
                modifier = Modifier.clickable(onClick = onOpenLicenses),
            )
        }
    }
}

private suspend fun clearAlbumArtCache(context: Context) = withContext(Dispatchers.IO) {
    File(context.cacheDir, "album_art").deleteRecursively()
}

/** System / English / 日本語 — reads and writes the per-app locale override
 *  (Settings > Apps > Voynix > Language, or here) via [LocaleManager]. */
@androidx.annotation.RequiresApi(Build.VERSION_CODES.TIRAMISU)
@Composable
private fun LanguageSetting() {
    val context = LocalContext.current
    val localeManager = context.getSystemService(LocaleManager::class.java)
    var menuOpen by remember { mutableStateOf(false) }
    // Re-read whenever the menu (re)opens so a change made from system
    // Settings while this screen was in the background is reflected.
    var current by remember { mutableStateOf(localeManager.applicationLocales) }
    LaunchedEffect(menuOpen) { if (menuOpen) current = localeManager.applicationLocales }

    val label = when {
        current.isEmpty -> stringResource(R.string.settings_language_system)
        current.get(0)?.language == "ja" -> stringResource(R.string.settings_language_japanese)
        else -> stringResource(R.string.settings_language_english)
    }

    fun choose(locales: LocaleList) {
        localeManager.applicationLocales = locales
        menuOpen = false
    }

    ListItem(
        headlineContent = { Text(stringResource(R.string.settings_language)) },
        supportingContent = { Text(label) },
        leadingContent = { Icon(Icons.Filled.Language, contentDescription = null) },
        modifier = Modifier.clickable { menuOpen = true },
    )
    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.settings_language_system)) },
            onClick = { choose(LocaleList.getEmptyLocaleList()) },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.settings_language_english)) },
            onClick = { choose(LocaleList.forLanguageTags("en")) },
        )
        DropdownMenuItem(
            text = { Text(stringResource(R.string.settings_language_japanese)) },
            onClick = { choose(LocaleList.forLanguageTags("ja")) },
        )
    }
}
