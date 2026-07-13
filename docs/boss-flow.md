# Boss 直聘可行操作路径

## 20260713 已确认前置路径

1. 使用 Edge 专用 profile 打开 Boss 登录页。
2. 用户手动完成登录。
3. 通过 CDP 保存 storage state 到 `runtime/auth/boss_state.json`。
4. 第二次由 Edge 自行打开 `https://www.zhipin.com/web/geek/jobs`。
5. 通过 Edge DevTools HTTP `/json` 验证当前页面不是登录页，而是岗位推荐页。

## 20260713 推荐页期望岗位策略

推荐页顶部已有 Boss 直聘侧填写好的期望岗位。当前观测样本包括：

1. 推荐
2. 高性能计算工程师
3. 大模型算法
4. 算法工程师

这些名称只是当前样本，后续实现不能绑定固定岗位名称。期望岗位名称可能变化，必须通过页面结构、位置和 HTML 元素关系识别“期望岗位/求职意向”区域，再遍历该区域下的岗位项。期望岗位不一定对应程序填写的候选城市，不能假设某个期望岗位一定是上海。后续流程应：

1. 打开 `https://www.zhipin.com/web/geek/jobs`。
2. 先读取当前 URL 和页面标题，判断当前城市参数。
3. 查找“期望岗位/求职意向”区域，记录区域容器的 HTML 结构和截图。
4. 遍历该区域下的岗位项元素，记录每个岗位项的位置、文本、可点击元素、关联城市信息和候选选择器。
5. 逐个检查岗位项是否对应程序候选城市。
6. 如果某个岗位项对应程序候选城市，则点击该岗位项。
7. 点击前记录当前 URL、标题和截图。
8. 点击后确认 URL、标题、城市展示或岗位列表已切换到程序候选城市。
9. 如果所有已有岗位项都不对应程序候选城市，则进入页面城市切换流程，将页面城市切换到程序候选城市。
10. 只有确认城市符合程序候选城市后，才开始读取推荐岗位列表。

当前观察到第二次打开时 URL 为 `https://www.zhipin.com/web/geek/jobs?city=101010100`，标题为北京招聘，因此不能直接开始岗位沟通。下一步需要先确认期望岗位区域的 HTML 结构和每个岗位项对应城市；如果都不是上海，则切换页面城市到上海。

## 20260713 CDP 只读探测后的当前状态

使用原生 CDP WebSocket `Runtime.evaluate` 只读页面内容，未触发页面关闭或回首页。当前页面状态：

1. URL：`https://www.zhipin.com/web/geek/jobs`
2. 标题：`求职|找工作|招聘信息-BOSS直聘`
3. 期望岗位区域 selector：`.c-expect-select`
4. 期望岗位项 selector：`a.expect-item`
5. 当前激活项 selector：`a.expect-item.active`
6. 当前激活项文本：`算法工程师(上海)`
7. 岗位列表城市：上海岗位已出现，例如 `上海·嘉定区·安亭`、`上海·闵行区·浦江`、`上海·杨浦区·五角场`。

因此当前页面已经处于符合程序候选城市“上海”的推荐页状态，可以进入“读取第一个推荐岗位 -> 提取 JD/薪资/城市”的下一阶段。
## 20260713-190105 CDP 求职意向点击测试

- 操作：原生 CDP `Runtime.evaluate` 调用 `a.expect-item.click()`，先切广州，再切回上海。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-190105-cdp-click-intention.json`
- 安全检查：`ok`

| 步骤 | 激活项 | URL | 前几个岗位城市 |
| --- | --- | --- | --- |
| before | 算法工程师(上海) | https://www.zhipin.com/web/geek/jobs | 上海·嘉定区·安亭 / 上海·闵行区·浦江 / 上海·杨浦区·五角场 / 上海·浦东新区·张江 / 上海·徐汇区·漕河泾 / 上海·徐汇区·漕河泾 / 上海·浦东新区 / 上海·浦东新区·陆家嘴 |
| click_guangzhou | 大模型算法(广州) | https://www.zhipin.com/web/geek/jobs | 上海·浦东新区·张江 / 广州·黄埔区·东圃 / 杭州·余杭区·未来科技城 / 广州·越秀区·区庄 / 广州·海珠区·琶洲 / 广州·天河区·棠下 / 广州·天河区·棠下 / 深圳·南山区·科技园 |
| click_shanghai | 算法工程师(上海) | https://www.zhipin.com/web/geek/jobs | 上海·嘉定区·安亭 / 上海·闵行区·浦江 / 上海·浦东新区·张江 / 上海·杨浦区·五角场 / 上海·浦东新区·陆家嘴 / 上海·浦东新区·陆家嘴 / 上海·浦东新区 / 上海·普陀区·长寿路 |

结论：求职意向切换可以优先使用原生 CDP `Runtime.evaluate` 调用页面自身的 `a.expect-item.click()`。该方式比坐标键鼠更稳定，当前实测未触发风控。切换后必须读取 `a.expect-item.active` 和 `.company-location` 做结果校验。

## 20260713 薪资解码规则

Boss DOM 中薪资使用私有 Unicode 数字，需要通过 `app/salary.py` 解码后再判断最低薪资。

当前第一条岗位 `-K·薪` 已解码为 `25-35K·15薪`，最低薪资为 `25k`，满足默认期望薪资 `20k+`。
## 20260713-191058 本地匹配候选并点击立即沟通检测

- OpenAI 匹配状态：接口返回 403 error code 1010，本次未完成 OpenAI 远程匹配。
- 本次前置：使用本地硬规则选择上海、20k+、包含 AI/Agent/应用开发关键词的候选岗位。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-191058-match-click-immediate.json`
- 安全检查：`ok`

