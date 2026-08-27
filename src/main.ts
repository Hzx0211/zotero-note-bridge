import {
  App,
  ButtonComponent,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath
} from 'obsidian';
import {createHash} from 'node:crypto';
import {
  NoteBlock,
  NoteMarker,
  blockAtOffset,
  extractReferenceKey,
  insertNoteBlock,
  isDirty,
  isReferenceCard,
  localDraftKey,
  normalizeNoteMarkdown,
  noteContentHash,
  parseNoteBlocks,
  reconcileDraftAction,
  renderNoteBlock,
  replaceBlock
} from './core';
import {markdownToZoteroHtml, zoteroHtmlToMarkdown} from './markdown';
import {ProtectedDraft, renderLibrary} from './renderer';
import {
  DEFAULT_SETTINGS,
  ZoteroNoteBridgeSettings,
  normalizeSettings
} from './settings';
import {
  ExistingLibraryFile,
  SyncOperation,
  SyncPlan,
  planLibrarySync
} from './sync-plan';
import {
  SecretStorageLike,
  ZoteroApiError,
  ZoteroItemData,
  ZoteroLibraryCache,
  ZoteroLibraryPull,
  ZoteroLocalApi
} from './zotero-api';

const LEGACY_CONFIG_PATH = '.obsidian/plugins/zotero-sync-client/data.json';
const LEGACY_STORE_PATH = '.obsidian/plugins/zotero-sync-client/store/%2Fapi%2Fusers%2F0.json';
const LEGACY_STATUS_PATH = '.obsidian/plugins/zotero-sync-client/store/%2Fapi%2Fusers%2F0.status.json';
const EMPTY_HASH = noteContentHash('');

interface StoredBlock {
  metadata: NoteMarker;
  content: string;
  filePath: string;
  updatedAt: string;
}

interface BridgeState {
  schemaVersion: 2;
  serverId: string;
  blockedServerId: string;
  drafts: Record<string, StoredBlock>;
  known: Record<string, StoredBlock>;
  conflictSignatures: Record<string, string>;
}

type ConflictChoice = 'local' | 'remote' | 'cancel';
type ScanMode = 'user-edit' | 'external-edit' | 'sync';

function defaultState(): BridgeState {
  return {
    schemaVersion: 2,
    serverId: '',
    blockedServerId: '',
    drafts: {},
    known: {},
    conflictSignatures: {}
  };
}

class ReportModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly report: string) {
    super(app);
  }

  onOpen(): void {
    this.containerEl.addClass('zotero-note-bridge-modal');
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('pre', {text: this.report, cls: 'znb-report'});
    const actions = this.contentEl.createDiv({cls: 'znb-actions'});
    new ButtonComponent(actions).setCta().setButtonText('关闭 / Close').onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(): string {
  return new Date().toISOString();
}

function filenameTimestamp(): string {
  return timestamp().replace(/[:.]/g, '-');
}

function keyForBlock(block: NoteBlock): string {
  return localDraftKey(block.metadata.parent, block.id);
}

function storedFromBlock(block: NoteBlock, filePath: string): StoredBlock {
  return {
    metadata: {...block.metadata},
    content: block.content,
    filePath,
    updatedAt: timestamp()
  };
}

function sameBaseline(left: NoteMarker, right: NoteMarker): boolean {
  return left.baseHash === right.baseHash;
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly message: string,
    private readonly confirmText = '确认写入 Zotero'
  ) {
    super(app);
  }

  wait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.containerEl.addClass('zotero-note-bridge-modal');
      this.titleEl.setText(this.titleText);
      this.contentEl.createEl('p', {text: this.message, cls: 'znb-message'});
      const actions = this.contentEl.createDiv({cls: 'znb-actions'});
      new ButtonComponent(actions).setButtonText('取消').onClick(() => {
        this.settled = true;
        resolve(false);
        this.close();
      });
      new ButtonComponent(actions).setCta().setButtonText(this.confirmText).onClick(() => {
        this.settled = true;
        resolve(true);
        this.close();
      });
      this.open();
      this.onClose = () => {
        this.contentEl.empty();
        if (!this.settled) resolve(false);
      };
    });
  }
}

class ConflictModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly noteKey: string,
    private readonly backupPath: string,
    private readonly deletedRemote = false
  ) {
    super(app);
  }

  wait(): Promise<ConflictChoice> {
    return new Promise((resolve) => {
      this.containerEl.addClass('zotero-note-bridge-modal');
      this.titleEl.setText(`Zotero 子笔记冲突 · ${this.noteKey}`);
      this.contentEl.createEl('p', {
        text: this.deletedRemote
          ? 'Zotero 中的原笔记已经不存在，本地仍有草稿。双方状态已先备份。'
          : 'Zotero 与 Obsidian 都发生了变化。双方内容已先备份，选择前不会覆盖任何一方。',
        cls: 'znb-message znb-warning'
      });
      this.contentEl.createEl('p', {text: `冲突备份：${this.backupPath}`, cls: 'znb-message'});
      const actions = this.contentEl.createDiv({cls: 'znb-actions'});
      new ButtonComponent(actions).setButtonText('取消').onClick(() => this.finish('cancel', resolve));
      new ButtonComponent(actions)
        .setButtonText(this.deletedRemote ? '仅保留本地草稿' : '保留 Zotero')
        .onClick(() => this.finish('remote', resolve));
      new ButtonComponent(actions)
        .setCta()
        .setButtonText(this.deletedRemote ? '在 Zotero 重新创建' : '保留 Obsidian')
        .onClick(() => this.finish('local', resolve));
      this.open();
      this.onClose = () => {
        this.contentEl.empty();
        if (!this.settled) resolve('cancel');
      };
    });
  }

  private finish(choice: ConflictChoice, resolve: (choice: ConflictChoice) => void): void {
    this.settled = true;
    resolve(choice);
    this.close();
  }
}

class ZoteroNoteBridgeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ZoteroNoteBridgePlugin) {
    super(app, plugin);
  }

  display(): void {
    const {containerEl} = this;
    const t = (zh: string, en: string) => this.plugin.ui(zh, en);
    containerEl.empty();
    containerEl.createEl('h2', {text: 'Zotero Note Bridge'});
    const pathSetting = (name: string, description: string, key: 'referenceRoot' | 'readingNotesRoot' | 'conflictRoot' | 'removedRoot') => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(description)
        .addText((text) => text.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.plugin.savePluginSettings();
        }));
    };
    pathSetting(t('文献目录', 'Reference root'), t('Zotero 文献卡和分类索引的根目录。', 'Root directory for Zotero reference cards and collection indexes.'), 'referenceRoot');
    pathSetting(t('阅读笔记目录', 'Reading notes'), t('个人阅读笔记链接指向的目录。', 'Directory targeted by personal reading-note links.'), 'readingNotesRoot');
    pathSetting(t('冲突目录', 'Conflicts'), t('保存 Zotero 与 Obsidian 双方内容的冲突备份。', 'Stores both Zotero and Obsidian conflict copies.'), 'conflictRoot');
    pathSetting(t('隔离目录', 'Removed items'), t('Zotero 中删除的生成文件会移入此目录，不会永久删除。', 'Generated files removed from Zotero are moved here, never permanently deleted.'), 'removedRoot');
    new Setting(containerEl)
      .setName(t('启动时同步', 'Sync on startup'))
      .setDesc(t('新安装默认关闭；完成迁移后可安全开启。', 'Disabled on new installations; safe to enable after migration.'))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
        this.plugin.settings.syncOnStartup = value;
        await this.plugin.savePluginSettings();
      }));
    new Setting(containerEl)
      .setName(t('定时同步（分钟）', 'Sync interval (minutes)'))
      .setDesc(t('0 表示关闭；非零值最低为 15 分钟。', 'Use 0 to disable; the minimum enabled interval is 15 minutes.'))
      .addText((text) => text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
        this.plugin.settings.syncIntervalMinutes = Number(value) || 0;
        await this.plugin.savePluginSettings();
        this.plugin.configureInterval();
      }));
    new Setting(containerEl)
      .setName(t('显示原文摘要', 'Show original abstract'))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeOriginalAbstract).onChange(async (value) => {
        this.plugin.settings.includeOriginalAbstract = value;
        await this.plugin.savePluginSettings();
      }));
    new Setting(containerEl)
      .setName(t('显示中文翻译字段', 'Show Chinese translation fields'))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeChineseTranslation).onChange(async (value) => {
        this.plugin.settings.includeChineseTranslation = value;
        await this.plugin.savePluginSettings();
      }));
    new Setting(containerEl)
      .setName(t('界面语言', 'Interface language'))
      .addDropdown((dropdown) => dropdown
        .addOption('auto', 'Auto')
        .addOption('zh-CN', '简体中文')
        .addOption('en', 'English')
        .setValue(this.plugin.settings.language)
        .onChange(async (value) => {
          this.plugin.settings.language = value as ZoteroNoteBridgeSettings['language'];
          await this.plugin.savePluginSettings();
          this.display();
        }));
  }
}

export default class ZoteroNoteBridgePlugin extends Plugin {
  settings: ZoteroNoteBridgeSettings = {...DEFAULT_SETTINGS};
  private state: BridgeState = defaultState();
  private libraryCache: ZoteroLibraryCache | null = null;
  private api!: ZoteroLocalApi;
  private mutatingFiles = new Set<string>();
  private userInputFiles = new Map<string, number>();
  private syncing = false;
  private savingState: Promise<void> = Promise.resolve();
  private intervalId: number | null = null;

  ui(zh: string, en: string): string {
    if (this.settings.language === 'zh-CN') return zh;
    if (this.settings.language === 'en') return en;
    return navigator.language.toLowerCase().startsWith('zh') ? zh : en;
  }

