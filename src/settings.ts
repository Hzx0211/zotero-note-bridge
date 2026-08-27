export type InterfaceLanguage = 'auto' | 'zh-CN' | 'en';

export interface ZoteroNoteBridgeSettings {
  schemaVersion: 1;
  referenceRoot: string;
  readingNotesRoot: string;
  conflictRoot: string;
  removedRoot: string;
  syncOnStartup: boolean;
  syncIntervalMinutes: number;
  includeOriginalAbstract: boolean;
  includeChineseTranslation: boolean;
  language: InterfaceLanguage;
  migrationCompleted: boolean;
}

export const DEFAULT_SETTINGS: ZoteroNoteBridgeSettings = {
  schemaVersion: 1,
  referenceRoot: 'References',
  readingNotesRoot: '04_Literature/notes',
  conflictRoot: 'References/_同步冲突/Zotero子笔记',
  removedRoot: 'References/_已移除',
  syncOnStartup: false,
  syncIntervalMinutes: 0,
  includeOriginalAbstract: true,
  includeChineseTranslation: true,
  language: 'auto',
  migrationCompleted: false
};

export function cleanVaultPath(value: string, fallback: string): string {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .trim();
  if (!normalized || normalized === '.' || normalized.split('/').some((part) => part === '..')) return fallback;
  return normalized;
}

export function normalizeSettings(value: Partial<ZoteroNoteBridgeSettings> | null | undefined): ZoteroNoteBridgeSettings {
  const merged = {...DEFAULT_SETTINGS, ...(value ?? {})};
  const interval = Number(merged.syncIntervalMinutes);
  return {
    ...merged,
    schemaVersion: 1,
    referenceRoot: cleanVaultPath(merged.referenceRoot, DEFAULT_SETTINGS.referenceRoot),
    readingNotesRoot: cleanVaultPath(merged.readingNotesRoot, DEFAULT_SETTINGS.readingNotesRoot),
    conflictRoot: cleanVaultPath(merged.conflictRoot, DEFAULT_SETTINGS.conflictRoot),
    removedRoot: cleanVaultPath(merged.removedRoot, DEFAULT_SETTINGS.removedRoot),
    syncIntervalMinutes: interval > 0 ? Math.max(15, Math.floor(interval)) : 0,
    language: ['auto', 'zh-CN', 'en'].includes(merged.language) ? merged.language : 'auto'
  };
}
