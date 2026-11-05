import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LanguagePreference } from '../../i18n';
import type { ThemePreference } from '../../theme';
import type { SelfUpdate } from '../../hooks/useUpdater';

export interface GeneralTabProps {
    /** UI language preference: "system" follows the OS/browser language. */
    language: LanguagePreference;
    onChangeLanguage: (next: LanguagePreference) => void;
    /** Colour theme preference: "system" follows the OS appearance. */
    theme: ThemePreference;
    onChangeTheme: (next: ThemePreference) => void;
    /** Self-update (desktop only): the launch-time check preference and the manual check. */
    autoUpdateCheck: boolean;
    onToggleAutoUpdateCheck: (next: boolean) => void;
    updater: SelfUpdate;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
    language,
    onChangeLanguage,
    theme,
    onChangeTheme,
    autoUpdateCheck,
    onToggleAutoUpdateCheck,
    updater,
}) => {
    const { t } = useTranslation();
    return (
        <>
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
                    <h4>{t('settings.theme')}</h4>
                </div>
                <select
                    className="settings-folder-kind"
                    aria-label={t('settings.theme')}
                    value={theme}
                    onChange={e => onChangeTheme(e.target.value as ThemePreference)}
                >
                    <option value="system">{t('settings.themeSystem')}</option>
                    <option value="light">{t('settings.themeLight')}</option>
                    <option value="dark">{t('settings.themeDark')}</option>
                </select>
            </div>
            <div className="settings-section">
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={autoUpdateCheck}
                        onChange={e => onToggleAutoUpdateCheck(e.target.checked)}
                    />
                    {t('settings.autoUpdateCheck')}
                </label>
                <p className="settings-hint">{t('settings.autoUpdateHint')}</p>
                <button type="button" className="modal-btn secondary" onClick={updater.checkNow} disabled={updater.status.kind === 'checking'}>
                    {t('settings.checkForUpdates')}
                </button>
                {updater.status.kind === 'checking' && <p className="settings-hint">{t('settings.updateChecking')}</p>}
                {updater.status.kind === 'upToDate' && <p className="settings-hint">{t('settings.updateUpToDate')}</p>}
                {updater.status.kind === 'error' && <p className="settings-hint">{t('settings.updateFailed', { message: updater.status.message })}</p>}
            </div>
        </>
    );
};
