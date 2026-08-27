export interface NoteMarker {
  key?: string;
  localId?: string;
  parent: string;
  version: number;
  baseHash: string;
}

export interface NoteBlock {
  id: string;
  metadata: NoteMarker;
  content: string;
  heading: string;
  start: number;
  markerStart: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

export type DraftReconcileAction =
  | 'capture-current'
  | 'discard-draft'
  | 'restore-draft'
  | 'conflict';

const END_MARKER = '<!-- zotero-note:end -->';
const START_MARKER = /<!--\s*zotero-note:start\s+(\{[^\n]*\})\s*-->/g;
export const MANAGED_START = '<!-- znb-managed:start -->';
export const MANAGED_END = '<!-- znb-managed:end -->';
const LEGACY_REFERENCE_END = '> 个人分析请写在独立阅读笔记中；“Zotero 子笔记”区块可由 Zotero Note Bridge 安全回写。';

export function normalizeNoteMarkdown(value: string): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

export function noteContentHash(value: string): string {
  const normalized = normalizeNoteMarkdown(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return [h1, h2]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('');
}

export function isDirty(block: NoteBlock): boolean {
  return noteContentHash(block.content) !== block.metadata.baseHash;
}

/**
 * Decide how an existing protected draft should be reconciled with the block
 * currently present in the Markdown file.
 *
 * A clean block with the same baseline is ambiguous: a sync client may have
 * overwritten a draft with Zotero's old content, or the user may have
 * deliberately reverted their edit. Callers resolve that ambiguity using a
 * trusted user-input signal rather than the file contents alone.
 */
export function reconcileDraftAction(
  current: NoteBlock,
  draft: {metadata: NoteMarker; content: string},
  userInitiated: boolean
): DraftReconcileAction {
  if (isDirty(current)) return 'capture-current';
  if (noteContentHash(current.content) === noteContentHash(draft.content)) return 'discard-draft';
  if (current.metadata.baseHash === draft.metadata.baseHash) {
    return userInitiated ? 'discard-draft' : 'restore-draft';
  }
  return 'conflict';
}

export function blockId(metadata: NoteMarker): string {
  return metadata.key || metadata.localId || '';
}

export function childNoteTitle(value: string): string {
  const firstLine = normalizeNoteMarkdown(value)
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*>\s]+/, '').trim())
    .find(Boolean);
  return String(firstLine || '无标题')
    .replace(/[\[\]`*_<>]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 72);
}

export function renderNoteBlock(metadata: NoteMarker, content: string): string {
  const normalized = normalizeNoteMarkdown(content);
  const id = blockId(metadata) || '本地草稿';
  const heading = `### Zotero 子笔记 · ${childNoteTitle(normalized)} · ${id}`;
  return `${heading}\n<!-- zotero-note:start ${JSON.stringify(metadata)} -->\n${normalized}\n${END_MARKER}`;
}

function markerIsValid(value: unknown): value is NoteMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.parent === 'string' &&
    marker.parent.length === 8 &&
    typeof marker.version === 'number' &&
    Number.isFinite(marker.version) &&
    typeof marker.baseHash === 'string' &&
    marker.baseHash.length > 0 &&
    ((typeof marker.key === 'string' && marker.key.length === 8) ||
      (typeof marker.localId === 'string' && marker.localId.length > 0))
  );
}

