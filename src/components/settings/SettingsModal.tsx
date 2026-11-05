import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import type { RemoteAccess } from '../../hooks/useRemoteServer';
import { Portal } from '../Portal';
import { RemoteAccessSection } from '../RemoteAccessSection';
import { AboutTab, useAboutInfo, type AboutTabProps } from './AboutTab';
import { FoldersTab, type FoldersTabProps } from './FoldersTab';
import { GeneralTab, type GeneralTabProps } from './GeneralTab';
import { LibraryTab, type LibraryTabProps } from './LibraryTab';
import { SyncTab, type SyncTabProps } from './SyncTab';

export type SettingsTab = 'general' | 'folders' | 'library' | 'sync' | 'remote' | 'about';

type SettingsModalProps = {
    isOpen: boolean;
    /** Tab to switch to whenever the modal opens (e.g. 'about' from the app menu). */
    initialTab?: SettingsTab;
    onClose: () => void;
    /** Remote (Alexa) API — see useRemoteServer.ts. Omitted: the Remote tab is hidden. */
    remote?: RemoteAccess;
} & GeneralTabProps
  & FoldersTabProps
  & LibraryTabProps
  & SyncTabProps
  & Pick<AboutTabProps, 'libraryStats' | 'onShowWelcome'>;

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    initialTab,
    onClose,
    remote,
    libraryStats,
    onShowWelcome,
    ...tabProps
}) => {
    const { t } = useTranslation();
    const about = useAboutInfo();

    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general');
    useEffect(() => {
        if (isOpen && initialTab) setActiveTab(initialTab);
    }, [isOpen, initialTab]);

    const bodyRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // A new tab starts at the top instead of inheriting the previous tab's scroll.
        if (bodyRef.current) bodyRef.current.scrollTop = 0;
    }, [activeTab]);

    const dialogRef = useDialogFocus(isOpen);
    if (!isOpen) return null;

    const tabs: { id: SettingsTab; label: string }[] = [
        { id: 'general', label: t('settings.tabGeneral') },
        { id: 'folders', label: t('settings.tabFolders') },
        { id: 'library', label: t('settings.tabLibrary') },
        { id: 'sync', label: t('settings.tabSync') },
        ...(remote ? [{ id: 'remote' as const, label: t('settings.tabRemote') }] : []),
        { id: 'about', label: t('settings.tabAbout') }
    ];

    return (
        <Portal><div className="modal-overlay" onClick={onClose}>
            <div className="modal-content settings-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={e => e.stopPropagation()}>
                <h3 id="settings-title">{t('settings.title')}</h3>

                <div className="settings-layout">
                <div
                    className="settings-tabs"
                    role="tablist"
                    aria-orientation="vertical"
                    onKeyDown={e => {
                        const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
                        if (!dir) return;
                        e.preventDefault();
                        const i = tabs.findIndex(tb => tb.id === activeTab);
                        const next = tabs[(i + dir + tabs.length) % tabs.length];
                        setActiveTab(next.id);
                        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                        buttons[tabs.indexOf(next)]?.focus();
                    }}
                >
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            type="button"
                            role="tab"
                            aria-selected={activeTab === tab.id}
                            tabIndex={activeTab === tab.id ? 0 : -1}
                            className={`settings-tab${activeTab === tab.id ? ' active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="settings-body" role="tabpanel" ref={bodyRef}>
                    {activeTab === 'general' && <GeneralTab {...tabProps} />}
                    {activeTab === 'folders' && <FoldersTab {...tabProps} />}
                    {activeTab === 'library' && <LibraryTab {...tabProps} />}
                    {activeTab === 'sync' && <SyncTab {...tabProps} />}
                    {activeTab === 'remote' && remote && <RemoteAccessSection remote={remote} />}
                    {activeTab === 'about' && (
                        <AboutTab
                            libraryStats={libraryStats}
                            onClose={onClose}
                            onShowWelcome={onShowWelcome}
                            {...about}
                        />
                    )}
                </div>
                </div>

                <div className="modal-actions">
                    <button type="button" className="modal-btn confirm" onClick={onClose}>{t('settings.close')}</button>
                </div>
            </div>
        </div></Portal>
    );
};
