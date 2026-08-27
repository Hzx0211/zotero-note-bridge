# Privacy

Zotero Note Bridge is local-first.

- Runtime API traffic is limited by code to `http://127.0.0.1:23119/api`, Zotero's loopback-only Local API. The plugin does not call Zotero Web API, analytics, advertising, telemetry, or remote AI services.
- The Zotero write authorization key is stored through Obsidian `SecretStorage`; it is not written to Markdown, settings JSON, logs, or the repository.
- Library cache, draft recovery state, conflict backups, and migration backups remain inside the local Vault/plugin directories selected by the user.
- Generated Markdown may contain bibliographic URLs supplied by Zotero. Clicking such a link is a user-initiated action handled by Obsidian or the operating system, not background synchronization by this plugin.

The repository's release scanner rejects common private artifacts, PDFs, runtime state, home-directory paths, and obvious credentials. Users are still responsible for excluding their own Vault content from public repositories.