export function parseNoteBlocks(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  START_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = START_MARKER.exec(markdown))) {
    const markerText = match[1];
    if (!markerText) continue;
    let metadata: NoteMarker;
    try {
      const parsed: unknown = JSON.parse(markerText);
      if (!markerIsValid(parsed)) continue;
      metadata = parsed;
    } catch {
      continue;
    }

    const markerStart = match.index;
    const markerEnd = markerStart + match[0].length;
    const endMarkerStart = markdown.indexOf(END_MARKER, markerEnd);
    if (endMarkerStart < 0) continue;

    const priorLineEnd = markerStart > 0 && markdown[markerStart - 1] === '\n' ? markerStart - 1 : markerStart;
    const priorLineStart = markdown.lastIndexOf('\n', priorLineEnd - 1) + 1;
    const priorLine = markdown.slice(priorLineStart, priorLineEnd);
    const hasHeading = /^### Zotero 子笔记 · /.test(priorLine);
    const start = hasHeading ? priorLineStart : markerStart;
    const heading = hasHeading ? priorLine : '';
    const contentStart = markerEnd + (markdown[markerEnd] === '\n' ? 1 : 0);
    let contentEnd = endMarkerStart;
    if (contentEnd > contentStart && markdown[contentEnd - 1] === '\n') contentEnd -= 1;
    const end = endMarkerStart + END_MARKER.length;
    const id = blockId(metadata);
    if (!id) continue;
    blocks.push({
      id,
      metadata,
      content: normalizeNoteMarkdown(markdown.slice(contentStart, contentEnd)),
      heading,
      start,
      markerStart,
      contentStart,
      contentEnd,
      end
    });
    START_MARKER.lastIndex = end;
  }
  return blocks;
}

export function replaceBlock(markdown: string, block: NoteBlock, metadata: NoteMarker, content: string): string {
  return `${markdown.slice(0, block.start)}${renderNoteBlock(metadata, content)}${markdown.slice(block.end)}`;
}

export function extractReferenceKey(markdown: string): string {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  const key = frontmatter.match(/^zotero_key:\s*["']?([A-Za-z0-9]{8})["']?\s*$/m)?.[1];
  return key ?? '';
}

export function isReferenceCard(markdown: string): boolean {
  const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1] ?? '';
  return /^type:\s*zotero-reference\s*$/m.test(frontmatter) && Boolean(extractReferenceKey(markdown));
}

export function insertNoteBlock(markdown: string, renderedBlock: string): string {
  const section = /(^|\n)## Zotero 子笔记\s*\n/g.exec(markdown);
  if (!section) {
    const nextSection = markdown.search(/\n## 个人阅读笔记\s*\n/);
    const insertion = `\n## Zotero 子笔记\n\n${renderedBlock}\n`;
    return nextSection >= 0
      ? `${markdown.slice(0, nextSection)}${insertion}${markdown.slice(nextSection)}`
      : `${markdown.trimEnd()}${insertion}\n`;
  }

  const bodyStart = section.index + section[0].length;
  const nextHeading = markdown.slice(bodyStart).search(/\n## (?!#)/);
  const bodyEnd = nextHeading >= 0 ? bodyStart + nextHeading : markdown.length;
  const body = markdown.slice(bodyStart, bodyEnd);
  const placeholderOnly = /^\s*- 暂无 Zotero 子笔记\s*$/.test(body);
  const prefix = placeholderOnly ? '' : body.trim();
  const replacement = `${prefix ? `${prefix}\n\n` : ''}${renderedBlock}\n`;
  return `${markdown.slice(0, bodyStart)}${replacement}${markdown.slice(bodyEnd)}`;
}

export function blockAtOffset(blocks: NoteBlock[], offset: number): NoteBlock | undefined {
  return blocks.find((block) => offset >= block.start && offset <= block.end);
}

export function localDraftKey(parent: string, id: string): string {
  return `${parent}:${id}`;
}

export function renderManagedDocument(frontmatter: string, body: string): string {
  return `${frontmatter.trim()}\n\n${MANAGED_START}\n${body.trim()}\n${MANAGED_END}\n`;
}

export function mergeManagedDocument(existing: string, generated: string, preserveLegacyReferenceSuffix = false): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END, start + MANAGED_START.length);
  if (start < 0 || end < 0) {
    if (!preserveLegacyReferenceSuffix) return generated;
    const boundary = existing.lastIndexOf(LEGACY_REFERENCE_END);
    if (boundary < 0) return generated;
    const suffix = existing.slice(boundary + LEGACY_REFERENCE_END.length).trim();
    return suffix ? `${generated.trimEnd()}\n\n${suffix}\n` : generated;
  }
  const suffix = existing.slice(end + MANAGED_END.length).replace(/^\n?/, '\n');
  return `${generated.trimEnd()}${suffix}`;
}
