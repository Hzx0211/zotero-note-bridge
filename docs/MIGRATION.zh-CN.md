# 从旧版双插件方案迁移

本流程适用于此前同时使用 Zotero Sync for Obsidian 与 Zotero Note Bridge 1.x 的 Vault。

1. 保持旧同步插件已安装且启用，不要删除它的缓存。
2. 把 Zotero Note Bridge 2.0.0 安装到已有的 `zotero-note-bridge` 插件目录，不要移除 `state.json`。
3. 启动 Zotero、重新加载 Obsidian，执行“Zotero：分析旧版迁移”。该命令只读运行，并逐项列出所有计划修改。
4. 核对文献卡数量、Zotero Key、路径移动、子笔记草稿和隔离操作。
5. 执行“Zotero：执行旧版迁移”。确认后，插件会记录 SHA-256，备份每一个即将修改的文件以及旧配置/私有状态，再实施迁移。
6. 只有新的拉取、文件变更、缓存写入和草稿扫描全部成功后，插件才会从 Obsidian 的启用列表中移除 `zotero-sync-client`。旧插件文件和缓存仍会保留，可用于回滚。

迁移备份位于 `.obsidian/plugins/zotero-note-bridge/backups/<时间戳>/`。若需回滚，请关闭 Obsidian，按备份目录中的 `manifest.json` 恢复文件，恢复旧插件构建，并重新启用旧插件。

Zotero 实时 Local API 可能发现旧同步缓存没有收录的文献，因此迁移后的卡片数可能增加。只读迁移报告才是迁移时的依据；新插件不会改写旧缓存。
