import assert from 'node:assert/strict';
import test from 'node:test';
import {MANAGED_END, renderManagedDocument} from '../src/core';
import {renderLibrary} from '../src/renderer';
import {DEFAULT_SETTINGS, normalizeSettings} from '../src/settings';
import {planLibrarySync} from '../src/sync-plan';
import {ZoteroApiError, ZoteroLibraryCache, ZoteroLocalApi} from '../src/zotero-api';

function cache(items: ZoteroLibraryCache['items'], collections: ZoteroLibraryCache['collections']): ZoteroLibraryCache {
  return {
    schemaVersion: 1,
    serverId: 'SERVER123',
    libraryVersion: 10,
    items,
    collections,
    itemVersions: Object.fromEntries(Object.values(items).map((item) => [item.key, item.version])),
    collectionVersions: Object.fromEntries(Object.values(collections).map((collection) => [collection.key, collection.version])),
    updatedAt: '2026-08-26T00:00:00.000Z'
  };
}

test('normalizes safe settings and enforces a minimum interval', () => {
  const settings = normalizeSettings({referenceRoot: '../outside', syncIntervalMinutes: 2});
  assert.equal(settings.referenceRoot, 'References');
  assert.equal(settings.syncIntervalMinutes, 15);
  assert.equal(normalizeSettings({syncIntervalMinutes: 0}).syncIntervalMinutes, 0);
});

test('renders classified cards, indexes, duplicate titles and protected drafts', () => {
  const library = cache({
    PARENT01: {key: 'PARENT01', version: 1, itemType: 'journalArticle', title: 'Same title', date: '2024', collections: ['CHILD001']},
    PARENT02: {key: 'PARENT02', version: 1, itemType: 'journalArticle', title: 'Same title', date: '2024', collections: ['ROOT0001']},
    NOTE0001: {key: 'NOTE0001', version: 2, itemType: 'note', parentItem: 'PARENT01', note: '<p>remote</p>'},
    ORPHAN01: {key: 'ORPHAN01', version: 1, itemType: 'journalArticle', title: 'No collection'}
  }, {
    ROOT0001: {key: 'ROOT0001', version: 1, name: 'Root', parentCollection: false},
    CHILD001: {key: 'CHILD001', version: 1, name: 'Child', parentCollection: 'ROOT0001'}
  });
  const rendered = renderLibrary(library, {
    settings: DEFAULT_SETTINGS,
    noteHtmlToMarkdown: (value) => value.replace(/<[^>]+>/g, ''),
    drafts: {
      'PARENT01:NOTE0001': {
        metadata: {key: 'NOTE0001', parent: 'PARENT01', version: 2, baseHash: 'baseline'},
        content: 'local draft'
      }
    }
  });
  assert.equal(rendered.filter((file) => file.kind === 'reference').length, 3);
  assert.equal(rendered.filter((file) => file.kind === 'collection').length, 3);
  const parent = rendered.find((file) => file.key === 'PARENT01')!;
  assert.equal(parent.path, 'References/Root/Child/Same title — 2024 [PARENT01].md');
  assert.match(parent.content, /local draft/);
  assert.ok(rendered.some((file) => file.path === 'References/未分类/_分类索引.md'));
  assert.ok(rendered.some((file) => file.path === 'References/未分类/No collection.md'));
});

test('plans create, move, update and quarantine without losing unmanaged suffixes', () => {
  const generatedA = renderManagedDocument('---\ntype: zotero-reference\nzotero_key: "AAAA0001"\n---', '# New A');
  const oldA = `${renderManagedDocument('---\ntype: zotero-reference\nzotero_key: "AAAA0001"\n---', '# Old A').trimEnd()}\n\nPersonal suffix\n`;
  const plan = planLibrarySync([
    {key: 'AAAA0001', kind: 'reference', path: 'References/New/A.md', content: generatedA},
    {key: 'BBBB0002', kind: 'reference', path: 'References/B.md', content: renderManagedDocument('---\ntype: zotero-reference\nzotero_key: "BBBB0002"\n---', '# B')}
  ], [
    {key: 'AAAA0001', kind: 'reference', path: 'References/Old/A.md', content: oldA},
    {key: 'CCCC0003', kind: 'reference', path: 'References/C.md', content: '# C'},
    {key: 'DDDD0004', kind: 'reference', path: 'References/_已移除/2026-08-25/D.md', content: '# D', removed: true}
  ], 'References', 'References/_已移除', new Date('2026-08-26T10:00:00Z'));
  assert.equal(plan.creates, 1);
  assert.equal(plan.moves, 1);
  assert.equal(plan.quarantines, 1);
  const move = plan.operations.find((operation) => operation.kind === 'move')!;
  assert.ok(move.content.includes(MANAGED_END));
  assert.match(move.content, /Personal suffix/);
  assert.equal(plan.operations.find((operation) => operation.kind === 'quarantine')?.toPath, 'References/_已移除/2026-08-26/C.md');
});

