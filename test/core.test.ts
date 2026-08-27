import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockAtOffset,
  extractReferenceKey,
  insertNoteBlock,
  isDirty,
  noteContentHash,
  parseNoteBlocks,
  reconcileDraftAction,
  renderNoteBlock,
  replaceBlock
} from '../src/core';
import {localApiSecretId} from '../src/zotero-api';

const remote = {
  key: 'I36RQ2SH',
  parent: 'KBZRTC5K',
  version: 4265,
  baseHash: noteContentHash('原始内容')
};

test('hash normalization is shared across CRLF and surrounding whitespace', () => {
  assert.equal(noteContentHash('  A\r\nB  '), noteContentHash('A\nB'));
  assert.equal(noteContentHash(''), '811c9dc59e3779b9');
});

test('uses an Obsidian-compatible SecretStorage ID for Zotero authorization', () => {
  const id = localApiSecretId('LHVNBnnUfF5x');
  assert.equal(id, 'zotero-note-bridge-lhvnbnnuff5x-local-api-key');
  assert.match(id, /^[a-z0-9-]{1,64}$/);
});

test('renders and parses a stable child-note block', () => {
  const rendered = renderNoteBlock(remote, '原始内容');
  const blocks = parseNoteBlocks(rendered);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]?.metadata, remote);
  assert.equal(blocks[0]?.content, '原始内容');
  assert.equal(isDirty(blocks[0]!), false);
  assert.equal(blockAtOffset(blocks, rendered.indexOf('原始内容'))?.id, remote.key);
});

test('detects edits and replaces metadata after a successful push', () => {
  const rendered = renderNoteBlock(remote, '用户改动');
  const block = parseNoteBlocks(rendered)[0]!;
  assert.equal(isDirty(block), true);
  const accepted = {...remote, version: 4300, baseHash: noteContentHash('用户改动')};
  const next = replaceBlock(rendered, block, accepted, '用户改动');
  const parsed = parseNoteBlocks(next)[0]!;
  assert.equal(parsed.metadata.version, 4300);
  assert.equal(isDirty(parsed), false);
});

test('accepts an intentional user revert without weakening external overwrite protection', () => {
  const draft = {
    metadata: remote,
    content: '用户改动'
  };
  const reverted = parseNoteBlocks(renderNoteBlock(remote, '原始内容'))[0]!;
  assert.equal(reconcileDraftAction(reverted, draft, true), 'discard-draft');
  assert.equal(reconcileDraftAction(reverted, draft, false), 'restore-draft');
});

test('continues capturing user edits and flags changed remote baselines', () => {
  const draft = {metadata: remote, content: '旧的本地草稿'};
  const edited = parseNoteBlocks(renderNoteBlock(remote, '新的本地草稿'))[0]!;
  assert.equal(reconcileDraftAction(edited, draft, true), 'capture-current');

  const changedRemote = {
    ...remote,
    version: remote.version + 1,
    baseHash: noteContentHash('Zotero 新内容')
  };
  const cleanRemote = parseNoteBlocks(renderNoteBlock(changedRemote, 'Zotero 新内容'))[0]!;
  assert.equal(reconcileDraftAction(cleanRemote, draft, true), 'conflict');
});

test('inserts a local draft by replacing only the empty placeholder', () => {
  const card = `---\ntype: zotero-reference\nzotero_key: "KBZRTC5K"\n---\n\n## Zotero 子笔记\n\n- 暂无 Zotero 子笔记\n\n## 个人阅读笔记\n`;
  const local = {
    localId: 'local-test-1',
    parent: 'KBZRTC5K',
    version: 0,
    baseHash: noteContentHash('')
  };
  const next = insertNoteBlock(card, renderNoteBlock(local, '草稿'));
  assert.equal(next.includes('- 暂无 Zotero 子笔记'), false);
  assert.equal(next.includes('## 个人阅读笔记'), true);
  assert.equal(extractReferenceKey(next), 'KBZRTC5K');
  assert.equal(parseNoteBlocks(next)[0]?.metadata.localId, 'local-test-1');
});

test('ignores malformed metadata instead of treating it as writable', () => {
  const malformed = `### Zotero 子笔记 · bad\n<!-- zotero-note:start {"key":"BAD","parent":"KBZRTC5K","version":1,"baseHash":"x"} -->\ntext\n<!-- zotero-note:end -->`;
  assert.deepEqual(parseNoteBlocks(malformed), []);
});
