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

## 待补（真机，用户配合）

- [ ] bigmodel.cn 免费注册 → .env 配 ZHIPU_IMAGE_API_KEY → config.yaml imageGeneration.enabled 改 true → 重启
- [ ] TG：「画一只戴墨镜的猫」→ sendPhoto 出图
- [ ] 飞书：同样命令 → 图片消息出图（走素材上传链路）
- [ ] 同会话连画两张 → 第二张收到冷却说明
