import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname);
const outputDir = resolve(projectRoot, 'dist');

await mkdir(outputDir, {recursive: true});
await build({
  entryPoints: [resolve(projectRoot, 'src/main.ts')],
  bundle: true,
  external: ['obsidian', 'electron', 'node:http', 'node:crypto', '@codemirror/*'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: resolve(outputDir, 'main.js'),
  sourcemap: false,
  logLevel: 'info'
});

await Promise.all([
  copyFile(resolve(projectRoot, 'manifest.json'), resolve(outputDir, 'manifest.json')),
  copyFile(resolve(projectRoot, 'styles.css'), resolve(outputDir, 'styles.css'))
]);
