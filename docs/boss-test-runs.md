# Boss 直聘实战测试记录

## 20260713 登录页风控记录

- 操作：使用 Playwright CDP 连接 Edge 后，通过 `page.goto("https://www.zhipin.com/web/user/?ka=header-login")` 打开 Boss 登录页。
- 结果：页面在 `wait_for_timeout` 阶段被关闭，Playwright 抛出 `TargetClosedError: Target page, context or browser has been closed`。
- 风控判定：符合项目目标中定义的“页面被关闭”风控表现。
- 处理结论：登录页不再使用 Playwright 导航打开，改为由 Microsoft Edge 进程自行打开登录 URL；Playwright 只在用户完成登录后读取 storage state。
- 后续约束：登录、验证码、安全验证等页面只允许用户手动处理，自动化流程不做绕过或规避。

## 20260713-181900 打开登录页

- CDP：`http://127.0.0.1:9222`
- Edge PID：`12480`
- 用户数据目录：`E:\Develop\Aprojects\job-assisstance\runtime\edge-profile`
- 实际 URL：`https://www.zhipin.com/web/user/?ka=header-login`
- 页面标题：`Boss 直聘登录页`
- 截图：``
- 下一步：用户在 Edge 中完成登录，然后点击“保存登录状态”。
## 20260713-182101 登录态保存

- 当前 URL：`https://www.zhipin.com/web/geek/jobs`
- 页面标题：``
- Storage state：`E:\Develop\Aprojects\job-assisstance\runtime\auth\boss_state.json`
- 截图：`E:\Develop\Aprojects\job-assisstance\runtime\screenshots\20260713-182059-auth-state.png`
- 结果：已保存登录态

## 20260713 第二次打开推荐页验证

- 操作：由 Edge 自行打开 `https://www.zhipin.com/web/geek/jobs`，随后通过 Edge DevTools HTTP `/json` 读取当前 target 列表。
- 结果：当前页面仍为 Boss 直聘岗位页，不是登录页，说明 Edge profile 登录态仍然存在。
- 当前 URL：`https://www.zhipin.com/web/geek/jobs?city=101010100`
- 当前标题：`「北京招聘」-2026年北京人才招聘信息 - BOSS直聘`
- 登录态判断：`logged_in_likely`
- 注意：当前页面城市参数为北京，不是上海；需要按页面内期望岗位切换到第三个“算法工程师”，该期望岗位对应上海。

## 20260713 推荐页 CDP 风控记录

- 操作：第二次打开推荐页后，尝试使用 Playwright CDP 附着页面并读取 DOM。
- 结果：在 `Page.wait_for_timeout` 阶段出现 `Target page, context or browser has been closed`。
- 风控判定：符合项目目标中定义的“页面被关闭”风控表现。
- 处理结论：推荐页内容读取优先使用更低侵入的 Edge DevTools HTTP target 列表；需要读取 DOM 或点击时，必须采用 debug 模式逐步验证，不再批量执行 Playwright 页面动作。
## 20260713-182940 Edge target 快照

- CDP：`http://127.0.0.1:9222`
- 原始快照：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-182940-edge-targets.json`

```json
[
  {
    "description": "",
    "devtoolsFrontendUrl": "https://aka.ms/docs-landing-page/serve_rev/@7e26d29c1de8a30a0d502240ae0b2a4b35d19b5f/inspector.html?ws=127.0.0.1:9222/devtools/page/10ED4CE7049B2FB962FD9D6DCE18A984",
    "faviconUrl": "https://static.zhipin.com/favicon.ico",
    "id": "10ED4CE7049B2FB962FD9D6DCE18A984",
    "title": "「北京招聘」-2026年北京人才招聘信息 - BOSS直聘",
    "type": "page",
    "url": "https://www.zhipin.com/web/geek/jobs?city=101010100",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/10ED4CE7049B2FB962FD9D6DCE18A984"
  }
]
```

## 20260713-184842 CDP 安全探测

- 探测范围：只读 CDP 操作，不点击、不输入、不导航。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-184842-cdp-safety-probe.json`

| 步骤 | 结果 | URL | 标题 |
| --- | --- | --- | --- |
| devtools_http_json_before | ok | https://www.zhipin.com/web/geek/jobs | 求职|找工作|招聘信息-BOSS直聘 |
| runtime_1_plus_1 | ok | https://www.zhipin.com/web/geek/jobs | 求职|找工作|招聘信息-BOSS直聘 |
| read_location_and_title | ok | https://www.zhipin.com/web/geek/jobs | 求职|找工作|招聘信息-BOSS直聘 |
| read_body_text_sample | ok | https://www.zhipin.com/web/geek/jobs | 求职|找工作|招聘信息-BOSS直聘 |
| read_intention_like_nodes | ok | https://www.zhipin.com/web/geek/jobs | 求职|找工作|招聘信息-BOSS直聘 |

