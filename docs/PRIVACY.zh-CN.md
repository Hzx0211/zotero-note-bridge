# 隐私说明

Zotero Note Bridge 采用本地优先设计。

- 运行时 API 请求在代码中被限制为 Zotero 本机回环接口 `http://127.0.0.1:23119/api`。插件不访问 Zotero Web API，不包含分析、广告、遥测或远程 AI 服务。
- Zotero 写入授权密钥只通过 Obsidian `SecretStorage` 保存，不会写入 Markdown、设置 JSON、日志或仓库。
- 文献缓存、草稿恢复状态、冲突备份及迁移备份保留在用户本机选择的 Vault/插件目录中。
- 生成的 Markdown 可能包含 Zotero 题录中已有的网页链接。点击链接属于用户主动操作，并不是插件的后台网络请求。

仓库的发布扫描会阻止常见私人文件、PDF、运行时状态、用户主目录路径和明显的凭据进入发布内容，但用户仍需自行确保没有把私人 Vault 内容提交到公开仓库。
