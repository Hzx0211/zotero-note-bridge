# Zotero Note Bridge

[简体中文](README.zh-CN.md)

Zotero Note Bridge is a local-first desktop plugin that keeps a Zotero 10 library usable as structured Markdown in Obsidian. It reads directly from Zotero's Local API, renders reference cards and collection indexes, and safely creates or updates child notes without depending on Zotero Sync for Obsidian.

> Version 2.0.0 is a pre-release. Back up your Vault before migrating an existing library.

## What it syncs

- Zotero → Obsidian: reference cards, nested collection indexes, PDF and Zotero links, original/translated abstracts, and child notes.
- Obsidian → Zotero: explicit creation and update of child notes only.
- Stable managed markers let the plugin replace generated content while preserving text outside the managed region.
- Unpushed drafts survive a pull. Version/hash checks and two-sided backups protect conflicting edits.
- Removed Zotero objects are moved to a dated quarantine directory, never permanently deleted. Restored objects are moved back automatically by Zotero Key.

The plugin intentionally does not modify Zotero bibliographic metadata, execute JavaScript templates, use the Zotero Web API, or install an XPI.

## Requirements

- Obsidian 1.10.0 or newer, desktop only.
- Zotero 10 running on the same computer.
- Zotero's local API on its default loopback address (`127.0.0.1:23119`).

## Install from GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<Vault>/.obsidian/plugins/zotero-note-bridge/`.
3. Put all three files in that directory.
4. Restart Obsidian, then enable **Zotero Note Bridge** under Community plugins.

For [BRAT](https://github.com/TfTHacker/obsidian42-brat), choose **Add a beta plugin** and enter `Hzx0211/zotero-note-bridge`.

New installs start in manual mode. Keep Zotero running and use **Zotero: Preview sync** before **Zotero: Sync now**. The first write to a child note opens Zotero's authorization dialog; choose the permission you want Zotero to remember.

## Commands

- `Zotero: Preview sync`
- `Zotero: Sync now`
- `Zotero child notes: Create in current reference`
- `Zotero child notes: Push note at cursor`
- `Zotero child notes: Push all changes on this page`
- `Zotero child notes: Discard draft at cursor`
- `Zotero child notes: Reauthorize writes`
- `Zotero: Analyze legacy migration`
- `Zotero: Apply legacy migration`

The displayed command language follows the plugin language setting when Obsidian reloads. Some safety dialogs remain bilingual in this pre-release.

## Managed files and safety

Generated reference cards contain:

```markdown
<!-- znb-managed:start -->
...plugin-owned content...
<!-- znb-managed:end -->
```

Put personal prose after the closing marker or in the linked reading note. Collection index files are fully managed. Child-note bodies use their own `zotero-note:start`/`zotero-note:end` markers; edit only inside those blocks before pushing.

The write key is stored only in Obsidian `SecretStorage`. `state.json`, `library-state.json`, and migration backups stay inside the local plugin directory and are excluded from this repository. See [Privacy](docs/PRIVACY.md) and [Migration](docs/MIGRATION.md).

## Development

```bash
npm ci
npm run verify
```

The fixed release output is `dist/main.js`, `dist/manifest.json`, and `dist/styles.css`. To copy a build into a development Vault, set one dedicated environment variable:

```bash
ZNB_DEV_VAULT=/path/to/test-vault npm run install:dev
# or
ZNB_DEV_PLUGIN_DIR=/path/to/test-vault/.obsidian/plugins/zotero-note-bridge npm run install:dev
```

Do not point development installation at a production Vault without a backup.

## License and acknowledgements

Copyright © 2026 Hzx0211. Licensed under [AGPL-3.0-only](LICENSE). See [third-party acknowledgements](THIRD_PARTY_NOTICES.md).
