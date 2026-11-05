import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { ServerActivity, ServerStatus } from '../types';
import { pairingQrDataUri } from '../syncPairing';
import { Portal } from './Portal';

// Re-exported so existing `import { Portal } from './Modals'` sites keep working.
export { Portal };

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
    const dialogRef = useDialogFocus(isOpen);
    if (!isOpen) return null;
    return (
        <Portal><div className="modal-overlay">
            <div className="modal-content" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-playlist-title">
                <h3 id="create-playlist-title">{t('modals.createPlaylist')}</h3>
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
            <h3 id="sync-server-title">{t('modals.wifiSyncServer')}</h3>
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
    const dialogRef = useDialogFocus(props.isOpen);
    if (!props.isOpen) return null;
    return (
        <Portal><div className="modal-overlay" onClick={props.onClose}>
            <div className="modal-content" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="sync-server-title" onClick={e => e.stopPropagation()}>
                <ServerSide {...props} />
                <div className="modal-actions">
                    <button type="button" className="modal-btn cancel" onClick={props.onClose}>{t('modals.close')}</button>
                </div>
            </div>
        </div></Portal>
    );
};

export { SettingsModal, type SettingsTab } from './settings/SettingsModal';
