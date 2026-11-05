import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ScanFolder, TrackKind } from '../../types';
import { Icon } from '../Icon';

export interface FoldersTabProps {
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
}

export const FoldersTab: React.FC<FoldersTabProps> = ({
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
}) => {
    const { t } = useTranslation();
    return (
        <>
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
                            <button type="button" className="modal-btn secondary" onClick={onCancelScan}>
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
                        className="modal-btn secondary"
                        disabled={isScanning}
                        onClick={onAddFolder}
                    >
                        {t('settings.addFolder')}
                    </button>
                    <button
                        type="button"
                        className="modal-btn secondary"
                        disabled={isScanning || folders.length === 0}
                        onClick={onRescan}
                    >
                        {t('settings.rescanAll')}
                    </button>
                    <button
                        type="button"
                        className="modal-btn secondary"
                        disabled={isScanning}
                        onClick={onImportXml}
                    >
                        {t('settings.importItunesLibrary')}
                    </button>
                </div>
            </div>
        </>
    );
};
