import React from 'react';
import { useTranslation } from 'react-i18next';

export interface LibraryTabProps {
    /** Scanning disables the backup buttons (an import re-scans any new folders). */
    isScanning: boolean;
    showPathColumn: boolean;
    onTogglePathColumn: (next: boolean) => void;
    /** Play Podcast playlists in order even while shuffle is on. */
    podcastNoShuffle: boolean;
    onTogglePodcastNoShuffle: (next: boolean) => void;
    /** Bulk "Fetch Missing Artist Images" (Deezer) — see useArtworkActions.ts. */
    artistImageFetchProgress?: { done: number; total: number; found: number } | null;
    onFetchMissingArtistImages: () => void;
    onCancelFetchMissingArtistImages: () => void;
    /** Export/import a single JSON snapshot of playlists/folders/settings
     *  (desktop only) — see useBackup.ts. Disabled while isScanning, same as
     *  the folder actions (an import re-scans any new folders). */
    onExportBackup: () => void;
    onImportBackup: () => void;
}

export const LibraryTab: React.FC<LibraryTabProps> = ({
    isScanning,
    showPathColumn,
    onTogglePathColumn,
    podcastNoShuffle,
    onTogglePodcastNoShuffle,
    artistImageFetchProgress = null,
    onFetchMissingArtistImages,
    onCancelFetchMissingArtistImages,
    onExportBackup,
    onImportBackup,
}) => {
    const { t } = useTranslation();
    return (
        <>
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
                        <button type="button" className="modal-btn secondary" onClick={onCancelFetchMissingArtistImages}>
                            {t('settings.cancel')}
                        </button>
                    </div>
                ) : (
                    <button type="button" className="modal-btn secondary" onClick={onFetchMissingArtistImages}>
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
                    <button type="button" className="modal-btn secondary" disabled={isScanning} onClick={onExportBackup}>
                        {t('settings.exportBackup')}
                    </button>
                    <button type="button" className="modal-btn secondary" disabled={isScanning} onClick={onImportBackup}>
                        {t('settings.importBackup')}
                    </button>
                </div>
            </div>
        </>
    );
};
