# Boss 直聘选择器候选

## 20260713 期望岗位区域选择器原则

不能依赖固定岗位名称作为主选择器。当前名称“高性能计算工程师”“大模型算法”“算法工程师”只能用于人工校验或兜底验证。

后续应优先记录和使用：

1. 期望岗位区域的父级容器选择器。
2. 该区域下每个岗位项的重复结构。
3. 岗位项内岗位名称、城市、状态、可点击元素之间的相对关系。
4. 岗位项在区域内的位置索引。
5. 点击前后的 URL、标题、城市展示或岗位列表变化。

选择器候选需要至少包含：

1. 容器级 CSS selector。
2. 岗位项级 CSS selector。
3. 可点击子元素 selector。
4. 文本/role 定位作为辅助验证。
5. 失败时的城市切换入口 selector。

## 20260713 CDP 只读探测得到的选择器候选

原生 CDP WebSocket `Runtime.evaluate` 只读 DOM 未触发页面关闭或回首页。当前页面可用结构如下：

1. 推荐页主体：`.page-jobs-main`
2. 期望岗位和搜索区域：`.expect-and-search`
3. 期望岗位内层：`.expect-search-inner`
4. 期望岗位区域：`.c-expect-select`
5. 期望岗位列表：`.expect-list`
6. 期望岗位项：`a.expect-item`
7. 当前激活期望岗位项：`a.expect-item.active`
8. 期望岗位项文本：`a.expect-item .text-content`
9. 推荐入口：`a.synthesis`
10. 岗位列表容器：`.job-list-container`
11. 岗位卡片：`.job-card-wrap`
12. 岗位名称链接：`a.job-name`
13. 公司和地点区域：`.job-card-footer`
14. 岗位城市：`.company-location`

当前期望岗位项样本：

1. `高性能计算工程师(北京)`
2. `大模型算法(广州)`
3. `算法工程师(上海)`

程序应从 `a.expect-item .text-content` 的完整文本中解析城市，例如括号内的 `北京`、`广州`、`上海`，再与程序候选城市匹配。

当前页面中 `a.expect-item.active` 为 `算法工程师(上海)`，岗位列表城市均为上海，说明此状态可以作为上海推荐页主页。

## 20260713 CDP 操作安全分级

已实测安全：

1. Edge DevTools HTTP `/json` 读取 target 列表。
2. 原生 CDP WebSocket 连接页面 target。
3. `Runtime.evaluate` 执行 `1 + 1`。
4. `Runtime.evaluate` 读取 `location.href` 和 `document.title`。
5. `Runtime.evaluate` 读取 `document.body.innerText` 样本。
6. `Runtime.evaluate` 查询 DOM 结构并返回有限字段，例如 tag、text、className、href、role。
7. `Runtime.evaluate` 调用 `a.expect-item.click()` 切换求职意向；当前已实测广州、上海之间切换后未触发页面关闭或回首页。

已实测有风险：

1. Playwright CDP `page.goto` 打开登录页：页面被关闭。
2. Playwright CDP 附着推荐页后等待/读取：页面被关闭。

未测试，暂不认为安全：

1. CDP `Runtime.evaluate` 触发“立即沟通”等业务动作按钮 `.click()`。
2. CDP `Input.dispatchMouseEvent`。
3. CDP 导航类命令。
4. Playwright 页面操作。

## 20260713 Boss 薪资私有字体映射

Boss 推荐页薪资文本在 DOM 中使用私有 Unicode 字符显示数字，需要先解码再做薪资判断。

当前实测映射：

| 私有字符 | 数字 |
| --- | --- |
| `\ue031` | 0 |
| `\ue032` | 1 |
| `\ue033` | 2 |
| `\ue034` | 3 |
| `\ue035` | 4 |
| `\ue036` | 5 |
| `\ue037` | 6 |
| `\ue038` | 7 |
| `\ue039` | 8 |
| `\ue030` | 9 |

验证样本：

1. `-K·薪` -> `25-35K·15薪`
2. `-K` -> `12-20K`
3. `-K·薪` -> `25-40K·13薪`
4. `-K·薪` -> `20-40K·15薪`

代码位置：`app/salary.py`

## 20260713 真实沟通链路新增选择器

当前实测可用的关键选择器：

1. 职位卡片：`.job-card-wrap`
2. 职位详情切换点击点：`.job-card-wrap a.job-name`
3. 当前激活卡片：`.job-card-wrap.active`
4. 详情容器：`.job-detail-container`
5. 详情标题：`.job-detail-container .job-name`
6. 立即沟通按钮：`.job-detail-container .op-btn.op-btn-chat`
7. 发送成功弹窗：`.greet-boss-dialog`
8. 发送成功弹窗关闭按钮：`.greet-boss-dialog span.close`
9. 发送成功弹窗继续沟通按钮：`.greet-boss-dialog .sure-btn`
10. 聊天页输入框：`#chat-input.chat-input`
11. 聊天页发送按钮：文本为 `发送` 的 `button`，可用状态下 class 不含 `disabled`

重要结论：

1. 点击 `.job-card-wrap` 容器不一定触发详情切换；实测应点击卡片内的 `a.job-name`。
2. 点击“立即沟通”会先发送 Boss 默认招呼语，然后出现 `.greet-boss-dialog`。
3. 点击 `.greet-boss-dialog .sure-btn` 会跳转到 `https://www.zhipin.com/web/geek/chat`，可能导致当前 CDP `Runtime.evaluate` 返回 `Inspected target navigated or closed`，这属于页面导航后的 target 失效，需要重连 CDP target 后继续。
4. 聊天页必须确认正文里出现目标岗位名后，才能填入 `#chat-input.chat-input` 并发送自定义 AI 消息。
