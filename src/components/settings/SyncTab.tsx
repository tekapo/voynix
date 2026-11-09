import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TranscodeFormat } from '../../db';

export interface SyncTabProps {
    /** Desktop only: start the sync server automatically on launch. */
    serverAutostart: boolean;
    onToggleServerAutostart: (next: boolean) => void;
    /** Desktop only: let the paired phone sync over Bluetooth. */
    bluetoothSync: boolean;
    onToggleBluetoothSync: (next: boolean) => void;
    /** Desktop only: target format/bitrate for on-sync transcoding. */
    transcodeFormat: TranscodeFormat;
    onChangeTranscodeFormat: (next: TranscodeFormat) => void;
    transcodeBitrate: number;
    onChangeTranscodeBitrate: (next: number) => void;
}

export const SyncTab: React.FC<SyncTabProps> = ({
    serverAutostart,
    onToggleServerAutostart,
    bluetoothSync,
    onToggleBluetoothSync,
    transcodeFormat,
    onChangeTranscodeFormat,
    transcodeBitrate,
    onChangeTranscodeBitrate,
}) => {
    const { t } = useTranslation();
    return (
        <>
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

                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={bluetoothSync}
                        onChange={e => onToggleBluetoothSync(e.target.checked)}
                    />
                    {t('settings.syncOverBluetooth')}
                </label>
                <p className="settings-hint">
                    {t('settings.syncOverBluetoothHint')}
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
        </>
    );
};