### 候选岗位

- index：3
- 岗位：大模型应用开发
- 城市：上海·杨浦区·五角场
- 薪资下限：25k
- URL：https://www.zhipin.com/job_detail/cdeb1325c7637a9f0nB90tW1FVdR.html

### 立即沟通点击后检测

- 点击结果：not clicked
- 点击后 URL：https://www.zhipin.com/web/geek/jobs
- 点击后标题：求职|找工作|招聘信息-BOSS直聘
- 弹窗文本：未检测到标准 dialog/modal/popover 文本
- 关键按钮：

## 20260713-191159 本地匹配候选并点击立即沟通检测

- OpenAI 匹配状态：接口返回 403 error code 1010，本次未完成 OpenAI 远程匹配。
- 本次前置：使用本地硬规则选择上海、20k+、包含 AI/Agent/应用开发关键词的候选岗位。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-191159-match-click-immediate.json`
- 安全检查：`ok`

### 候选岗位

- index：3
- 岗位：大模型应用开发
- 城市：上海·杨浦区·五角场
- 薪资下限：25k
- URL：https://www.zhipin.com/job_detail/cdeb1325c7637a9f0nB90tW1FVdR.html

### 立即沟通点击后检测

- 点击结果：clicked
- 点击后 URL：https://www.zhipin.com/web/geek/jobs
- 点击后标题：求职|找工作|招聘信息-BOSS直聘
- 弹窗文本：拖拽文件到这里简历建议使用 PDF 文件，也支持DOC、DOCX、JPG、PNG 格式文件大小不超过20M上传附件简历 没有附件简历 在线填写 | 拖拽文件到这里简历建议使用 PDF 文件，也支持DOC、DOCX、JPG、PNG 格式文件大小不超过20M上传附件简历 没有附件简历 在线填写 | 拖拽文件到这里简历建议使用 PDF 文件，也支持DOC、DOCX、JPG、PNG 格式文件大小不超过20M上传附件简历 没有附件简历 在线填写 | RESUME上传简历通过简历展示你的基本资料及经历EXPORT发送在线简历在线简历以文件形式发送至Boss | RESUME上传简历通过简历展示你的基本资料及经历EXPORT发送在线简历在线简历以文件形式发送至Boss | RESUME上传简历通过简历展示你的基本资料及经历EXPORT发送在线简历在线简历以文件形式发送至Boss | 请选择城市 | 请选择城市 | 请选择城市 | 已向BOSS发送消息 我对感知融合算法工程师很感兴趣，希望可以深聊，谢谢！ 如需修改打招呼内容，请在【消息通知-设置招呼语】页面修改 留在此页继续沟通
- 关键按钮：简历 / AI简历 智能简历生成 / 简历更新 自动识别新简历 / 附件简历制作 打动HR的专业简历 / 附件上传 快速投递心仪职位 / 个人中心查看面试投递状态、编辑在线简历 / 退出登录 / 投递简历 / 立即沟通 / 上传附件简历 / 继续沟通

## 20260713-191452 本地匹配候选并点击立即沟通检测

- OpenAI 匹配状态：接口返回 403 error code 1010，本次未完成 OpenAI 远程匹配。
- 本次前置：使用本地硬规则选择上海、20k+、包含 AI/Agent/应用开发关键词的候选岗位。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-191452-match-click-immediate.json`
- 安全检查：`ok`

### 候选岗位

- index：3
- 岗位：大模型应用开发
- 城市：上海·杨浦区·五角场
- 薪资下限：25k
- URL：https://www.zhipin.com/job_detail/cdeb1325c7637a9f0nB90tW1FVdR.html

### 立即沟通点击后检测

- 点击结果：not clicked
- 保护结果：blocked 详情岗位未切换到候选岗位：candidate=大模型应用开发, detailTitle=感知融合算法工程师
- 点击后 URL：https://www.zhipin.com/web/geek/jobs
- 点击后标题：求职|找工作|招聘信息-BOSS直聘
- 弹窗文本：未检测到标准 dialog/modal/popover 文本
- 关键按钮：