  async onload(): Promise<void> {
    await this.loadPluginSettings();
    await this.loadBridgeState();
    await this.loadLibraryCache();
    const secretStorage = (this.app as App & {secretStorage?: SecretStorageLike}).secretStorage;
    if (!secretStorage?.getSecret || !secretStorage?.setSecret) {
      new Notice('Zotero Note Bridge：当前 Obsidian 不提供 SecretStorage，已停止加载以避免泄露 API Key。', 0);
      return;
    }
    this.api = new ZoteroLocalApi(secretStorage);

    this.addSettingTab(new ZoteroNoteBridgeSettingTab(this.app, this));
    this.registerCommands();
    this.addRibbonIcon('refresh-cw', 'Zotero：同步文献与子笔记', () => void this.safeSync(true));
    this.registerDomEvent(document, 'beforeinput', () => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md' || !this.inReferenceRoot(file.path)) return;
      this.userInputFiles.set(file.path, Date.now());
    }, true);
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile) || file.extension !== 'md' || !this.inReferenceRoot(file.path)) return;
      if (this.mutatingFiles.has(file.path) || this.syncing) return;
      const inputAt = this.userInputFiles.get(file.path) ?? 0;
      this.userInputFiles.delete(file.path);
      const mode: ScanMode = Date.now() - inputAt < 10000 ? 'user-edit' : 'external-edit';
      void this.scanFile(file, mode, true).catch((error) => this.showError('草稿保存失败', error));
    }));

    this.configureInterval();
    if (this.settings.syncOnStartup && this.settings.migrationCompleted) {
      const startSafeSync = () => window.setTimeout(() => void this.safeSync(false), 750);
      if ((this.app.workspace as unknown as {layoutReady?: boolean}).layoutReady) startSafeSync();
      else this.app.workspace.onLayoutReady(startSafeSync);
    }
  }

  onunload(): void {
    if (this.intervalId != null) window.clearInterval(this.intervalId);
  }

  private pluginPath(name: string): string {
    const root = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
    return normalizePath(`${root}/${name}`);
  }

  private inReferenceRoot(path: string): boolean {
    const root = normalizePath(this.settings.referenceRoot);
    return path === root || path.startsWith(`${root}/`);
  }

  private async loadPluginSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData() as Partial<ZoteroNoteBridgeSettings> | null);
  }

  async savePluginSettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  configureInterval(): void {
    if (this.intervalId != null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const minutes = normalizeSettings(this.settings).syncIntervalMinutes;
    if (minutes > 0) {
      this.intervalId = window.setInterval(() => void this.safeSync(false), minutes * 60 * 1000);
      this.registerInterval(this.intervalId);
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'push-current-child-note',
      name: this.ui('Zotero 子笔记：推送光标所在笔记', 'Zotero child notes: Push note at cursor'),
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!file || !this.inReferenceRoot(file.path)) return false;
        const content = editor.getValue();
        if (!isReferenceCard(content)) return false;
        const offset = editor.posToOffset(editor.getCursor());
        const block = blockAtOffset(parseNoteBlocks(content), offset);
        if (!checking) {
          if (block) {
            void this.pushSelectedBlocks(file, [block.id]);
          } else {
            const dirty = parseNoteBlocks(content).filter(isDirty);
            if (dirty.length === 1) {
              new Notice(`光标不在子笔记区块内；已自动选择本页唯一改动 ${dirty[0]!.id}。`);
              void this.pushSelectedBlocks(file, [dirty[0]!.id]);
            } else if (!dirty.length) {
              new Notice('当前文献卡没有需要推送的子笔记改动。');
            } else {
              new Notice('本页有多条改动：请把光标放入目标子笔记，或运行“推送本页全部改动”。', 8000);
            }
          }
        }
        return true;
      }
    });
    this.addCommand({
      id: 'discard-current-child-note-draft',
      name: this.ui('Zotero 子笔记：放弃光标所在未推送改动', 'Zotero child notes: Discard draft at cursor'),
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!file || !this.inReferenceRoot(file.path)) return false;
        const content = editor.getValue();
        const offset = editor.posToOffset(editor.getCursor());
        const block = blockAtOffset(parseNoteBlocks(content), offset);
        if (!block || !isDirty(block)) return false;
        if (!checking) void this.discardLocalDraft(file, block.id);
        return true;
      }
    });
    this.addCommand({
      id: 'push-page-child-notes',
      name: this.ui('Zotero 子笔记：推送本页全部改动', 'Zotero child notes: Push all changes on this page'),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.inReferenceRoot(file.path)) return false;
        if (!checking) void this.pushPage(file);
        return true;
      }
    });
    this.addCommand({
      id: 'create-child-note',
      name: this.ui('Zotero 子笔记：在当前文献中新建笔记', 'Zotero child notes: Create in current reference'),
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.inReferenceRoot(file.path)) return false;
        if (!checking) void this.createLocalNote(file);
        return true;
      }
    });
    this.addCommand({
      id: 'safe-sync',
      name: this.ui('Zotero：立即同步', 'Zotero: Sync now'),
      callback: () => void this.safeSync(true)
    });
    this.addCommand({
      id: 'preview-sync',
      name: this.ui('Zotero：预览同步', 'Zotero: Preview sync'),
      callback: () => void this.previewSync(false)
    });
    this.addCommand({
      id: 'analyze-migration',
      name: this.ui('Zotero：分析旧版迁移', 'Zotero: Analyze legacy migration'),
      callback: () => void this.previewSync(true)
    });
    this.addCommand({
      id: 'apply-migration',
      name: this.ui('Zotero：执行旧版迁移', 'Zotero: Apply legacy migration'),
      callback: () => void this.applyMigration()
    });
    this.addCommand({
      id: 'reauthorize',
      name: this.ui('Zotero 子笔记：重新授权写入', 'Zotero child notes: Reauthorize writes'),
      callback: () => void this.reauthorize()
    });
  }

  private showError(context: string, error: unknown): void {
    new Notice(`Zotero Note Bridge · ${context}：${errorMessage(error)}`, 10000);
  }

  private async loadBridgeState(): Promise<void> {
    try {
      const path = this.pluginPath('state.json');
      if (!await this.app.vault.adapter.exists(path)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as Partial<BridgeState>;
      this.state = {
        ...defaultState(),
        ...parsed,
        schemaVersion: 2,
        drafts: parsed.drafts ?? {},
        known: parsed.known ?? {},
        conflictSignatures: parsed.conflictSignatures ?? {}
      };
    } catch {
      this.state = defaultState();
      new Notice('Zotero Note Bridge：私有状态文件无法读取，已用空状态启动；Vault 正文未受影响。', 10000);
    }
  }

  private async persistState(): Promise<void> {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    this.savingState = this.savingState.then(() => this.app.vault.adapter.write(this.pluginPath('state.json'), serialized));
    await this.savingState;
  }

  private async loadLibraryCache(): Promise<void> {
    const path = this.pluginPath('library-state.json');
    try {
      if (!await this.app.vault.adapter.exists(path)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as ZoteroLibraryCache;
      if (parsed.schemaVersion === 1 && parsed.items && parsed.collections) this.libraryCache = parsed;
    } catch {
      this.libraryCache = null;
      new Notice('Zotero Note Bridge：文献缓存无法读取，下次同步将安全地完整重建。', 8000);
    }
  }

  private async persistLibraryCache(cache: ZoteroLibraryCache): Promise<void> {
    await this.app.vault.adapter.write(this.pluginPath('library-state.json'), `${JSON.stringify(cache)}\n`);
    this.libraryCache = cache;
  }

  private async prepareServer(manualServerChange: boolean, persistBinding = true): Promise<string> {
    const info = await this.api.getServerInfo();
    if (Number(info.version.split('.')[0]) < 10) throw new Error(`需要 Zotero 10，当前为 ${info.version}`);
    this.api.setExpectedServer(info.serverId);

    if (!this.state.serverId) {
      if (!persistBinding) return info.serverId;
      this.state.serverId = info.serverId;
      this.state.blockedServerId = '';
      await this.persistState();
      return info.serverId;
    }
    if (this.state.serverId === info.serverId && !this.state.blockedServerId) return info.serverId;

    if (!persistBinding) {
      throw new Error('检测到不同的 Zotero 数据库；只读预览已停止。请执行“重新授权写入”或一次手动同步来明确重建基线。');
    }

    this.state.blockedServerId = info.serverId;
    await this.persistState();
    if (!manualServerChange) {
      throw new Error('检测到不同的 Zotero 数据库，已阻止写入。请手动执行“Zotero：安全同步文献与子笔记”重建基线。');
    }
    const approved = await new ConfirmModal(
      this.app,
      'Zotero 数据库已更换',
      'Server ID 与现有基线不同。继续会保留本地草稿、清除旧版本基线并从当前 Zotero 完整拉取；不会自动写回子笔记。',
      '重建安全基线'
    ).wait();
    if (!approved) throw new Error('已取消重建基线');

    this.state.serverId = info.serverId;
    this.state.blockedServerId = '';
    this.state.known = {};
    this.state.conflictSignatures = {};
    this.libraryCache = null;
    const cachePath = this.pluginPath('library-state.json');
    if (await this.app.vault.adapter.exists(cachePath)) await this.app.vault.adapter.remove(cachePath);
    await this.persistState();
    return info.serverId;
  }

  private async reauthorize(): Promise<void> {
    try {
      await this.prepareServer(false);
      await this.api.clearAuthorization();
      await this.api.authorize();
      new Notice('Zotero Note Bridge：写入授权已更新。');
    } catch (error) {
      this.showError('重新授权失败', error);
    }
  }

  private async referenceFiles(): Promise<TFile[]> {
    const files: TFile[] = [];
    const removedPrefix = `${normalizePath(this.settings.removedRoot)}/`;
    const conflictPrefix = `${normalizePath(this.settings.conflictRoot)}/`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.inReferenceRoot(file.path) || file.path.startsWith(removedPrefix) || file.path.startsWith(conflictPrefix)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      if (isReferenceCard(markdown)) files.push(file);
    }
    return files;
  }

  private async scanAllReferences(mode: ScanMode): Promise<{references: number; drafts: number; restored: number}> {
    let references = 0;
    let restored = 0;
    for (const file of await this.referenceFiles()) {
      const result = await this.scanFile(file, mode, false);
      if (result.reference) references += 1;
      restored += result.restored;
    }
    await this.persistState();
    return {references, drafts: Object.keys(this.state.drafts).length, restored};
  }

  private async scanFile(
    file: TFile,
    mode: ScanMode,
    persist: boolean
  ): Promise<{reference: boolean; restored: number}> {
    let markdown = await this.app.vault.read(file);
    if (!isReferenceCard(markdown)) return {reference: false, restored: 0};
    const parent = extractReferenceKey(markdown);
    let restored = 0;

    for (const block of parseNoteBlocks(markdown)) {
      if (block.metadata.parent !== parent) continue;
      if (isDirty(block)) this.state.drafts[keyForBlock(block)] = storedFromBlock(block, file.path);
    }

    for (const [draftKey, draft] of Object.entries(this.state.drafts)) {
      if (draft.metadata.parent !== parent) continue;
      const current = parseNoteBlocks(markdown).find((block) => block.id === (draft.metadata.key || draft.metadata.localId));
      if (!current) {
        markdown = insertNoteBlock(markdown, renderNoteBlock(draft.metadata, draft.content));
        restored += 1;
        continue;
      }
      const action = reconcileDraftAction(current, draft, mode === 'user-edit');
      if (action === 'capture-current') {
        this.state.drafts[draftKey] = storedFromBlock(current, file.path);
        continue;
      }
      if (action === 'discard-draft') {
        delete this.state.drafts[draftKey];
        continue;
      }

      let metadata = draft.metadata;
      if (action === 'restore-draft') {
        metadata = {
          ...draft.metadata,
          key: current.metadata.key ?? draft.metadata.key,
          version: current.metadata.version,
          baseHash: current.metadata.baseHash
        };
      } else {
        const signature = `${draftKey}:${draft.metadata.version}:${current.metadata.version}:${draft.metadata.baseHash}:${current.metadata.baseHash}`;
        if (!this.state.conflictSignatures[signature]) {
          const backupPath = await this.writeConflictBackup(draft, current.metadata, current.content, '安全同步检测到双方变化');
          this.state.conflictSignatures[signature] = backupPath;
        }
      }
      markdown = replaceBlock(markdown, current, metadata, draft.content);
      this.state.drafts[localDraftKey(parent, metadata.key || metadata.localId || current.id)] = {
        ...draft,
        metadata,
        filePath: file.path,
        updatedAt: timestamp()
      };
      if (draftKey !== localDraftKey(parent, metadata.key || metadata.localId || current.id)) delete this.state.drafts[draftKey];
      restored += 1;
    }

    if (mode !== 'sync') {
      const currentIds = new Set(parseNoteBlocks(markdown).map((block) => localDraftKey(parent, block.id)));
      for (const [knownKey, known] of Object.entries(this.state.known)) {
        if (
          known.metadata.parent !== parent ||
          known.filePath !== file.path ||
          currentIds.has(knownKey) ||
          this.state.drafts[knownKey]
        ) continue;
        markdown = insertNoteBlock(markdown, renderNoteBlock(known.metadata, known.content));
        restored += 1;
        new Notice(`Zotero Note Bridge：不支持通过删除区块来删除 Zotero 笔记，已恢复 ${known.metadata.key ?? known.metadata.localId}。`);
      }
    }

    const existing = await this.app.vault.read(file);
    if (markdown !== existing) await this.writeFile(file, markdown);

    const finalBlocks = parseNoteBlocks(markdown).filter((block) => block.metadata.parent === parent);
    if (mode === 'sync') {
      for (const key of Object.keys(this.state.known)) {
        if (this.state.known[key]?.metadata.parent === parent && !this.state.drafts[key]) delete this.state.known[key];
      }
    }
    for (const block of finalBlocks) this.state.known[keyForBlock(block)] = storedFromBlock(block, file.path);
    if (persist) await this.persistState();
    return {reference: true, restored};
  }

  private async writeFile(file: TFile, markdown: string): Promise<void> {
    this.mutatingFiles.add(file.path);
    try {
      await this.app.vault.modify(file, markdown);
    } finally {
      window.setTimeout(() => this.mutatingFiles.delete(file.path), 250);
    }
  }

  private protectedDrafts(existing: readonly ExistingLibraryFile[] = []): Record<string, ProtectedDraft> {
    const drafts: Record<string, ProtectedDraft> = Object.fromEntries(Object.entries(this.state.drafts).map(([key, value]) => [key, {
      metadata: value.metadata,
      content: value.content
    }]));
    for (const file of existing) {
      if (file.kind !== 'reference' || file.removed) continue;
      const parent = extractReferenceKey(file.content);
      for (const block of parseNoteBlocks(file.content)) {
        if (block.metadata.parent === parent && isDirty(block)) {
          drafts[localDraftKey(parent, block.id)] = {metadata: block.metadata, content: block.content};
        }
      }
    }
    return drafts;
  }

  private async existingLibraryFiles(): Promise<ExistingLibraryFile[]> {
    const result: ExistingLibraryFile[] = [];
    const owners = new Map<string, string>();
    const removedRoot = normalizePath(this.settings.removedRoot);
    const removedPrefix = `${removedRoot}/`;
    const conflictPrefix = `${normalizePath(this.settings.conflictRoot)}/`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const inRemoved = file.path === removedRoot || file.path.startsWith(removedPrefix);
      if ((!this.inReferenceRoot(file.path) && !inRemoved) || file.path.startsWith(conflictPrefix)) continue;
      const content = await this.app.vault.cachedRead(file);
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
      const type = frontmatter.match(/^type:\s*([^\n]+)\s*$/m)?.[1]?.trim();
      if (type !== 'zotero-reference' && type !== 'zotero-collection' && type !== 'zotero-unclassified-index') continue;
      const key = type === 'zotero-unclassified-index' ? 'ZNBUNCL1' : extractReferenceKey(content);
      if (!key) continue;
      const owner = owners.get(key);
      if (owner) throw new Error(`发现重复 Zotero Key ${key}：${owner} / ${file.path}`);
      owners.set(key, file.path);
      result.push({
        key,
        kind: type === 'zotero-reference' ? 'reference' : 'collection',
        path: file.path,
        content,
        removed: inRemoved
      });
    }
    return result;
  }

  private async pullAndPlan(): Promise<{pull: ZoteroLibraryPull; plan: SyncPlan; existing: ExistingLibraryFile[]}> {
    const pull = await this.api.pullLibrary(this.libraryCache);
    const existing = await this.existingLibraryFiles();
    const rendered = renderLibrary(pull.cache, {
      settings: this.settings,
      drafts: this.protectedDrafts(existing),
      noteHtmlToMarkdown: zoteroHtmlToMarkdown
    });
    const plan = planLibrarySync(
      rendered,
      existing,
      normalizePath(this.settings.referenceRoot),
      normalizePath(this.settings.removedRoot)
    );
    return {pull, plan, existing};
  }

  private async legacyCacheSummary(): Promise<string> {
    if (!await this.app.vault.adapter.exists(LEGACY_STORE_PATH)) return '未找到（不会影响新插件）';
    try {
      const parsed = JSON.parse(await this.app.vault.adapter.read(LEGACY_STORE_PATH)) as Record<string, unknown>;
      const itemCount = Array.isArray(parsed.items) ? parsed.items.length : 0;
      const collectionCount = Array.isArray(parsed.collections) ? parsed.collections.length : 0;
      return `version ${Number(parsed.version) || 0}，对象 ${itemCount}，分类 ${collectionCount}（只读对照）`;
    } catch {
      return '存在但格式无法识别（不会改写）';
    }
  }

  private async planReport(
    pull: ZoteroLibraryPull,
    plan: SyncPlan,
    existing: readonly ExistingLibraryFile[],
    migration: boolean
  ): Promise<string> {
    const referenceFiles = existing.filter((file) => file.kind === 'reference' && !file.removed);
    const collectionFiles = existing.filter((file) => file.kind === 'collection' && !file.removed);
    const markerCount = referenceFiles.reduce((total, file) => total + parseNoteBlocks(file.content).length, 0);
    const managedCount = existing.filter((file) => file.content.includes('<!-- znb-managed:start -->')).length;
    const conflictRoot = normalizePath(this.settings.conflictRoot);
    const conflictCount = this.app.vault.getMarkdownFiles().filter((file) =>
      file.path === conflictRoot || file.path.startsWith(`${conflictRoot}/`)
    ).length;
    const lines = [
      migration ? '迁移分析（只读）' : '同步预览（只读）',
      '',
      `Zotero library version: ${pull.cache.libraryVersion}`,
      `同步模式: ${pull.full ? '完整快照' : '增量更新'}`,
      `Zotero 对象: ${Object.keys(pull.cache.items).length}`,
      `Zotero 分类: ${Object.keys(pull.cache.collections).length}`,
      `新增文件: ${plan.creates}`,
      `更新文件: ${plan.updates}`,
      `移动文件: ${plan.moves}`,
      `移入隔离区: ${plan.quarantines}`,
      `无需变化: ${plan.unchanged}`,
      `现有文献卡 / 分类索引: ${referenceFiles.length} / ${collectionFiles.length}`,
      `现有子笔记 marker: ${markerCount}`,
      `已有 managed marker 文件: ${managedCount}`,
      `受保护草稿: ${Object.keys(this.state.drafts).length}`,
      `冲突文件 / 已记录冲突: ${conflictCount} / ${Object.keys(this.state.conflictSignatures).length}`,
      '',
      '预览没有修改 Vault、Zotero 或同步缓存。'
    ];
    if (migration) lines.splice(3, 0, `旧 Zotero Sync 缓存: ${await this.legacyCacheSummary()}`);
    if (plan.operations.length) {
      lines.push('', '文件差异：');
      for (const operation of plan.operations) {
        const source = operation.fromPath ? `${operation.fromPath} → ` : '';
        lines.push(`- ${operation.kind.toUpperCase()} · ${operation.key} · ${source}${operation.toPath}`);
      }
    }
    return lines.join('\n');
  }

  private async previewSync(migration: boolean): Promise<void> {
    try {
      await this.prepareServer(false, false);
      const {pull, plan, existing} = await this.pullAndPlan();
      const report = await this.planReport(pull, plan, existing, migration);
      new ReportModal(this.app, migration ? 'Zotero 迁移分析' : 'Zotero 同步预览', report).open();
    } catch (error) {
      this.showError(migration ? '迁移分析失败' : '同步预览失败', error);
    }
  }

  private async ensureAdapterFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) await this.app.vault.adapter.mkdir(current);
    }
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private async backupPlan(plan: SyncPlan): Promise<string> {
    const root = this.pluginPath(`backups/${filenameTimestamp()}`);
    const manifest: Array<{source: string; backup: string; sha256: string}> = [];
    for (const operation of plan.operations) {
      if (!operation.fromPath || !await this.app.vault.adapter.exists(operation.fromPath)) continue;
      const content = await this.app.vault.adapter.read(operation.fromPath);
      const target = normalizePath(`${root}/files/${operation.fromPath}`);
      await this.ensureAdapterFolder(target.slice(0, target.lastIndexOf('/')));
      await this.app.vault.adapter.write(target, content);
      manifest.push({source: operation.fromPath, backup: target, sha256: this.sha256(content)});
    }
    for (const legacy of [LEGACY_CONFIG_PATH, LEGACY_STORE_PATH, LEGACY_STATUS_PATH, this.pluginPath('state.json')]) {
      if (!await this.app.vault.adapter.exists(legacy)) continue;
      const content = await this.app.vault.adapter.read(legacy);
      const name = legacy.split('/').pop() || 'legacy.json';
      const target = normalizePath(`${root}/legacy/${name}`);
      await this.ensureAdapterFolder(target.slice(0, target.lastIndexOf('/')));
      await this.app.vault.adapter.write(target, content);
      manifest.push({source: legacy, backup: target, sha256: this.sha256(content)});
    }
    await this.app.vault.adapter.write(normalizePath(`${root}/manifest.json`), `${JSON.stringify({createdAt: timestamp(), files: manifest}, null, 2)}\n`);
    return root;
  }

  private async uniqueTarget(path: string, key: string): Promise<string> {
    if (!await this.app.vault.adapter.exists(path)) return path;
    const dot = path.toLowerCase().endsWith('.md') ? path.length - 3 : path.length;
    return `${path.slice(0, dot)} [${key}]${path.slice(dot)}`;
  }

  private async applyOperation(operation: SyncOperation): Promise<void> {
    let target = normalizePath(operation.toPath);
    if (operation.kind === 'quarantine') target = await this.uniqueTarget(target, operation.key);
    await this.ensureFolder(target.slice(0, target.lastIndexOf('/')));
    if (operation.kind === 'create') {
      if (await this.app.vault.adapter.exists(target)) throw new Error(`目标文件已存在：${target}`);
      this.mutatingFiles.add(target);
      await this.app.vault.create(target, operation.content);
      window.setTimeout(() => this.mutatingFiles.delete(target), 250);
      return;
    }
    const source = operation.fromPath ? this.app.vault.getAbstractFileByPath(normalizePath(operation.fromPath)) : null;
    if (!(source instanceof TFile)) throw new Error(`找不到待同步文件：${operation.fromPath}`);
    let file = source;
    if (operation.kind === 'move' || operation.kind === 'quarantine') {
      if (await this.app.vault.adapter.exists(target)) throw new Error(`移动目标已存在：${target}`);
      this.mutatingFiles.add(source.path);
      this.mutatingFiles.add(target);
      await this.app.fileManager.renameFile(source, target);
      const moved = this.app.vault.getAbstractFileByPath(target);
      if (!(moved instanceof TFile)) throw new Error(`移动后无法找到文件：${target}`);
      file = moved;
    }
    await this.writeFile(file, operation.content);
    window.setTimeout(() => {
      this.mutatingFiles.delete(source.path);
      this.mutatingFiles.delete(target);
    }, 250);
  }

  private async applyPlan(plan: SyncPlan): Promise<void> {
    const operations = plan.operations.map((operation) => ({...operation}));
    const stagingRoot = normalizePath(`${this.settings.conflictRoot}/_同步暂存/${filenameTimestamp()}`);
    for (const operation of operations) {
      if ((operation.kind !== 'move' && operation.kind !== 'quarantine') || !operation.fromPath) continue;
      const source = this.app.vault.getAbstractFileByPath(normalizePath(operation.fromPath));
      if (!(source instanceof TFile)) throw new Error(`找不到待暂存文件：${operation.fromPath}`);
      const stagedPath = normalizePath(`${stagingRoot}/${operation.fileKind}-${operation.key}.md`);
      await this.ensureFolder(stagedPath.slice(0, stagedPath.lastIndexOf('/')));
      if (await this.app.vault.adapter.exists(stagedPath)) throw new Error(`同步暂存目标已存在：${stagedPath}`);
      this.mutatingFiles.add(source.path);
      this.mutatingFiles.add(stagedPath);
      await this.app.fileManager.renameFile(source, stagedPath);
      operation.fromPath = stagedPath;
    }
    for (const operation of operations) await this.applyOperation(operation);
  }

  private async disableLegacyPlugin(): Promise<void> {
    const path = '.obsidian/community-plugins.json';
    if (!await this.app.vault.adapter.exists(path)) return;
    const enabled = JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
    if (!Array.isArray(enabled) || !enabled.includes('zotero-sync-client')) return;
    const next = enabled.filter((id) => id !== 'zotero-sync-client');
    await this.app.vault.adapter.write(path, `${JSON.stringify(next, null, 2)}\n`);
  }

  private async saveOpenEditors(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof MarkdownView && typeof (view as MarkdownView & {save?: () => Promise<void>}).save === 'function') {
        await (view as MarkdownView & {save: () => Promise<void>}).save();
      }
    }
  }

  private async safeSync(manual: boolean): Promise<void> {
    if (this.syncing) {
      if (manual) new Notice('Zotero Note Bridge：安全同步已在运行。');
      return;
    }
    this.syncing = true;
    try {
      await this.prepareServer(manual);
      await this.saveOpenEditors();
      const before = await this.scanAllReferences('external-edit');
      const {pull, plan} = await this.pullAndPlan();
      await this.applyPlan(plan);
      await this.persistLibraryCache(pull.cache);
      const after = await this.scanAllReferences('sync');
      new Notice(
        `Zotero 同步完成：新增 ${plan.creates}、更新 ${plan.updates}、移动 ${plan.moves}、隔离 ${plan.quarantines}；扫描 ${after.references} 篇文献，保护 ${after.drafts} 条草稿。`,
        10000
      );
      if (before.drafts > 0 && after.drafts > 0) await this.persistState();
    } catch (error) {
      this.showError(manual ? '安全同步失败' : '启动安全同步已停止', error);
    } finally {
      this.syncing = false;
    }
  }

  private async applyMigration(): Promise<void> {
    if (this.syncing) {
      new Notice('Zotero Note Bridge：同步或迁移已在运行。');
      return;
    }
    this.syncing = true;
    try {
      await this.prepareServer(true);
      await this.saveOpenEditors();
      const {pull, plan, existing} = await this.pullAndPlan();
      const report = await this.planReport(pull, plan, existing, true);
      const approved = await new ConfirmModal(
        this.app,
        '执行 Zotero Note Bridge 2.0 迁移',
        `${report}\n\n继续后会先备份所有待修改文件，再原地接管。`,
        '备份并执行迁移'
      ).wait();
      if (!approved) return;
      const backupRoot = await this.backupPlan(plan);
      await this.applyPlan(plan);
      await this.persistLibraryCache(pull.cache);
      await this.scanAllReferences('sync');
      this.settings.migrationCompleted = true;
      this.settings.syncOnStartup = true;
      await this.savePluginSettings();
      await this.disableLegacyPlugin();
      new Notice(`迁移完成；旧插件文件仍保留。恢复备份：${backupRoot}`, 15000);
    } catch (error) {
      this.showError('迁移失败', error);
    } finally {
      this.syncing = false;
    }
  }

  private async createLocalNote(file: TFile): Promise<void> {
    try {
      const markdown = await this.app.vault.read(file);
      if (!isReferenceCard(markdown)) throw new Error('当前文件不是 Zotero 文献卡');
      const parent = extractReferenceKey(markdown);
      const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const metadata: NoteMarker = {localId, parent, version: 0, baseHash: EMPTY_HASH};
      const content = '在这里写 Zotero 子笔记。';
      const next = insertNoteBlock(markdown, renderNoteBlock(metadata, content));
      await this.writeFile(file, next);
      const block = parseNoteBlocks(next).find((value) => value.id === localId);
      if (block) this.state.drafts[keyForBlock(block)] = storedFromBlock(block, file.path);
      await this.persistState();
      new Notice('已创建本地子笔记草稿；编辑后请手动执行推送命令。');
    } catch (error) {
      this.showError('新建子笔记失败', error);
    }
  }

  private async pushPage(file: TFile): Promise<void> {
    try {
      const blocks = parseNoteBlocks(await this.app.vault.read(file)).filter(isDirty);
      if (!blocks.length) {
        new Notice('当前文献卡没有需要推送的子笔记改动。');
        return;
      }
      await this.pushSelectedBlocks(file, blocks.map((block) => block.id));
    } catch (error) {
      this.showError('读取本页改动失败', error);
    }
  }

  private async pushSelectedBlocks(file: TFile, ids: string[]): Promise<void> {
    try {
      await this.prepareServer(false);
      const latest = await this.app.vault.read(file);
      const blocks = parseNoteBlocks(latest).filter((block) => ids.includes(block.id) && isDirty(block));
      if (!blocks.length) {
        new Notice('所选子笔记没有需要推送的改动。');
        return;
      }
      new Notice(`已识别 ${blocks.length} 条未推送改动；请在确认窗口中决定是否写入 Zotero。`, 6000);
      const approved = await new ConfirmModal(
        this.app,
        '确认写入 Zotero',
        `将把 ${blocks.length} 条子笔记写入本机 Zotero。写入前会再次读取远端版本；版本不一致时不会覆盖，而会进入冲突选择。`
      ).wait();
      if (!approved) {
        new Notice('已取消 Zotero 写入；Obsidian 草稿仍安全保留。');
        return;
      }

      new Notice('正在读取 Zotero 最新版本并执行安全写入……', 6000);
      let pushed = 0;
      for (const block of blocks) {
        if (await this.pushOneBlock(file, block.id)) pushed += 1;
      }
      new Notice(`Zotero Note Bridge：已成功推送 ${pushed}/${blocks.length} 条子笔记。`, 8000);
    } catch (error) {
      this.showError('推送失败', error);
    }
  }

  private async discardLocalDraft(file: TFile, id: string): Promise<void> {
    try {
      await this.prepareServer(false);
      const {block} = await this.currentBlock(file, id);
      if (!isDirty(block)) {
        new Notice('这条子笔记没有未推送改动。');
        return;
      }
      if (!block.metadata.key) throw new Error('尚未推送的新建笔记没有 Zotero 远端版本；请直接编辑草稿正文');
      const approved = await new ConfirmModal(
        this.app,
        '放弃 Obsidian 未推送改动',
        '将先备份当前 Obsidian 草稿，然后用 Zotero 中的最新内容替换此区块。不会修改或删除 Zotero 笔记。',
        '放弃本地改动'
      ).wait();
      if (!approved) return;

      const remote = await this.api.getItem(block.metadata.key);
      this.validateRemoteNote(remote, block.metadata.parent);
      const remoteMarkdown = zoteroHtmlToMarkdown(String(remote.note ?? ''));
      const backupPath = await this.writeConflictBackup(
        storedFromBlock(block, file.path),
        {
          key: remote.key,
          parent: String(remote.parentItem ?? ''),
          version: remote.version,
          baseHash: noteContentHash(remoteMarkdown)
        },
        remoteMarkdown,
        '用户主动放弃 Obsidian 未推送草稿'
      );
      await this.acceptRemoteBlock(file, id, remote);
      new Notice(`已恢复 Zotero 内容；原草稿已备份到 ${backupPath}`, 10000);
    } catch (error) {
      this.showError('放弃本地改动失败', error);
    }
  }

  private async currentBlock(file: TFile, id: string): Promise<{markdown: string; block: NoteBlock}> {
    const markdown = await this.app.vault.read(file);
    const block = parseNoteBlocks(markdown).find((value) => value.id === id);
    if (!block) throw new Error(`找不到子笔记区块 ${id}`);
    return {markdown, block};
  }

  private async pushOneBlock(file: TFile, id: string): Promise<boolean> {
    const {block} = await this.currentBlock(file, id);
    if (!isDirty(block)) return false;
    if (block.metadata.localId && !block.metadata.key) {
      const created = await this.api.createChildNote(block.metadata.parent, markdownToZoteroHtml(block.content));
      await this.acceptRemoteBlock(file, id, created);
      return true;
    }

    const noteKey = block.metadata.key;
    if (!noteKey) throw new Error('区块缺少 Note Key 或 localId');
    let remote: ZoteroItemData;
    try {
      remote = await this.api.getItem(noteKey);
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 404) {
        return this.resolveDeletedRemote(file, block);
      }
      throw error;
    }
    this.validateRemoteNote(remote, block.metadata.parent);
    const remoteMarkdown = zoteroHtmlToMarkdown(String(remote.note ?? ''));
    if (remote.version !== block.metadata.version || noteContentHash(remoteMarkdown) !== block.metadata.baseHash) {
      return this.resolveConflict(file, block, remote);
    }

    try {
      const updated = await this.api.patchNote(noteKey, markdownToZoteroHtml(block.content), remote.version);
      await this.acceptRemoteBlock(file, id, updated);
      return true;
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 412) {
        const newest = await this.api.getItem(noteKey);
        return this.resolveConflict(file, block, newest);
      }
      throw error;
    }
  }

  private validateRemoteNote(remote: ZoteroItemData, parent: string): void {
    if (remote.itemType !== 'note') throw new Error(`Zotero 对象 ${remote.key} 不是子笔记`);
    if (remote.parentItem !== parent) throw new Error(`Zotero 子笔记 ${remote.key} 的父文献与当前文献卡不一致`);
  }

  private async acceptRemoteBlock(file: TFile, oldId: string, remote: ZoteroItemData): Promise<void> {
    const {markdown, block} = await this.currentBlock(file, oldId);
    const parent = block.metadata.parent;
    this.validateRemoteNote(remote, parent);
    const confirmed = zoteroHtmlToMarkdown(String(remote.note ?? ''));
    const metadata: NoteMarker = {
      key: remote.key,
      parent,
      version: remote.version,
      baseHash: noteContentHash(confirmed)
    };
    const next = replaceBlock(markdown, block, metadata, confirmed);
    await this.writeFile(file, next);
    delete this.state.drafts[localDraftKey(block.metadata.parent, oldId)];
    const newBlock = parseNoteBlocks(next).find((value) => value.id === remote.key);
    if (newBlock) this.state.known[keyForBlock(newBlock)] = storedFromBlock(newBlock, file.path);
    await this.persistState();
  }

  private async resolveConflict(file: TFile, local: NoteBlock, remote: ZoteroItemData): Promise<boolean> {
    this.validateRemoteNote(remote, local.metadata.parent);
    const remoteMarkdown = zoteroHtmlToMarkdown(String(remote.note ?? ''));
    const backupPath = await this.writeConflictBackup(
      storedFromBlock(local, file.path),
      {
        key: remote.key,
        parent: String(remote.parentItem ?? ''),
        version: remote.version,
        baseHash: noteContentHash(remoteMarkdown)
      },
      remoteMarkdown,
      '推送前版本校验冲突'
    );
    const choice = await new ConflictModal(this.app, remote.key, backupPath).wait();
    if (choice === 'cancel') {
      this.state.drafts[keyForBlock(local)] = storedFromBlock(local, file.path);
      await this.persistState();
      return false;
    }
    if (choice === 'remote') {
      await this.acceptRemoteBlock(file, local.id, remote);
      return false;
    }

    try {
      const updated = await this.api.patchNote(remote.key, markdownToZoteroHtml(local.content), remote.version);
      await this.acceptRemoteBlock(file, local.id, updated);
      return true;
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 412) {
        new Notice('冲突选择后 Zotero 又发生了变化，未覆盖；请重新推送。', 10000);
        this.state.drafts[keyForBlock(local)] = storedFromBlock(local, file.path);
        await this.persistState();
        return false;
      }
      throw error;
    }
  }

  private async resolveDeletedRemote(file: TFile, local: NoteBlock): Promise<boolean> {
    const backupPath = await this.writeConflictBackup(
      storedFromBlock(local, file.path),
      undefined,
      '',
      'Zotero 远端子笔记已删除'
    );
    const choice = await new ConflictModal(this.app, local.id, backupPath, true).wait();
    if (choice !== 'local') {
      this.state.drafts[keyForBlock(local)] = storedFromBlock(local, file.path);
      await this.persistState();
      return false;
    }
    const created = await this.api.createChildNote(local.metadata.parent, markdownToZoteroHtml(local.content));
    await this.acceptRemoteBlock(file, local.id, created);
    return true;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!await this.app.vault.adapter.exists(current)) await this.app.vault.createFolder(current);
    }
  }

  private async writeConflictBackup(
    local: StoredBlock,
    remoteMetadata: NoteMarker | undefined,
    remoteContent: string,
    reason: string
  ): Promise<string> {
    const conflictRoot = normalizePath(this.settings.conflictRoot);
    await this.ensureFolder(conflictRoot);
    const id = local.metadata.key || local.metadata.localId || 'unknown';
    const basePath = `${conflictRoot}/${filenameTimestamp()}-${id}`;
    let path = normalizePath(`${basePath}.md`);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(`${basePath}-${suffix}.md`);
      suffix += 1;
    }
    const body = `---\n` +
      `type: zotero-note-conflict\n` +
      `reason: ${JSON.stringify(reason)}\n` +
      `created: ${JSON.stringify(timestamp())}\n` +
      `parent_key: ${JSON.stringify(local.metadata.parent)}\n` +
      `note_key: ${JSON.stringify(id)}\n` +
      `local_version: ${local.metadata.version}\n` +
      `remote_version: ${remoteMetadata?.version ?? 0}\n` +
      `source_file: ${JSON.stringify(local.filePath)}\n` +
      `---\n\n# Zotero 子笔记冲突对照\n\n` +
      `## Obsidian 本地内容\n\n${local.content || '*空内容*'}\n\n` +
      `## Zotero 内容\n\n${remoteContent || '*Zotero 中不存在或内容为空*'}\n\n` +
      `## 版本与基线\n\n` +
      `- 本地标记：\`${JSON.stringify(local.metadata)}\`\n` +
      `- 远端标记：\`${JSON.stringify(remoteMetadata ?? null)}\`\n`;
    await this.app.vault.create(path, body);
    return path;
  }
}
