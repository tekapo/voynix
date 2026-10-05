import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getVersion } from '@tauri-apps/api/app';
import { useTranslation } from 'react-i18next';
import { ScanFolder, ServerActivity, ServerStatus, TrackKind } from '../types';
import type { TranscodeFormat } from '../db';
import { Icon } from './Icon';
import type { LanguagePreference } from '../i18n';
import { pairingQrDataUri } from '../syncPairing';

// Render modals at <body> so the fixed-position overlay isn't offset by an
// ancestor that establishes a containing block (the sidebar's transform, the
// header/player-bar backdrop-filter, …).
export const Portal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    createPortal(children, document.body);

/** Formats a SHA-256 hex fingerprint for on-screen comparison, e.g.
 *  "a1b2 c3d4 e5f6 0789" — mirrors `tls::short_fingerprint` (Rust). */
const shortFingerprint = (fingerprint: string): string =>
    fingerprint.slice(0, 16).match(/.{1,4}/g)?.join(' ') ?? fingerprint;

interface CreatePlaylistModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (e: React.FormEvent) => void;
    playlistName: string;
    setPlaylistName: (name: string) => void;
}

export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
    isOpen,
    onClose,
    onSubmit,
    playlistName,
    setPlaylistName
}) => {
    const { t } = useTranslation();
    if (!isOpen) return null;
    return (
        <Portal><div className="modal-overlay">
            <div className="modal-content">
                <h3>{t('modals.createPlaylist')}</h3>
                <form onSubmit={onSubmit}>
                    <input
                        type="text"
                        autoFocus
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        className="modal-input"
                        placeholder={t('modals.playlistNamePlaceholder')}
                    />
                    <div className="modal-actions">
                        <button type="button" className="modal-btn cancel" onClick={onClose}>{t('modals.cancel')}</button>
                        <button type="submit" className="modal-btn confirm">{t('modals.create')}</button>
                    </div>
                </form>
            </div>
        </div></Portal>
    );
};

interface SyncModalProps {
    isOpen: boolean;
    onClose: () => void;
    serverStatus: ServerStatus | null;
    serverActivity: ServerActivity | null;
    prepareProgress: { done: number; total: number } | null;
    toggleServer: () => void;
}

const ServerSide: React.FC<Pick<SyncModalProps, 'serverStatus' | 'serverActivity' | 'prepareProgress' | 'toggleServer'>> = ({
    serverStatus,
    serverActivity,
    prepareProgress,
    toggleServer
}) => {
    const { t } = useTranslation();
    const ago = (ms: number | null) =>
        ms ? new Date(ms).toLocaleTimeString() : t('modals.never');
    const [qrSrc, setQrSrc] = useState<string | null>(null);
    const running = serverStatus?.running ?? false;
    const url = serverStatus?.url;
    const token = serverStatus?.token;
    const fingerprint = serverStatus?.fingerprint;
    useEffect(() => {
        if (!running || !url || !token || !fingerprint) {
            setQrSrc(null);
            return;
        }
        let cancelled = false;
        pairingQrDataUri({ url, token, fingerprint })
            .then(src => { if (!cancelled) setQrSrc(src); })
            .catch(() => { if (!cancelled) setQrSrc(null); });
        return () => { cancelled = true; };
    }, [running, url, token, fingerprint]);
    return (
        <>
            <h3>{t('modals.wifiSyncServer')}</h3>
            <p>{t('modals.wifiSyncIntro')}</p>
            <div className="sync-server-status">
                {serverStatus?.running ? (
                    <div className="status-running">
                        {qrSrc && (
                            <>
                                <img
                                    src={qrSrc}
                                    alt={t('modals.pairingQrAlt')}
                                    width={200}
                                    height={200}
                                    style={{ background: '#fff', borderRadius: 8, padding: 4 }}
                                />
                                <p className="settings-hint">{t('modals.scanQrHint')}</p>
                            </>
                        )}
                        <p className="server-url">{serverStatus.url}</p>
                        <p className="server-url" style={{ fontSize: '0.75rem', opacity: 0.6, wordBreak: 'break-all' }}>
                            {t('modals.pairingCode', { code: serverStatus.token })}
                        </p>
                        <p className="server-url" style={{ fontSize: '0.75rem', opacity: 0.6, wordBreak: 'break-all' }}>
                            {t('modals.securityCode', { fingerprint: shortFingerprint(serverStatus.fingerprint) })}
                            <br />
                            {t('modals.securityCodeCheck')}
                        </p>
                        {!serverStatus.transcode_available && (
                            <p className="settings-hint" style={{ marginTop: '0.75rem', color: 'var(--warning-color, #d97706)' }}>
                                {t('modals.noTranscodeWarningPre')} <code>afconvert</code> {t('modals.noTranscodeWarningPost')}
                            </p>
                        )}
                        {serverActivity && (
                            <div className="settings-hint" style={{ textAlign: 'left', marginTop: '0.75rem' }}>
                                <div>{t('modals.pairedDevicesThisSession', { count: serverActivity.peers.length })}</div>
                                <div>{t('modals.lastManifestFetch', { when: ago(serverActivity.last_manifest_at) })}</div>
                                <div>{t('modals.lastStatsReceived', { when: ago(serverActivity.last_stats_at) })}</div>
                            </div>
                        )}
                        {prepareProgress && (
                            <p className="settings-hint" style={{ marginTop: '0.5rem' }}>
                                {t('modals.convertingForAndroid', { done: prepareProgress.done, total: prepareProgress.total })}
                            </p>
                        )}
                        <button className="modal-btn cancel" onClick={toggleServer} style={{ marginTop: '15px' }}>{t('modals.stopServer')}</button>
                    </div>
                ) : (
                    <div className="status-stopped">
                        <p>{t('modals.serverStopped')}</p>
                        <button className="modal-btn confirm" onClick={toggleServer}>{t('modals.startServer')}</button>
                    </div>
                )}
            </div>
        </>
    );
};

