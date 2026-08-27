import {
  NoteMarker,
  noteContentHash,
  renderManagedDocument,
  renderNoteBlock
} from './core';
import {ZoteroCollectionData, ZoteroItemData, ZoteroLibraryCache} from './zotero-api';
import {ZoteroNoteBridgeSettings} from './settings';

const SKIP_TYPES = new Set(['attachment', 'annotation', 'note']);

export interface ProtectedDraft {
  metadata: NoteMarker;
  content: string;
}

export interface RenderedLibraryFile {
  key: string;
  kind: 'reference' | 'collection';
  path: string;
  content: string;
}

export interface RenderContext {
  settings: ZoteroNoteBridgeSettings;
  drafts: Record<string, ProtectedDraft>;
  noteHtmlToMarkdown: (html: string) => string;
}

export function cleanName(value: unknown, fallback = '未命名'): string {
  const cleaned = String(value ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|#\[\]^]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || fallback;
}

function yaml(value: unknown): string {
  return JSON.stringify(value == null ? '' : value);
}

function getYear(item: ZoteroItemData): string {
  const match = String(item.date ?? '').match(/(?:^|\D)((?:1[5-9]|20|21)\d{2})(?:\D|$)/);
  return match?.[1] ?? '';
}

function extraField(item: ZoteroItemData, name: string): string {
  const result: string[] = [];
  let collecting = false;
  for (const line of String(item.extra ?? '').split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (field) {
      if (collecting) break;
      if (field[1]?.toLowerCase() === name.toLowerCase()) {
        collecting = true;
        if (field[2]) result.push(field[2]);
      }
    } else if (collecting) {
      result.push(line);
    }
  }
  return result.join('\n').trim();
}

function isChinese(text: string, language: unknown): boolean {
  if (/^zh(?:-|$)/i.test(String(language ?? '').trim())) return true;
  return (String(text).match(/[\u3400-\u9fff]/g) ?? []).length >= 20;
}

function creators(item: ZoteroItemData): string[] {
  const values = Array.isArray(item.creators) ? item.creators as Array<Record<string, unknown>> : [];
  const authors = values.filter((creator) => creator.creatorType === 'author');
  return (authors.length ? authors : values)
    .map((creator) => [creator.firstName, creator.lastName].filter(Boolean).join(' ').trim() || String(creator.name ?? ''))
    .filter(Boolean);
}

function tags(item: ZoteroItemData): string[] {
  return (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => typeof tag === 'string' ? tag : String((tag as Record<string, unknown>).tag ?? ''))
    .filter(Boolean);
}

function sourceName(item: ZoteroItemData): string {
  return String(item.publicationTitle ?? item.proceedingsTitle ?? item.bookTitle ?? item.university ??
    item.publisher ?? item.websiteTitle ?? item.conferenceName ?? item.repository ?? '');
}

export function collectionSegments(
  collection: ZoteroCollectionData,
  collections: ReadonlyMap<string, ZoteroCollectionData>
): string[] {
  const segments: string[] = [];
  const visited = new Set<string>();
  let current: ZoteroCollectionData | undefined = collection;
  while (current && !visited.has(current.key)) {
    visited.add(current.key);
    segments.unshift(cleanName(current.name, `未命名分类 [${current.key}]`));
    current = current.parentCollection ? collections.get(current.parentCollection) : undefined;
  }
  return segments;
}

function primaryCollection(
  item: ZoteroItemData,
  collections: ReadonlyMap<string, ZoteroCollectionData>
): {collection: ZoteroCollectionData; segments: string[]} | undefined {
  const keys = Array.isArray(item.collections) ? item.collections.map(String) : [];
  const candidates = keys
    .map((key) => collections.get(key))
    .filter((value): value is ZoteroCollectionData => Boolean(value))
    .map((collection) => ({collection, segments: collectionSegments(collection, collections)}));
  candidates.sort((left, right) => {
    const depth = right.segments.length - left.segments.length;
    if (depth) return depth;
    const path = left.segments.join('/').localeCompare(right.segments.join('/'), 'zh-CN');
    return path || left.collection.key.localeCompare(right.collection.key);
  });
  return candidates[0];
}

function itemBaseName(
  item: ZoteroItemData,
  references: readonly ZoteroItemData[]
): string {
  const rawTitle = String(item.title ?? '').trim();
  const base = cleanName(rawTitle, `未命名文献 [${item.key}]`);
  if (!rawTitle) return base;
  const normalized = base.toLocaleLowerCase();
  const collisions = references.filter((candidate) => {
    const title = String(candidate.title ?? '').trim();
    return title && cleanName(title).toLocaleLowerCase() === normalized;
  }).length;
  if (collisions <= 1) return base;
  const year = getYear(item);
  return `${base}${year ? ` — ${year}` : ''} [${item.key}]`;
}

function collectionPath(key: string, collections: ReadonlyMap<string, ZoteroCollectionData>): string {
  const collection = collections.get(key);
  return collection ? collectionSegments(collection, collections).join('/') : '';
}

function childNotes(
  parent: ZoteroItemData,
  items: ReadonlyMap<string, ZoteroItemData>
): ZoteroItemData[] {
  return Array.from(items.values())
    .filter((item) => item.itemType === 'note' && item.parentItem === parent.key)
    .sort((left, right) => String(left.dateAdded ?? '').localeCompare(String(right.dateAdded ?? '')) || left.key.localeCompare(right.key));
}

function attachments(parent: ZoteroItemData, items: ReadonlyMap<string, ZoteroItemData>): ZoteroItemData[] {
  return Array.from(items.values()).filter((item) =>
    item.itemType === 'attachment' && item.parentItem === parent.key && item.contentType === 'application/pdf'
  );
}

function noteBlocks(
  parent: ZoteroItemData,
  items: ReadonlyMap<string, ZoteroItemData>,
  context: RenderContext
): string {
  const remote = childNotes(parent, items);
  const rendered: string[] = [];
  const seen = new Set<string>();
  for (const note of remote) {
    const draftKey = `${parent.key}:${note.key}`;
    const draft = context.drafts[draftKey];
    if (draft) {
      rendered.push(renderNoteBlock(draft.metadata, draft.content));
    } else {
      const markdown = context.noteHtmlToMarkdown(String(note.note ?? ''));
      rendered.push(renderNoteBlock({
        key: note.key,
        parent: parent.key,
        version: note.version,
        baseHash: noteContentHash(markdown)
      }, markdown));
    }
    seen.add(draftKey);
  }
  for (const [key, draft] of Object.entries(context.drafts)) {
    if (draft.metadata.parent !== parent.key || seen.has(key)) continue;
    rendered.push(renderNoteBlock(draft.metadata, draft.content));
  }
  return rendered.length ? rendered.join('\n\n') : '- 暂无 Zotero 子笔记';
}

function renderReference(
  item: ZoteroItemData,
  items: ReadonlyMap<string, ZoteroItemData>,
  collections: ReadonlyMap<string, ZoteroCollectionData>,
  references: readonly ZoteroItemData[],
  context: RenderContext
): RenderedLibraryFile {
  const title = String(item.title ?? '').trim() || `未命名文献 [${item.key}]`;
  const fileBase = itemBaseName(item, references);
  const year = getYear(item);
  const authorNames = creators(item);
  const source = sourceName(item);
  const doi = String(item.DOI ?? item.doi ?? '').trim();
  const url = String(item.url ?? '').trim();
  const language = String(item.language ?? '').trim();
  const collectionKeys = Array.isArray(item.collections) ? item.collections.map(String) : [];
  const collectionPaths = collectionKeys.map((key) => collectionPath(key, collections)).filter(Boolean);
  const pdfs = attachments(item, items);
  const abstractOriginal = String(item.abstractNote ?? '').trim();
  const abstractTranslation = extraField(item, 'abstractTranslation');
  const titleTranslation = extraField(item, 'titleTranslation');
  const originalIsChinese = isChinese(abstractOriginal || title, language);
  const chineseAbstract = originalIsChinese ? abstractOriginal : abstractTranslation;
  const aliases = Array.from(new Set([title, titleTranslation].filter(Boolean)));
  const readingBase = `${fileBase} - 阅读笔记`;
  const primary = primaryCollection(item, collections);
  const folder = primary
    ? [context.settings.referenceRoot, ...primary.segments]
    : [context.settings.referenceRoot, '未分类'];
  const frontmatter = [
    '---',
    'type: zotero-reference',
    `zotero_key: ${yaml(item.key)}`,
    'zotero_status: active',
    `title: ${yaml(title)}`,
    `title_zh: ${yaml(titleTranslation)}`,
    `aliases: ${yaml(aliases)}`,
    `authors: ${yaml(authorNames)}`,
    `year: ${yaml(year)}`,
    `item_type: ${yaml(item.itemType)}`,
    `source: ${yaml(source)}`,
    `doi: ${yaml(doi)}`,
    `url: ${yaml(url)}`,
    `language: ${yaml(language)}`,
    `zotero_tags: ${yaml(tags(item))}`,
    `zotero_collections: ${yaml(collectionPaths)}`,
    `has_pdf: ${pdfs.length > 0}`,
    `pdf_count: ${pdfs.length}`,
    `abstract_status: ${yaml(!abstractOriginal ? 'missing' : originalIsChinese || abstractTranslation ? 'ready' : 'translation-pending')}`,
    `reading_note: ${yaml(`[[${context.settings.readingNotesRoot}/${readingBase}]]`)}`,
    'tags: [zotero, literature, reference]',
    '---'
  ].join('\n');

  let body = `[🇿](zotero://select/library/items/${item.key})\n\n# ${title}${year ? ` (${year})` : ''}\n\n`;
  if (context.settings.includeChineseTranslation && titleTranslation && titleTranslation !== title) {
    body += `> **中文题名：** ${titleTranslation}\n\n`;
  }
  body += `## 基本信息\n\n- **作者：** ${authorNames.length ? authorNames.join('；') : 'Zotero 暂无作者信息'}\n`;
  body += `- **年份：** ${year || 'Zotero 暂无年份'}\n- **类型：** ${item.itemType}\n`;
  body += `- **来源：** ${source || 'Zotero 暂无来源信息'}\n- **语言：** ${language || 'Zotero 暂无语言信息'}\n`;
  if (doi) body += `- **DOI：** [${doi}](https://doi.org/${doi})\n`;
  if (url) body += `- **网页：** [打开原始网页](${url})\n`;
  body += `- **Zotero：** [打开文献](zotero://select/library/items/${item.key})\n\n## PDF\n\n`;
  body += pdfs.length
    ? pdfs.map((pdf) => `- [${String(pdf.title ?? pdf.filename ?? '打开 PDF')}](zotero://open-pdf/library/items/${pdf.key})`).join('\n')
    : '- Zotero 暂无 PDF 附件';
  body += '\n\n## 中文摘要\n\n';
  if (!abstractOriginal) body += '> Zotero 暂无摘要。';
  else if (context.settings.includeChineseTranslation && chineseAbstract) body += chineseAbstract;
  else body += '> 待在 Zotero 中补充中文摘要；同步后会自动显示在这里。';
  if (context.settings.includeOriginalAbstract && abstractOriginal && !originalIsChinese) {
    body += `\n\n## 原文摘要\n\n${abstractOriginal}`;
  }
  body += '\n\n## Zotero 分类\n\n';
  if (collectionKeys.length) {
    body += collectionKeys.map((key) => {
      const collection = collections.get(key);
      return collection
        ? `- [[${context.settings.referenceRoot}/${collectionSegments(collection, collections).join('/')}/_分类索引|${collectionSegments(collection, collections).join(' / ')}]]`
        : `- ⚠️ Zotero 分类键 ${key} 已不存在，请在 Zotero 中重新归类`;
    }).join('\n');
  } else {
    body += `- [[${context.settings.referenceRoot}/未分类/_分类索引|未分类]]`;
  }
  body += `\n\n## Zotero 子笔记\n\n${noteBlocks(item, items, context)}\n\n## 个人阅读笔记\n\n`;
  body += `- [[${context.settings.readingNotesRoot}/${readingBase}|创建或打开个人阅读笔记]]\n`;
  body += '> 个人分析请写在独立阅读笔记中；“Zotero 子笔记”区块可由 Zotero Note Bridge 安全回写。';

  return {
    key: item.key,
    kind: 'reference',
    path: [...folder, `${fileBase}.md`].join('/'),
    content: renderManagedDocument(frontmatter, body)
  };
}

function renderCollection(
  collection: ZoteroCollectionData,
  items: ReadonlyMap<string, ZoteroItemData>,
  collections: ReadonlyMap<string, ZoteroCollectionData>,
  references: readonly ZoteroItemData[],
  settings: ZoteroNoteBridgeSettings
): RenderedLibraryFile {
  const segments = collectionSegments(collection, collections);
  const directChildren = Array.from(collections.values())
    .filter((candidate) => candidate.parentCollection === collection.key)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  const directItems = references
    .filter((item) => Array.isArray(item.collections) && item.collections.map(String).includes(collection.key))
    .sort((left, right) => Number(getYear(right) || 0) - Number(getYear(left) || 0) || String(left.title ?? '').localeCompare(String(right.title ?? ''), 'zh-CN'));
  const frontmatter = [
    '---',
    'type: zotero-collection',
    `zotero_key: ${yaml(collection.key)}`,
    'zotero_status: active',
    `title: ${yaml(collection.name || '未命名分类')}`,
    `zotero_path: ${yaml(segments.join('/'))}`,
    `parent_collection: ${yaml(collection.parentCollection || '')}`,
    `child_collection_count: ${directChildren.length}`,
    `direct_item_count: ${directItems.length}`,
    'tags: [zotero, literature, collection]',
    '---'
  ].join('\n');
  let body = `[🇿](zotero://select/library/collections/${collection.key})\n\n# ${collection.name || '未命名分类'}\n\n`;
  body += `> Zotero 分类路径：${segments.join(' / ')}\n\n- [在 Zotero 中打开此分类](zotero://select/library/collections/${collection.key})\n`;
  if (collection.parentCollection && collections.has(collection.parentCollection)) {
    const parent = collections.get(collection.parentCollection)!;
    body += `- 上级分类：[[${settings.referenceRoot}/${collectionSegments(parent, collections).join('/')}/_分类索引|${parent.name}]]\n`;
  }
  body += '\n## 子分类\n\n';
  body += directChildren.length
    ? directChildren.map((child) => `- [[${settings.referenceRoot}/${collectionSegments(child, collections).join('/')}/_分类索引|${child.name}]]`).join('\n')
    : '- 无';
  body += '\n\n## 直属文献\n\n';
  body += directItems.length
    ? directItems.map((item) => {
      const year = getYear(item);
      const primary = primaryCollection(item, collections);
      const folder = primary ? [settings.referenceRoot, ...primary.segments] : [settings.referenceRoot, '未分类'];
      const base = itemBaseName(item, references);
      return `- ${year ? `${year} · ` : ''}[[${[...folder, base].join('/')}|${String(item.title ?? base)}]]`;
    }).join('\n')
    : '- 无';
  return {
    key: collection.key,
    kind: 'collection',
    path: `${settings.referenceRoot}/${segments.join('/')}/_分类索引.md`,
    content: renderManagedDocument(frontmatter, body)
  };
}

function renderUnclassified(
  references: readonly ZoteroItemData[],
  collections: ReadonlyMap<string, ZoteroCollectionData>,
  settings: ZoteroNoteBridgeSettings
): RenderedLibraryFile {
  const directItems = references
    .filter((item) => !primaryCollection(item, collections))
    .sort((left, right) => Number(getYear(right) || 0) - Number(getYear(left) || 0) || String(left.title ?? '').localeCompare(String(right.title ?? ''), 'zh-CN'));
  const frontmatter = [
    '---',
    'type: zotero-collection',
    'zotero_key: "ZNBUNCL1"',
    'zotero_status: active',
    'zotero_virtual: true',
    'title: "未分类"',
    'zotero_path: "未分类"',
    'parent_collection: ""',
    'child_collection_count: 0',
    `direct_item_count: ${directItems.length}`,
    'tags: [zotero, literature, collection]',
    '---'
  ].join('\n');
  let body = '# 未分类\n\n> 尚未归入有效 Zotero 分类的文献。\n\n## 直属文献\n\n';
  body += directItems.length
    ? directItems.map((item) => {
      const year = getYear(item);
      const base = itemBaseName(item, references);
      return `- ${year ? `${year} · ` : ''}[[${settings.referenceRoot}/未分类/${base}|${String(item.title ?? base)}]]`;
    }).join('\n')
    : '- 无';
  return {
    key: 'ZNBUNCL1',
    kind: 'collection',
    path: `${settings.referenceRoot}/未分类/_分类索引.md`,
    content: renderManagedDocument(frontmatter, body)
  };
}

export function renderLibrary(cache: ZoteroLibraryCache, context: RenderContext): RenderedLibraryFile[] {
  const items = new Map(Object.entries(cache.items));
  const collections = new Map(Object.entries(cache.collections));
  const references = Array.from(items.values()).filter((item) => !SKIP_TYPES.has(item.itemType.toLowerCase()) && !item.parentItem);
  if (collections.has('ZNBUNCL1')) throw new Error('Zotero 分类 Key ZNBUNCL1 与插件保留 Key 冲突');
  const rendered = [
    ...Array.from(collections.values()).map((collection) => renderCollection(collection, items, collections, references, context.settings)),
    renderUnclassified(references, collections, context.settings),
    ...references.map((item) => renderReference(item, items, collections, references, context))
  ];
  const pathOwners = new Map<string, string>();
  for (const file of rendered) {
    const owner = pathOwners.get(file.path);
    if (owner) throw new Error(`生成路径冲突：${file.path}（${owner} / ${file.key}）`);
    pathOwners.set(file.path, file.key);
  }
  return rendered;
}
