# 桌面渠道管理工具（desktop/）验收证据

日期：2026-11-06 · 环境：Windows 11 / Go 1.25.6（go.mod 声明 1.27.3，GOTOOLCHAIN=auto 自动获取）· MyGo v0.7.4

## 测试结果

```
go test ./...   PASS：18 tests（13 逻辑单测 + 5 view 交互测试）
go vet ./...    PASS
go build -ldflags="-H windowsgui" -o moss-config.exe .   PASS（~15.6MB 单文件）
```

## 结果表

| 用例                                             | 验证内容                                                                                    | 实际结果 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------- |
| TestValidateOK / TestValidateCatches（7 子用例） | 交叉校验：空 entries、alias 重复、未知 provider、default 悬空、baseUrl 空/非法、缺 key 来源 | PASS     |
| TestAddEntryRollback                             | 新增渠道；重复 alias 拒绝且回滚；新 provider 一并登记                                       | PASS     |
| TestUpdateEntrySyncsDefault                      | alias 改名同步 default；改名冲突拒绝并回滚                                                  | PASS     |
| TestRemoveEntryOrphanAndDefaultFallback          | 删默认项 default 清空并隐式回退 entries[0]；orphan provider 报告；最后一渠道不可删          | PASS     |
| TestRemoveProviderRequiresNoRefs                 | provider 仍被引用拒绝删除；orphan 可删                                                      | PASS     |
| TestLoadSavePreservesOtherSections               | **yaml.Node 局部替换：保存后其他段（log/persona/session）与注释原样保留，models 修改生效**  | PASS     |
| TestListShowsEntries（view）                     | 列表渲染渠道与默认标记                                                                      | PASS     |
| TestEditFlow（view）                             | 编辑表单改 model → 保存 → 数据更新 + 「已保存」提示                                         | PASS     |
| TestAddFlow（view）                              | 新增渠道写盘（config.yaml 含新 alias）                                                      | PASS     |
| TestAddRequiresAliasAndModel（view）             | 空表单拦截并提示必填                                                                        | PASS     |
| TestDeleteConfirmFlow（view）                    | 删除需二次确认；删默认项回退正确                                                            | PASS     |
| 用户实测                                         | GUI 添加新渠道 → config.yaml 更新 → bot 重启后以新 default 启动（日志确认）                 | PASS     |

## 工程要点

- **不破坏用户配置**：LoadDoc/SaveDoc 用 yaml.Node 树操作，只替换 `models` / `providers` 两个子树，顶层其他 key 的顺序与 HeadComment 原样保留（TestLoadSavePreservesOtherSections 守护）。
- **失败回滚**：Add/Update/Remove 全部先校验后提交，校验失败自动回滚内存状态（单测守护）。
- **测试策略**：逻辑与 UI 分离（config.go / main.go）；view 用 `ui.NewTester` 无窗口点击断言；表单输入框为 `*string` 指针绑定，测试直接写绑定变量（Tester.Type 是光标处追加，不适合替换场景）。
- **Windows 构建**：`-ldflags="-H windowsgui"` 消除双击时的终端窗口（console 子系统默认行为）。
- 仓库卫生：`moss-config.exe`、`desktop/build/`、`config.yaml.bak`、`.idea/` 均已 gitignore；测试夹具一律用 example.com 假数据，无真实端点与密钥。
