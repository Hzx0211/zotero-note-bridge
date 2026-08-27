import {mergeManagedDocument} from './core';
import {RenderedLibraryFile} from './renderer';

export interface ExistingLibraryFile {
  key: string;
  kind: 'reference' | 'collection';
  path: string;
  content: string;
  removed?: boolean;
}

export type SyncOperationKind = 'create' | 'update' | 'move' | 'quarantine';

export interface SyncOperation {
  kind: SyncOperationKind;
  key: string;
  fileKind: 'reference' | 'collection';
  fromPath?: string;
  toPath: string;
  content: string;
}

export interface SyncPlan {
  operations: SyncOperation[];
  unchanged: number;
  creates: number;
  updates: number;
  moves: number;
  quarantines: number;
}

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function markRemoved(content: string, removedAt: string): string {
  let next = content;
  if (/^zotero_status:\s*.*$/m.test(next)) next = next.replace(/^zotero_status:\s*.*$/m, 'zotero_status: removed');
  else next = next.replace(/^---\n/, '---\nzotero_status: removed\n');
  if (/^zotero_removed_at:\s*.*$/m.test(next)) next = next.replace(/^zotero_removed_at:\s*.*$/m, `zotero_removed_at: ${JSON.stringify(removedAt)}`);
  else next = next.replace(/^---\n/, `---\nzotero_removed_at: ${JSON.stringify(removedAt)}\n`);
  return next;
}

export function planLibrarySync(
  rendered: readonly RenderedLibraryFile[],
  existing: readonly ExistingLibraryFile[],
  referenceRoot: string,
  removedRoot: string,
  now = new Date()
): SyncPlan {
  const existingByKey = new Map(existing.map((file) => [file.key, file]));
  const renderedByKey = new Map(rendered.map((file) => [file.key, file]));
  const operations: SyncOperation[] = [];
  let unchanged = 0;
  for (const target of rendered) {
    const current = existingByKey.get(target.key);
    if (!current) {
      operations.push({kind: 'create', key: target.key, fileKind: target.kind, toPath: target.path, content: target.content});
      continue;
    }
    const merged = mergeManagedDocument(current.content, target.content, target.kind === 'reference');
    if (current.path !== target.path) {
      operations.push({kind: 'move', key: target.key, fileKind: target.kind, fromPath: current.path, toPath: target.path, content: merged});
    } else if (merged !== current.content) {
      operations.push({kind: 'update', key: target.key, fileKind: target.kind, fromPath: current.path, toPath: target.path, content: merged});
    } else {
      unchanged += 1;
    }
  }
  const removedAt = now.toISOString();
  for (const current of existing) {
    if (renderedByKey.has(current.key) || current.removed || current.path.startsWith(`${removedRoot}/`)) continue;
    const relative = current.path.startsWith(`${referenceRoot}/`)
      ? current.path.slice(referenceRoot.length + 1)
      : current.path;
    operations.push({
      kind: 'quarantine',
      key: current.key,
      fileKind: current.kind,
      fromPath: current.path,
      toPath: `${removedRoot}/${dateStamp(now)}/${relative}`,
      content: markRemoved(current.content, removedAt)
    });
  }
  return {
    operations,
    unchanged,
    creates: operations.filter((operation) => operation.kind === 'create').length,
    updates: operations.filter((operation) => operation.kind === 'update').length,
    moves: operations.filter((operation) => operation.kind === 'move').length,
    quarantines: operations.filter((operation) => operation.kind === 'quarantine').length
  };
}
