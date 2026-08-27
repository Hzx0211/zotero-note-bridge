import {readdir, readFile, stat} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'dist']);
const forbiddenNames = new Set(['state.json', 'library-state.json']);
const forbiddenSegments = new Set(['References', 'backups']);
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.txt', '.yaml', '.yml'
]);
const findings = [];

function extension(path) {
  const match = /\.[^.\/]+$/.exec(path);
  return match?.[0].toLowerCase() ?? '';
}

async function visit(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (ignored.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    const local = relative(root, absolute);
    const segments = local.split(sep);
    if (forbiddenNames.has(entry.name) || segments.some((part) => forbiddenSegments.has(part)) || /\.pdf$/i.test(entry.name)) {
      findings.push(`${local}: forbidden private artifact`);
      continue;
    }
    if (entry.isDirectory()) {
      await visit(absolute);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(extension(local))) continue;
    const info = await stat(absolute);
    if (info.size > 2_000_000) continue;
    const text = await readFile(absolute, 'utf8');
    const checks = [
      [/\/Users\/[A-Za-z0-9._-]+\//g, 'macOS home path'],
      [/[A-Za-z]:\\\\Users\\\\[^\\\s]+\\/g, 'Windows home path'],
      [/\b(?:api[_-]?key|token|secret)\b\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/gi, 'possible credential'],
      [/zotero-server-id\s*[:=]\s*["'][^"']+["']/gi, 'Zotero Server ID']
    ];
    for (const [pattern, label] of checks) {
      if (pattern.test(text)) findings.push(`${local}: ${label}`);
    }
  }
}

await visit(root);
if (findings.length) {
  console.error(`Release scan failed:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Release scan passed: no Vault content, PDFs, runtime state, private paths, or obvious credentials found.');
}
