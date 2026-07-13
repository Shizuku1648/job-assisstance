# Boss 直聘页面结构笔记

## 20260713 推荐页 URL 状态

- 二次打开方式：Edge 自行打开 URL，非 Playwright `page.goto`。
- DevTools target URL：`https://www.zhipin.com/web/geek/jobs?city=101010100`
- DevTools target 标题：`「北京招聘」-2026年北京人才招聘信息 - BOSS直聘`
- 登录态：未回到登录页，登录态大概率有效。
- 城市状态：当前是北京，需要切到“算法工程师”期望岗位对应的上海。
- 已知页面内期望岗位：推荐、高性能计算工程师、大模型算法、算法工程师。
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