test('restores a quarantined object by Zotero key without leaving a duplicate', () => {
  const active = renderManagedDocument('---\ntype: zotero-reference\nzotero_key: "AAAA0001"\nzotero_status: active\n---', '# Restored');
  const removed = active.replace('zotero_status: active', 'zotero_status: removed');
  const plan = planLibrarySync([
    {key: 'AAAA0001', kind: 'reference', path: 'References/Restored.md', content: active}
  ], [
    {key: 'AAAA0001', kind: 'reference', path: 'References/_已移除/2026-08-25/Restored.md', content: removed, removed: true}
  ], 'References', 'References/_已移除');
  assert.equal(plan.moves, 1);
  assert.equal(plan.creates, 0);
  assert.equal(plan.quarantines, 0);
  assert.equal(plan.operations[0]?.fromPath, 'References/_已移除/2026-08-25/Restored.md');
  assert.equal(plan.operations[0]?.toPath, 'References/Restored.md');
  assert.match(plan.operations[0]?.content ?? '', /zotero_status: active/);
});

test('adopts a legacy reference card while preserving personal text after the old template boundary', () => {
  const old = `---\ntype: zotero-reference\nzotero_key: "AAAA0001"\n---\n\n# Old\n\n> 个人分析请写在独立阅读笔记中；“Zotero 子笔记”区块可由 Zotero Note Bridge 安全回写。\n\n## My permanent note\n\nKeep this verbatim.\n`;
  const generated = renderManagedDocument('---\ntype: zotero-reference\nzotero_key: "AAAA0001"\n---', '# New');
  const plan = planLibrarySync([
    {key: 'AAAA0001', kind: 'reference', path: 'References/A.md', content: generated}
  ], [
    {key: 'AAAA0001', kind: 'reference', path: 'References/A.md', content: old}
  ], 'References', 'References/_已移除');
  assert.equal(plan.updates, 1);
  assert.match(plan.operations[0]?.content ?? '', /## My permanent note\n\nKeep this verbatim\./);
});

test('pulls paginated snapshots and detects incremental deletions', async () => {
  let phase = 1;
  const itemA = {key: 'ITEM0001', version: 10, itemType: 'journalArticle', title: 'A'};
  const noteA = {key: 'NOTE0001', version: 10, itemType: 'note', parentItem: 'ITEM0001', note: '<p>N</p>'};
  const itemB = {key: 'ITEM0002', version: 11, itemType: 'book', title: 'B'};
  const collection = {key: 'COLL0001', version: 10, name: 'Collection', parentCollection: false};
  const transport = async (request: {path: string}) => {
    const url = new URL(request.path, 'http://127.0.0.1');
    const baseHeaders: Record<string, string> = {
      'x-zotero-version': '10.0.1',
      'zotero-api-version': '3',
      'zotero-server-id': 'SERVER123'
    };
    if (url.pathname === '/') return {status: 200, headers: baseHeaders, text: 'Nothing to see here.', json: undefined};
    const isItems = url.pathname === '/users/0/items';
    const isCollections = url.pathname === '/users/0/collections';
    if (!isItems && !isCollections) return {status: 404, headers: baseHeaders, text: '{}', json: {}};
    const version = phase === 1 ? 10 : 11;
    const headers = {...baseHeaders, 'last-modified-version': String(version)};
    if (url.searchParams.get('format') === 'versions') {
      const values = isItems
        ? phase === 1 ? {ITEM0001: 10, NOTE0001: 10} : {ITEM0001: 10, ITEM0002: 11}
        : {COLL0001: 10};
      headers['total-results'] = String(Object.keys(values).length);
      return {status: 200, headers, text: JSON.stringify(values), json: values};
    }
    const since = Number(url.searchParams.get('since') ?? 0);
    const candidates = isCollections
      ? since >= 10 ? [] : [collection]
      : since >= 10 ? [itemB] : [itemA, noteA];
    const start = Number(url.searchParams.get('start') ?? 0);
    const page = candidates.slice(start, start + 1).map((data) => ({key: data.key, version: data.version, data}));
    headers['total-results'] = String(candidates.length);
    return {status: 200, headers, text: JSON.stringify(page), json: page};
  };
  const api = new ZoteroLocalApi({getSecret: () => null, setSecret: () => undefined}, {transport});
  const info = await api.getServerInfo();
  api.setExpectedServer(info.serverId);
  const first = await api.pullLibrary(null);
  assert.deepEqual(Object.keys(first.cache.items).sort(), ['ITEM0001', 'NOTE0001']);
  assert.equal(first.changedItems, 2);
  phase = 2;
  const second = await api.pullLibrary(first.cache);
  assert.deepEqual(Object.keys(second.cache.items).sort(), ['ITEM0001', 'ITEM0002']);
  assert.deepEqual(second.deletedItems, ['NOTE0001']);
  assert.equal(second.changedItems, 1);
});

test('sends an optimistic version guard and surfaces a 412 child-note conflict', async () => {
  let patchHeaders: Record<string, string> = {};
  const transport = async (request: {path: string; method?: string; headers?: Record<string, string>}) => {
    if (request.method === 'PATCH') {
      patchHeaders = request.headers ?? {};
      throw new ZoteroApiError('conflict', 412);
    }
    return {
      status: 200,
      headers: {'last-modified-version': '20'},
      text: '{}',
      json: {key: 'NOTE0001', version: 20, itemType: 'note', parentItem: 'ITEM0001', note: '<p>remote</p>'}
    };
  };
  const api = new ZoteroLocalApi({getSecret: () => 'write-key', setSecret: () => undefined}, {transport});
  api.setExpectedServer('SERVER123');
  await assert.rejects(() => api.patchNote('NOTE0001', '<p>local</p>', 19), (error: unknown) =>
    error instanceof ZoteroApiError && error.status === 412
  );
  assert.equal(patchHeaders['If-Unmodified-Since-Version'], '19');
});