export const SyncModal: React.FC<SyncModalProps> = (props) => {
    const { t } = useTranslation();
    if (!props.isOpen) return null;
    return (
        <Portal><div className="modal-overlay" onClick={props.onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <ServerSide {...props} />
                <div className="modal-actions">
                    <button type="button" className="modal-btn cancel" onClick={props.onClose}>{t('modals.close')}</button>
                </div>
            </div>
        </div></Portal>
    );
};

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    folders: ScanFolder[];
    isScanning: boolean;
    scanProgress?: { done: number; total: number } | null;
    onCancelScan?: () => void;
    onAddFolder: () => void;
    onRemoveFolder: (folder: ScanFolder) => void;
    onRescan: () => void;
    onRescanFolder: (folder: ScanFolder) => void;
    onImportXml: () => void;
    onSetFolderKind: (folder: ScanFolder, kind: TrackKind) => void;
    showPathColumn: boolean;
    onTogglePathColumn: (next: boolean) => void;
    /** Play Podcast playlists in order even while shuffle is on. */
    podcastNoShuffle: boolean;
    onTogglePodcastNoShuffle: (next: boolean) => void;
    /** Desktop only: start the sync server automatically on launch. */
    serverAutostart: boolean;
    onToggleServerAutostart: (next: boolean) => void;
    /** Desktop only: target format/bitrate for on-sync transcoding. */
    transcodeFormat: TranscodeFormat;
    onChangeTranscodeFormat: (next: TranscodeFormat) => void;
    transcodeBitrate: number;
    onChangeTranscodeBitrate: (next: number) => void;
    /** Bulk "Fetch Missing Artist Images" (Deezer) — see App.tsx's handleFetchMissingArtistImages. */
    artistImageFetchProgress?: { done: number; total: number; found: number } | null;
    onFetchMissingArtistImages: () => void;
    onCancelFetchMissingArtistImages: () => void;
    /** UI language preference: "system" follows the OS/browser language. */
    language: LanguagePreference;
    onChangeLanguage: (next: LanguagePreference) => void;
    /** Export/import a single JSON snapshot of playlists/folders/settings
     *  (desktop only) — see useBackup.ts. Disabled while isScanning, same as
     *  the folder actions above (an import re-scans any new folders). */
    onExportBackup: () => void;
    onImportBackup: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    folders,
    isScanning,
    scanProgress = null,
    onCancelScan,
    onAddFolder,
    onRemoveFolder,
    onRescan,
    onRescanFolder,
    onImportXml,
    onSetFolderKind,
    showPathColumn,
    onTogglePathColumn,
    podcastNoShuffle,
    onTogglePodcastNoShuffle,
    serverAutostart,
    onToggleServerAutostart,
    transcodeFormat,
    onChangeTranscodeFormat,
    transcodeBitrate,
    onChangeTranscodeBitrate,
    artistImageFetchProgress = null,
    onFetchMissingArtistImages,
    onCancelFetchMissingArtistImages,
    language,
    onChangeLanguage,
    onExportBackup,
    onImportBackup,
}) => {
    const { t } = useTranslation();
    // Shown in the About section — read from the bundle so it never drifts from
    // the app's actual version.
    const [version, setVersion] = useState('');
    useEffect(() => {
        getVersion().then(setVersion).catch(() => {});
    }, []);

    // Third-party license notices (public/licenses.txt, generated by
    // scripts/generate-licenses.mjs) — fetched on demand so the ~1 MB text
    // isn't part of the JS bundle.
    const [licenses, setLicenses] = useState<string | null>(null);
    const toggleLicenses = () => {
        if (licenses !== null) {
            setLicenses(null);
            return;
        }
        fetch('/licenses.txt')
            .then(res => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
            .then(setLicenses)
            .catch(() => setLicenses(t('settings.licensesLoadFailed')));
    };

    type SettingsTab = 'folders' | 'library' | 'sync' | 'about';
    const [activeTab, setActiveTab] = useState<SettingsTab>('folders');

    if (!isOpen) return null;

    const tabs: { id: SettingsTab; label: string }[] = [
        { id: 'folders', label: t('settings.tabFolders') },
        { id: 'library', label: t('settings.tabLibrary') },
        { id: 'sync', label: t('settings.tabSync') },
        { id: 'about', label: t('settings.tabAbout') }
    ];

    return (
        <Portal><div className="modal-overlay" onClick={onClose}>
            <div className="modal-content settings-modal" onClick={e => e.stopPropagation()}>
                <h3>{t('settings.title')}</h3>

                <div className="settings-tabs" role="tablist">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            className={`settings-tab${activeTab === tab.id ? ' active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {activeTab === 'folders' && <>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.musicFolders')}</h4>
                    </div>
                    <p className="settings-hint">
                        {t('settings.musicFoldersHint')}
                    </p>

                    {isScanning && (
                        <div className="sync-progress">
                            <p className="settings-hint">
                                {scanProgress
                                    ? t('settings.scanningProgress', { done: scanProgress.done, total: scanProgress.total })
                                    : t('settings.scanning')}
                            </p>
                            {scanProgress && scanProgress.total > 0 && (
                                <div className="sync-progress-track">
                                    <div
                                        className="sync-progress-fill"
                                        style={{ width: `${Math.round(100 * scanProgress.done / scanProgress.total)}%` }}
                                    />
                                </div>
                            )}
                            {onCancelScan && (
                                <button type="button" className="modal-btn cancel" onClick={onCancelScan}>
                                    {t('settings.cancelScan')}
                                </button>
                            )}
                        </div>
                    )}

                    {folders.length > 0 ? (
                        <ul className="settings-folder-list">
                            {folders.map(folder => (
                                <li key={folder.path} className="settings-folder-item">
                                    <span className="settings-folder-path" title={folder.path}>
                                        {folder.path}
                                    </span>
                                    <select
                                        className="settings-folder-kind"
                                        aria-label={t('settings.kindFor', { path: folder.path })}
                                        value={folder.default_kind ?? 'music'}
                                        disabled={isScanning}
                                        onChange={e => onSetFolderKind(folder, e.target.value as TrackKind)}
                                    >
                                        <option value="music">{t('settings.kindMusic')}</option>
                                        <option value="podcast">{t('settings.kindPodcast')}</option>
                                        <option value="other">{t('settings.kindOther')}</option>
                                    </select>
                                    <button
                                        type="button"
                                        className="settings-folder-rescan"
                                        title={t('settings.rescanThisFolder')}
                                        aria-label={t('settings.rescanFolder', { path: folder.path })}
                                        disabled={isScanning}
                                        onClick={() => onRescanFolder(folder)}
                                    >
                                        <Icon name="repeat" size={15} />
                                    </button>
                                    <button
                                        type="button"
                                        className="settings-folder-remove"
                                        title={t('settings.removeFolder')}
                                        aria-label={t('settings.removeFolder')}
                                        disabled={isScanning}
                                        onClick={() => onRemoveFolder(folder)}
                                    >
                                        <Icon name="x" size={15} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="settings-empty">{t('settings.noFoldersYet')}</p>
                    )}

                    <div className="settings-folder-actions">
                        <button
                            type="button"
                            className="modal-btn cancel"
                            disabled={isScanning}
                            onClick={onAddFolder}
                        >
                            {t('settings.addFolder')}
                        </button>
                        <button
                            type="button"
                            className="modal-btn cancel"
                            disabled={isScanning || folders.length === 0}
                            onClick={onRescan}
                        >
                            {t('settings.rescanAll')}
                        </button>
                        <button
                            type="button"
                            className="modal-btn cancel"
                            disabled={isScanning}
                            onClick={onImportXml}
                        >
                            {t('settings.importItunesLibrary')}
                        </button>
                    </div>
                </div>
                </>}

                {activeTab === 'library' && <>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.language')}</h4>
                    </div>
                    <select
                        className="settings-folder-kind"
                        aria-label={t('settings.language')}
                        value={language}
                        onChange={e => onChangeLanguage(e.target.value as LanguagePreference)}
                    >
                        <option value="system">{t('settings.languageSystem')}</option>
                        <option value="en">{t('settings.languageEnglish')}</option>
                        <option value="ja">{t('settings.languageJapanese')}</option>
                    </select>
                </div>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.trackList')}</h4>
                    </div>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            checked={showPathColumn}
                            onChange={e => onTogglePathColumn(e.target.checked)}
                        />
                        {t('settings.showPathColumn')}
                    </label>
                </div>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.playback')}</h4>
                    </div>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            checked={podcastNoShuffle}
                            onChange={e => onTogglePodcastNoShuffle(e.target.checked)}
                        />
                        {t('settings.dontShufflePodcasts')}
                    </label>
                    <p className="settings-hint">
                        {t('settings.shuffleHint')}
                    </p>
                </div>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.artistImages')}</h4>
                    </div>
                    <p className="settings-hint">
                        {t('settings.artistImagesHint')}
                    </p>
                    {artistImageFetchProgress ? (
                        <div className="sync-progress">
                            <p className="settings-hint">
                                {t('settings.fetchingArtistImages', {
                                    done: artistImageFetchProgress.done,
                                    total: artistImageFetchProgress.total,
                                    found: artistImageFetchProgress.found,
                                })}
                            </p>
                            {artistImageFetchProgress.total > 0 && (
                                <div className="sync-progress-track">
                                    <div
                                        className="sync-progress-fill"
                                        style={{
                                            width: `${Math.round(100 * artistImageFetchProgress.done / artistImageFetchProgress.total)}%`
                                        }}
                                    />
                                </div>
                            )}
                            <button type="button" className="modal-btn cancel" onClick={onCancelFetchMissingArtistImages}>
                                {t('settings.cancel')}
                            </button>
                        </div>
                    ) : (
                        <button type="button" className="modal-btn cancel" onClick={onFetchMissingArtistImages}>
                            {t('settings.fetchMissingArtistImages')}
                        </button>
                    )}
                </div>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.backup')}</h4>
                    </div>
                    <p className="settings-hint">
                        {t('settings.backupHint')}
                    </p>
                    <div className="settings-folder-actions">
                        <button type="button" className="modal-btn cancel" disabled={isScanning} onClick={onExportBackup}>
                            {t('settings.exportBackup')}
                        </button>
                        <button type="button" className="modal-btn cancel" disabled={isScanning} onClick={onImportBackup}>
                            {t('settings.importBackup')}
                        </button>
                    </div>
                </div>
                </>}

                {activeTab === 'sync' && <>
                <div className="settings-section">
                    <div className="settings-section-header">
                        <h4>{t('settings.sync')}</h4>
                    </div>
                    <label className="settings-toggle">
                        <input
                            type="checkbox"
                            checked={serverAutostart}
                            onChange={e => onToggleServerAutostart(e.target.checked)}
                        />
                        {t('settings.startSyncServerAutomatically')}
                    </label>
                    <p className="settings-hint">
                        {t('settings.syncAutostartHint')}
                    </p>

                    <label style={{ display: 'block', marginTop: '0.75rem' }}>
                        {t('settings.convertUnsupportedFilesTo')}
                        <select
                            className="settings-folder-kind"
                            style={{ display: 'block', marginTop: '0.25rem' }}
                            value={transcodeFormat}
                            onChange={e => onChangeTranscodeFormat(e.target.value as TranscodeFormat)}
                        >
                            <option value="aac">{t('settings.formatAac')}</option>
                            <option value="flac">{t('settings.formatFlac')}</option>
                        </select>
                    </label>
                    {transcodeFormat === 'aac' && (
                        <label style={{ display: 'block', marginTop: '0.5rem' }}>
                            {t('settings.aacBitrate')}
                            <select
                                className="settings-folder-kind"
                                style={{ display: 'block', marginTop: '0.25rem' }}
                                value={transcodeBitrate}
                                onChange={e => onChangeTranscodeBitrate(Number(e.target.value))}
                            >
                                <option value={128000}>128 kbps</option>
                                <option value={192000}>192 kbps</option>
                                <option value={256000}>256 kbps</option>
                                <option value={320000}>320 kbps</option>
                            </select>
                        </label>
                    )}
                    <p className="settings-hint">
                        {t('settings.transcodeHint')}
                    </p>
                </div>
                </>}

                {activeTab === 'about' && <>
                <div className="settings-section">
                    <p><strong>{t('settings.appName')}</strong>{version && t('settings.versionLabel', { version })}</p>
                    <p className="settings-hint">{t('settings.aboutTagline')}</p>
                    <button type="button" className="modal-btn cancel" onClick={toggleLicenses}>
                        {t('settings.openSourceLicenses')}
                    </button>
                    {licenses !== null && (
                        <pre className="settings-licenses" tabIndex={0}>{licenses}</pre>
                    )}
                </div>
                </>}

                <div className="modal-actions">
                    <button type="button" className="modal-btn confirm" onClick={onClose}>{t('settings.close')}</button>
                </div>
            </div>
        </div></Portal>
    );
};
