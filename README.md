# Job Assistance

Boss 直聘自动化求职助手。项目通过 Microsoft Edge CDP 控制已登录浏览器，读取推荐岗位，调用 OpenAI-compatible API 判断岗位匹配度，并在匹配时完成“立即沟通”和首条自定义消息发送。

## 功能

- 使用 Edge 专用 profile 保存 Boss 直聘登录态。
- 读取 Boss 推荐页的求职意向、职位卡片和详情页信息。
- 解码 Boss 私有字体薪资数字。
- 按城市、最低薪资和关键词做本地初筛。
- 使用 OpenAI-compatible API 做岗位匹配判断。
- 只有 AI 判定匹配时才触发“立即沟通”。
- 检测“立即沟通”后的 greeting 弹窗，并进入聊天页发送自定义消息。
- 将页面快照、匹配结果、发送结果写入日志和 SQLite。

## 当前默认配置

- 城市：上海
- 最低期望薪资：20k+
- 目标方向：AI 应用开发、AI Agent、RAG、GraphRAG、智能体工程化、AI 后端
- Boss 每日沟通上限：150

## 环境要求

- Windows
- Python 3.12+
- Node.js 24+
- Microsoft Edge
- `uv`

## 安装

```powershell
uv sync
```

## 配置

复制 `.env.example` 为 `.env`，填写 OpenAI-compatible API 配置：

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=你的 key
OPENAI_MODEL=gpt-4.1-mini
EDGE_CDP_URL=http://127.0.0.1:9222
DAILY_CONTACT_LIMIT=150
```

不要提交 `.env`。仓库已通过 `.gitignore` 排除 `.env`、登录态、数据库、日志、截图和 Edge profile。

## 登录

启动 Edge 登录 Boss：

```powershell
.\.venv\Scripts\python.exe scripts\open_boss_login.py
```

在 Edge 中手动完成登录后保存登录态：

```powershell
.\.venv\Scripts\python.exe scripts\save_boss_auth.py
```

后续开发使用同一个 Edge profile，避免重复登录。

## 实战流程

推荐先 dry-run。dry-run 会读取岗位、调用 AI 匹配并生成消息，但不会点击“立即沟通”：

```powershell
node scripts\run_boss_match_communicate_send.mjs
```

确认日志中 `guard.ok=true` 后，执行真实发送：

```powershell
node scripts\run_boss_match_communicate_send.mjs --send
```

如果真实流程在点击“继续沟通”后遇到页面导航导致 CDP target 失效，可以在聊天页继续发送最新 matched 消息：

```powershell
node scripts\send_boss_chat_message.mjs
```

## 消息格式

首条自定义消息由固定文案和 AI 生成片段组成：

```text
您好，这是我本人开发的自动化求职程序发来的消息。

AI 对岗位匹配度的判断如下：
这里是 AI 生成的正向匹配点，只说明匹配处，不说明负面或不足。
```

提示词位于 `prompts/`：

- `job_match_system.txt`
- `job_match_user.txt`
- `message_generate_system.txt`
- `message_generate_user.txt`

## 已验证的 Boss 页面路径

关键选择器：

- 推荐页：`https://www.zhipin.com/web/geek/jobs`
- 职位卡片：`.job-card-wrap`
- 职位详情切换点击点：`.job-card-wrap a.job-name`
- 当前激活卡片：`.job-card-wrap.active`
- 详情容器：`.job-detail-container`
- 立即沟通：`.job-detail-container .op-btn.op-btn-chat`
- 发送成功弹窗：`.greet-boss-dialog`
- 继续沟通：`.greet-boss-dialog .sure-btn`
- 聊天页：`https://www.zhipin.com/web/geek/chat`
- 聊天输入框：`#chat-input.chat-input`
- 发送按钮：文本为 `发送` 的 `button`

重要行为：

- 点击 `.job-card-wrap` 容器不稳定，实测应点击 `a.job-name`。
- 点击“立即沟通”会先发送 Boss 默认招呼语，再出现 `.greet-boss-dialog`。
- 点击“继续沟通”会导航到聊天页，旧 CDP evaluate 可能报 `Inspected target navigated or closed`，需要重连 target。
- 页面回首页或页面关闭视为风控，脚本应停止并记录日志。

## 文档与日志

- 项目目标：`项目目标.md`
- 流程记录：`docs/boss-flow.md`
- 选择器记录：`docs/boss-selectors.md`
- 测试记录：`docs/boss-test-runs.md`
- 页面记录：`docs/boss-pages.md`
- 运行日志：`runtime/logs/`，默认不提交

## 验证

```powershell
node --check scripts\run_boss_match_communicate_send.mjs
node --check scripts\send_boss_chat_message.mjs
.\.venv\Scripts\python.exe -m compileall app scripts
```
