import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RemoteAccess } from '../hooks/useRemoteServer';

/**
 * Settings → Echo tab: the opt-in LAN server (remote.rs) an Alexa skill points
 * an Echo at to play your playlists. Off by default; it needs a DNS and
 * certificate setup on your network (docs/echo-lan.md).
 */
export const RemoteAccessSection: React.FC<{ remote: RemoteAccess }> = ({ remote }) => {
    const { t } = useTranslation();
    // The secret is only fetched when the user asks to see it, and cleared again
    // on hide — anyone holding it can make the server play your music.
    const [secret, setSecret] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [namesCopied, setNamesCopied] = useState(false);
    const [portDraft, setPortDraft] = useState(String(remote.port));
    const [certDraft, setCertDraft] = useState(remote.certPath);
    const [keyDraft, setKeyDraft] = useState(remote.keyPath);

    const toggleSecret = async () => {
        if (secret !== null) {
            setSecret(null);
            return;
        }
        setSecret(await remote.revealSecret());
    };

    // "Copied" only if the clipboard really took it: pasting a stale value into the
    // skill's config would break signatures with no hint why.
    const copyText = async (text: string, flash: (copied: boolean) => void) => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return;
        }
        flash(true);
        setTimeout(() => flash(false), 1500);
    };

    const copySecret = async () => {
        try {
            await copyText(secret ?? await remote.revealSecret(), setCopied);
        } catch {
            // The secret couldn't be read (a database error): nothing was copied, and nothing says it was.
        }
    };

    const regenerate = async () => {
        await remote.regenerateSecret();
        setSecret(null);
    };

    const copyPlaylistNames = () => copyText(remote.playlistSlotJson(), setNamesCopied);

    // Both files are applied together: a half-edited pair (the new certificate with
    // the old key) would fail to load and take a running server down.
    const pathsChanged = certDraft.trim() !== remote.certPath || keyDraft.trim() !== remote.keyPath;
    const applyPaths = () => remote.changeCertPaths(certDraft, keyDraft);

    const running = !!remote.status?.running;

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <h4>{t('remote.title')}</h4>
            </div>
            <p className="settings-hint">{t('remote.intro')}</p>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={remote.enabled}
                    onChange={e => remote.setEnabled(e.target.checked)}
                />
                {t('remote.enable')}
            </label>
            <p className="settings-hint">
                {running
                    ? t('remote.running', { port: remote.status?.port })
                    : t('remote.stopped')}
            </p>
            {running && remote.status && !remote.status.transcode_available && (
                <p className="settings-hint" style={{ color: 'var(--warning-color, #d97706)' }}>
                    {t('remote.noTranscode')}
                </p>
            )}

            <label style={{ display: 'block', marginTop: '0.75rem' }}>
                {t('remote.port')}
                <input
                    type="number"
                    min={1}
                    max={65535}
                    className="settings-folder-kind"
                    style={{ display: 'block', marginTop: '0.25rem', width: '8rem' }}
                    value={portDraft}
                    onChange={e => setPortDraft(e.target.value)}
                    onBlur={() => {
                        const n = Number(portDraft);
                        if (Number.isInteger(n) && n >= 1 && n <= 65535) {
                            if (n !== remote.port) remote.changePort(n);
                        } else {
                            setPortDraft(String(remote.port));
                        }
                    }}
                />
            </label>
            <p className="settings-hint">{t('remote.portHint')}</p>

            <label style={{ display: 'block', marginTop: '0.75rem' }}>
                {t('remote.certPath')}
                <input
                    type="text"
                    className="settings-folder-kind"
                    style={{ display: 'block', marginTop: '0.25rem', width: '100%' }}
                    placeholder="/Users/you/.lego/certificates/echo.example.org.crt"
                    value={certDraft}
                    onChange={e => setCertDraft(e.target.value)}
                />
            </label>
            <label style={{ display: 'block', marginTop: '0.75rem' }}>
                {t('remote.keyPath')}
                <input
                    type="text"
                    className="settings-folder-kind"
                    style={{ display: 'block', marginTop: '0.25rem', width: '100%' }}
                    placeholder="/Users/you/.lego/certificates/echo.example.org.key"
                    value={keyDraft}
                    onChange={e => setKeyDraft(e.target.value)}
                />
            </label>
            <button type="button" className="modal-btn cancel" onClick={applyPaths} disabled={!pathsChanged} style={{ marginTop: '0.5rem' }}>
                {t('remote.applyPaths')}
            </button>
            <p className="settings-hint">{t('remote.certHint')}</p>

            <div style={{ marginTop: '0.75rem' }}>
                <strong>{t('remote.secret')}</strong>
                <p className="settings-hint" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {secret ?? '••••••••••••••••'}
                </p>
                <button type="button" className="modal-btn cancel" onClick={toggleSecret}>
                    {secret !== null ? t('remote.hideSecret') : t('remote.showSecret')}
                </button>
                <button type="button" className="modal-btn cancel" onClick={copySecret} style={{ marginLeft: '0.5rem' }}>
                    {copied ? t('remote.copied') : t('remote.copySecret')}
                </button>
                <button type="button" className="modal-btn cancel" onClick={regenerate} style={{ marginLeft: '0.5rem' }}>
                    {t('remote.regenerate')}
                </button>
                <p className="settings-hint">{t('remote.regenerateHint')}</p>
            </div>

            <div style={{ marginTop: '0.75rem' }}>
                <strong>{t('remote.playlistNames')}</strong>
                <p className="settings-hint">{t('remote.playlistNamesHint')}</p>
                <button type="button" className="modal-btn cancel" onClick={copyPlaylistNames}>
                    {namesCopied ? t('remote.copied') : t('remote.copyPlaylistNames')}
                </button>
            </div>

            <p className="settings-hint">{t('remote.availability')}</p>
        </div>
    );
};
