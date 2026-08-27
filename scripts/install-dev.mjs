import {copyFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const configuredPluginDir = process.env.ZNB_DEV_PLUGIN_DIR?.trim();
const configuredVault = process.env.ZNB_DEV_VAULT?.trim();
const pluginDir = configuredPluginDir
  ? resolve(configuredPluginDir)
  : configuredVault
    ? resolve(configuredVault, '.obsidian/plugins/zotero-note-bridge')
    : '';

if (!pluginDir) {
  throw new Error('Set ZNB_DEV_PLUGIN_DIR or ZNB_DEV_VAULT before running npm run install:dev.');
}

await mkdir(pluginDir, {recursive: true});
await Promise.all(['main.js', 'manifest.json', 'styles.css'].map((name) =>
  copyFile(resolve(projectRoot, 'dist', name), resolve(pluginDir, name))
));
console.log(`Installed development build in ${pluginDir}`);