## 20260713-192857 匹配-立即沟通-发消息实测

- 模式：dry-run，不点击立即沟通
- 原始日志：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-192857-match-communicate-send.json`
- 安全检查：ok
- 候选岗位：大模型应用开发 / 上海·杨浦区·五角场 / minK=25
- AI 匹配：false
- AI 理由：城市和薪资符合，且涉及 Agent、RAG、Function Calling，但岗位核心是大模型训练、微调与推理优化，要求 PyTorch、CUDA、vLLM、TensorRT-LLM及分布式训练经验；候选人主要优势在 AI 应用、RAG/GraphRAG 与后端工程化，且近2年经验低于3-5年要求，不建议自动沟通。
- 生成消息：
- 立即沟通保护：blocked AI 匹配结果不是 true
- 立即沟通结果：not clicked dry_run
- 继续沟通结果：not clicked dry_run
- 自定义消息发送：not sent dry_run
## 20260713-193034 匹配-立即沟通-发消息实测

- 模式：dry-run，不点击立即沟通
- 原始日志：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-193034-match-communicate-send.json`
- 安全检查：ok
- 候选岗位：Agent 技术工程师(A65384) / 上海·浦东新区·陆家嘴 / minK=30
- AI 匹配：true
- AI 理由：薪资与上海地点均符合预期，岗位核心涉及 Agent、Workflow、Memory、Tool Use、MCP、Function Calling、RAG、Embedding、知识库检索及工具平台开发，与候选人的 Python 后端、LangGraph/LangChain、RAG/GraphRAG 和 Agent 工程化经验高度匹配。虽候选人近2年经验与岗位要求3-5年存在一定差距，但项目覆盖度较高，值得立即沟通。
- 生成消息：您好，AI判断我的背景与岗位较匹配。我有近2年AI应用交付经验，熟悉Python、Agent工作流、MCP、Function Calling及RAG工程化。虽年限略有差距，但项目方向契合，期待进一步沟通。
- 立即沟通保护：allowed ok
- 立即沟通结果：not clicked dry_run
- 继续沟通结果：not clicked dry_run
- 自定义消息发送：not sent dry_run
## 20260713-193538 聊天页发送 AI 自定义消息

- 原始日志：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-193538-boss-chat-send-message.json`
- 消息来源：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-193034-match-communicate-send.json`
- 候选岗位：Agent 技术工程师(A65384)
- 页面 URL：https://www.zhipin.com/web/geek/chat
- 发送结果：sent message_visible_after_send
- 消息：您好，AI判断我的背景与岗位较匹配。我有近2年AI应用交付经验，熟悉Python、Agent工作流、MCP、Function Calling及RAG工程化。虽年限略有差距，但项目方向契合，期待进一步沟通。

## 20260713 真实匹配、立即沟通、发送消息成功路径

实测成功路径：

1. 使用 Edge DevTools HTTP `/json` 获取当前 Boss page target。
2. 使用原生 CDP WebSocket 连接 target。
3. 读取推荐页 DOM，筛选上海、最低薪资 20k+、包含 AI/Agent/应用开发关键词的候选岗位。
4. 对候选岗位逐个点击 `.job-card-wrap a.job-name`，等待详情区切换。
5. 校验 `.job-card-wrap.active a.job-name`、active href、`.job-detail-container .job-name` 均对应候选岗位。
6. 将详情页岗位快照保存到 `runtime/logs/*-selected-job-snapshot.json`。
7. 调用 OpenAI-compatible API 做岗位匹配和消息生成。
8. 只有 AI `matched=true` 且“立即沟通”按钮不含 `is-disabled` 时，点击 `.job-detail-container .op-btn.op-btn-chat`。
9. 点击后 Boss 会自动发送默认招呼语，并展示 `.greet-boss-dialog`。
10. 点击 `.greet-boss-dialog .sure-btn` 进入 `https://www.zhipin.com/web/geek/chat`。
11. 页面导航会让旧 CDP evaluate 可能报 `Inspected target navigated or closed`，需要重新读取 `/json` 并重连 target。
12. 在聊天页确认目标岗位名可见，填入 `#chat-input.chat-input`，等待“发送”按钮 class 不含 `disabled` 后点击发送。

本次实战结果：

1. 被 AI 拒绝的岗位包括“大模型应用开发”，理由是核心偏大模型训练/推理优化，与候选人 AI 应用/RAG/Agent 后端工程化方向不完全一致。
2. AI 匹配通过岗位：`Agent 技术工程师(A65384)`，公司 `Soul App`，地点 `上海·浦东新区·陆家嘴`，薪资 `30-35K·16薪`。
3. 默认 Boss greeting 已发送：`我对Agent 技术工程师(A65384)很感兴趣，希望可以深聊，谢谢！`
4. AI 自定义消息已发送并在聊天页显示为送达。
5. 发送成功日志：`runtime/logs/20260713-193538-boss-chat-send-message.json`
