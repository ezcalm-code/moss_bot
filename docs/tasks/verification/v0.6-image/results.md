# v0.6 图像生成（智谱 CogView-3-Flash）验证记录

日期：2026-11-10 · 215 测试全绿（新增 ~18 用例）· CI 绿（1d7620d）

## 单测覆盖

| 块 | 用例 | 结果 |
|---|---|---|
| ChatCooldown 抽取 | 冷却命中/同轮放行/过期放行/release 回滚/跨 key 隔离 | PASS |
| web_search 重构回归 | 16 用例零改动全绿（行为不变） | PASS |
| 智谱 provider | URL/body 断言、baseUrl 覆盖、非 2xx 抛 ZhipuHttpError（429 分层）、空 data 抛错 | PASS |
| ImageService | 成功→sender 收 url；冷却命中（同轮也冷却）不重复生成；provider 抛错转失败说明；无 sender 返回不支持；sender 失败冒泡 | PASS |
| generate_image 工具 | 缺 prompt 参数错误 | PASS |
| config | imageGeneration 段默认值、enabled+缺 key 启动报错（resolveConfig） | PASS |

## 冷却语义决策记录

- 生图与搜索的冷却语义刻意不同：**生图同轮也冷却**（连画多张烧免费额度），搜索同轮放行（agent 连招合法）——由 ChatCooldown 的调用方决定是否传 turnId 放行
- 生成失败**不回滚**冷却（请求已到达厂商、免费档也计次），防失败场景反复重试

## 真机验收（2026-11-10，用户操作 + 日志核验）

- [x] bigmodel.cn 免费注册 → key 配置 → enabled=true，直探接口 200 出图链接
- [x] TG 画图 → sendPhoto 出图成功（日志 09:33:33 generate_image 完成）
- [x] 飞书画图 → 图片消息出图成功（日志 09:38:49 generate_image 完成，走下载+素材上传链路）
- [x] 同会话第二次触发收到冷却提示（09:26 冷却命中日志）——首图失败烧窗语义一并验证

### 过程坑（已修复）

- 飞书图片素材上传 400：应用缺 `im:resource:upload` / `im:resource` 权限（错误码 99991672）——用户后台开通 + 发版后通过
- 教训：**SDK 报错只有裸 400 不带响应体**——sendImage 已增强为把服务端 msg/error 详情带进错误信息，权限类问题一眼定位
