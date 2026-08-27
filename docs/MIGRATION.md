# Migration from the legacy two-plugin setup

This path is for a Vault that previously used Zotero Sync for Obsidian together with Zotero Note Bridge 1.x.

1. Keep the old sync plugin installed and enabled. Do not delete its cache.
2. Install Zotero Note Bridge 2.0.0 over the existing `zotero-note-bridge` plugin directory. Leave `state.json` in place.
3. Start Zotero, reload Obsidian, and run **Zotero: Analyze legacy migration**. This is read-only and lists every planned file difference.
4. Check the reference-card count, Zotero Keys, path moves, child-note drafts, and quarantine operations.
5. Run **Zotero: Apply legacy migration**. The plugin asks for confirmation, records SHA-256 hashes, backs up every file it will change plus legacy configuration/state, then performs the migration.
6. Only after the new pull, file application, cache write, and draft scan succeed does the plugin remove `zotero-sync-client` from Obsidian's enabled-plugin list. Its installed files and cache remain available for rollback.

Migration backups are stored under `.obsidian/plugins/zotero-note-bridge/backups/<timestamp>/`. To roll back, close Obsidian, restore files listed in that backup's `manifest.json`, restore the old installed plugin build, and re-enable the legacy plugin.

Files newly discovered through Zotero's live Local API can make the post-migration card count higher than an old sync cache. The read-only report is the source of truth; it does not mutate the old cache.