结论：

1. 原生 CDP WebSocket 只读 `Runtime.evaluate` 未触发页面关闭或回首页。
2. 可以用只读 CDP 读取 `document.body.innerText` 和有限 DOM 结构。
3. 当前页面显示 `算法工程师(上海)` 为激活求职意向。
4. 当前推荐岗位列表已出现上海岗位，因此当前页面可作为上海推荐页主页。
5. 后续可以优先使用原生 CDP 只读 DOM 抓取岗位信息，点击/输入/导航仍需单独实测。
## 20260713-185539 只读抓取第一个岗位

- 操作：原生 CDP `Runtime.evaluate` 只读 DOM，不点击、不输入、不导航。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-185539-first-job-read.json`
- 数据库 job id：`2`
- 安全检查：`ok`
- 页面 URL：`https://www.zhipin.com/web/geek/jobs`
- 页面标题：`求职|找工作|招聘信息-BOSS直聘`
- 激活求职意向：`算法工程师(上海)`

### 岗位字段

- 岗位：感知融合算法工程师
- 公司：采埃孚亚太集团有...
- 薪资：-K·薪
- 城市：上海·嘉定区·安亭
- URL：https://www.zhipin.com/job_detail/bf0a57ab04d0ce450nF829u6FFBU.html

## 20260713-185914 只读抓取第一个岗位

- 操作：原生 CDP `Runtime.evaluate` 只读 DOM，不点击、不输入、不导航。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-185914-first-job-read.json`
- 数据库 job id：`3`
- 安全检查：`ok`
- 页面 URL：`https://www.zhipin.com/web/geek/jobs`
- 页面标题：`求职|找工作|招聘信息-BOSS直聘`
- 激活求职意向：`算法工程师(上海)`

### 岗位字段

- 岗位：感知融合算法工程师
- 公司：采埃孚亚太集团有...
- 薪资：-K·薪
- 解码薪资：25-35K·15薪
- 城市：上海·嘉定区·安亭
- URL：https://www.zhipin.com/job_detail/bf0a57ab04d0ce450nF829u6FFBU.html

## 20260713-190006 只读抓取第一个岗位

- 操作：原生 CDP `Runtime.evaluate` 只读 DOM，不点击、不输入、不导航。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-190006-first-job-read.json`
- 数据库 job id：`4`
- 安全检查：`ok`
- 页面 URL：`https://www.zhipin.com/web/geek/jobs`
- 页面标题：`求职|找工作|招聘信息-BOSS直聘`
- 激活求职意向：`算法工程师(上海)`

### 岗位字段

- 岗位：感知融合算法工程师
- 公司：采埃孚亚太集团有...
- 薪资：-K·薪
- 解码薪资：25-35K·15薪
- 城市：上海·嘉定区·安亭
- URL：https://www.zhipin.com/job_detail/bf0a57ab04d0ce450nF829u6FFBU.html

## 20260713-190105 CDP 求职意向点击测试

- 操作：原生 CDP `Runtime.evaluate` 调用 `a.expect-item.click()`，先切广州，再切回上海。
- 原始结果：`E:\Develop\Aprojects\job-assisstance\runtime\logs\20260713-190105-cdp-click-intention.json`
- 安全检查：`ok`

| 步骤 | 激活项 | URL | 前几个岗位城市 |
| --- | --- | --- | --- |
| before | 算法工程师(上海) | https://www.zhipin.com/web/geek/jobs | 上海·嘉定区·安亭 / 上海·闵行区·浦江 / 上海·杨浦区·五角场 / 上海·浦东新区·张江 / 上海·徐汇区·漕河泾 / 上海·徐汇区·漕河泾 / 上海·浦东新区 / 上海·浦东新区·陆家嘴 |
| click_guangzhou | 大模型算法(广州) | https://www.zhipin.com/web/geek/jobs | 上海·浦东新区·张江 / 广州·黄埔区·东圃 / 杭州·余杭区·未来科技城 / 广州·越秀区·区庄 / 广州·海珠区·琶洲 / 广州·天河区·棠下 / 广州·天河区·棠下 / 深圳·南山区·科技园 |
| click_shanghai | 算法工程师(上海) | https://www.zhipin.com/web/geek/jobs | 上海·嘉定区·安亭 / 上海·闵行区·浦江 / 上海·浦东新区·张江 / 上海·杨浦区·五角场 / 上海·浦东新区·陆家嘴 / 上海·浦东新区·陆家嘴 / 上海·浦东新区 / 上海·普陀区·长寿路 |

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
