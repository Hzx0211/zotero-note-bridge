# Zotero Note Bridge

[English](README.md)

Zotero Note Bridge 是一个本地优先的 Obsidian 桌面插件：它直接读取 Zotero 10 Local API，将文献库生成成结构化 Markdown，并在不依赖 Obsidian Zotero Sync 插件的情况下，安全地新建或更新 Zotero 子笔记。

> `2.0.0` 为预发布版本。迁移已有文献库前，请先备份 Vault。

## 同步内容

- Zotero → Obsidian：文献卡、多层分类索引、PDF/Zotero 链接、原文及翻译摘要、子笔记。
- Obsidian → Zotero：仅在用户明确执行命令时新建或更新子笔记。
- 稳定的 managed markers 让插件只替换受管内容，marker 外的个人内容会保留。
- 未推送草稿不会被拉取覆盖；写入前校验 Zotero version/hash，冲突时先备份双方内容。
- Zotero 中消失的对象只会移入按日期划分的隔离目录，不会永久删除；对象恢复后按 Zotero Key 自动移回。

本插件不会反向修改 Zotero 题录元数据，不执行 JavaScript 模板，不访问 Zotero Web API，也不安装 XPI。

## 环境要求

- Obsidian 1.10.0 或更高版本，仅支持桌面端。
- 同一台电脑上运行 Zotero 10。
- 使用 Zotero 默认本机接口 `127.0.0.1:23119`。

## 从 GitHub Release 安装

1. 从最新 Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 创建 `<你的 Vault>/.obsidian/plugins/zotero-note-bridge/`。
3. 把三个文件放入该目录。
4. 重启 Obsidian，在“第三方插件”中启用 **Zotero Note Bridge**。

使用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 时，选择 **Add a beta plugin**，仓库填写 `Hzx0211/zotero-note-bridge`。

新安装默认只手动同步。保持 Zotero 运行，先执行“Zotero：预览同步”，确认后再执行“Zotero：立即同步”。第一次写入子笔记时 Zotero 会弹出授权窗口。

## 公开命令

- `Zotero：预览同步`
- `Zotero：立即同步`
- `Zotero 子笔记：在当前文献中新建笔记`
- `Zotero 子笔记：推送光标所在笔记`
- `Zotero 子笔记：推送本页全部改动`
- `Zotero 子笔记：放弃光标所在未推送改动`
- `Zotero 子笔记：重新授权写入`
- `Zotero：分析旧版迁移`
- `Zotero：执行旧版迁移`

命令显示语言会在 Obsidian 重新加载插件后跟随插件语言设置。这个预发布版本中的部分安全提示仍采用双语或中文。

## 受管文件与安全约束

生成的文献卡包含：

```markdown
<!-- znb-managed:start -->
...插件管理的内容...
<!-- znb-managed:end -->
```

个人内容应写在结束 marker 之后，或写入文献卡链接的独立阅读笔记。分类索引由插件完全管理。子笔记正文使用独立的 `zotero-note:start` / `zotero-note:end` marker；推送前只编辑 marker 内部。

写入密钥只保存在 Obsidian `SecretStorage`。`state.json`、`library-state.json` 和迁移备份只留在本机插件目录，不会进入本仓库。详见[隐私说明](docs/PRIVACY.zh-CN.md)和[迁移指南](docs/MIGRATION.zh-CN.md)。

## 开发

```bash
npm ci
npm run verify
```

发布构建固定输出为 `dist/main.js`、`dist/manifest.json`、`dist/styles.css`。开发安装必须显式设置专用环境变量：

```bash
ZNB_DEV_VAULT=/path/to/test-vault npm run install:dev
# 或
ZNB_DEV_PLUGIN_DIR=/path/to/test-vault/.obsidian/plugins/zotero-note-bridge npm run install:dev
```

不要在没有备份的情况下把开发安装路径指向正式 Vault。

## 许可证与致谢

Copyright © 2026 Hzx0211。项目采用 [AGPL-3.0-only](LICENSE) 许可证，第三方项目见[致谢文件](THIRD_PARTY_NOTICES.md)。
