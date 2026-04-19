# XiaohongshuFetch

小红书抓取插件，支持：

- 单篇笔记详情页
- 作者主页页
- 主页最近笔记列表
- 可选批量展开主页最近笔记详情

## 能力说明

- 图文笔记：抓取正文、作者、互动、标签、原图链接
- 视频笔记：抓取正文、作者、互动、无水印视频直链
- 作者主页：抓取作者简介、主页互动数据、最近笔记列表
- 批量展开：对主页最近 N 条笔记继续下钻详情，减少一条条手工抓取

## 依赖

```bash
pip install requests
```

## Cookie 配置

登录小红书网页版后，在浏览器开发者工具里取 Cookie：

`F12 -> Application -> Cookies -> www.xiaohongshu.com`

把下面字段填进同目录的 `config.env`：

| 环境变量 | Cookie 名 | 说明 |
|---|---|---|
| `XHS_COOKIE_A1` | `a1` | 设备指纹 |
| `XHS_COOKIE_WEB_SESSION` | `web_session` | 登录态，最关键 |
| `XHS_COOKIE_WEB_ID` | `webId` | 设备 ID |
| `XHS_COOKIE_FULL` | 完整 Cookie 串 | 可选，会覆盖上面三项 |
| `REQUEST_TIMEOUT` | - | 可选，默认 20 秒 |

示例：

```env
XHS_COOKIE_A1=19ca48a5fa3xxxxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_WEB_SESSION=040069xxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_WEB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
XHS_COOKIE_FULL=
REQUEST_TIMEOUT=20
```

## 输入参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 小红书笔记链接、主页链接，或解析后会跳转到它们的短链 |
| `max_notes` | int | 否 | 主页模式下返回最近多少条笔记，默认 `10`，最大 `20` |
| `include_note_details` | bool | 否 | 主页模式下是否继续抓取每条笔记详情，默认 `false` |
| `include_author_recent_notes` | bool | 否 | 笔记模式下是否顺带抓取作者最近笔记列表，默认 `false` |
| `author_recent_notes_only` | bool | 否 | 笔记模式下只输出作者最近笔记，不输出当前笔记正文，默认 `false` |
| `use_browser` | bool | 否 | 作者主页模式下启用 Playwright 持久浏览器抓取，适合绕过主页登录/验证壳页 |
| `browser_headless` | bool | 否 | 浏览器模式是否无头，默认 `false`；首次扫码验证时建议保持 `false` |
| `browser_timeout_ms` | int | 否 | 浏览器模式最大等待时长，默认 `180000` 毫秒 |
| `browser_channel` | string | 否 | 浏览器通道，默认 `chrome` |
| `browser_user_data_dir` | string | 否 | 浏览器持久会话目录，用于保存验证后的登录状态 |
| `a1` | string | 否 | 可覆盖环境变量中的 Cookie |
| `web_session` | string | 否 | 可覆盖环境变量中的 Cookie |
| `web_id` | string | 否 | 可覆盖环境变量中的 Cookie |

同时兼容 `maxNotes` / `includeNoteDetails` / `includeAuthorRecentNotes` / `authorRecentNotesOnly` / `useBrowser` / `browserHeadless` / `browserTimeoutMs` / `browserUserDataDir` 这些驼峰写法。

## 支持的链接

### 笔记详情

```text
https://www.xiaohongshu.com/explore/<note_id>?xsec_token=xxx
https://www.xiaohongshu.com/discovery/item/<note_id>
https://xhslink.com/xxxxx
```

### 作者主页

```text
https://www.xiaohongshu.com/user/profile/<user_id>
https://xhslink.com/xxxxx
```

## 调用示例

### 抓单篇笔记

```json
{
  "url": "https://www.xiaohongshu.com/explore/<note_id>?xsec_token=xxx"
}
```

### 抓作者主页最近 10 条笔记

```json
{
  "url": "https://www.xiaohongshu.com/user/profile/<user_id>",
  "max_notes": 10
}
```

### 抓作者主页并展开最近 5 条笔记详情

```json
{
  "url": "https://www.xiaohongshu.com/user/profile/<user_id>",
  "max_notes": 5,
  "include_note_details": true
}
```

### 抓作者主页并启用浏览器持久会话

这个模式适合“主页直链返回登录壳页或安全验证”的情况。第一次会弹出浏览器，你在窗口里完成扫码/验证后，后续会复用会话目录。

```json
{
  "url": "https://www.xiaohongshu.com/user/profile/<user_id>",
  "max_notes": 10,
  "use_browser": true,
  "browser_headless": false,
  "browser_timeout_ms": 180000
}
```

### 用一条笔记顺带抓作者最近 10 条笔记

这个模式很适合“主页直链被验证页拦住，但手头有作者任意一条笔记链接”的情况。

```json
{
  "url": "https://www.xiaohongshu.com/explore/<note_id>?xsec_token=xxx",
  "max_notes": 10,
  "include_author_recent_notes": true
}
```

### 用一条笔记只输出作者最近笔记

```json
{
  "url": "https://www.xiaohongshu.com/explore/<note_id>?xsec_token=xxx",
  "max_notes": 10,
  "author_recent_notes_only": true
}
```

## 输出说明

### 单篇笔记

返回：

- 标题
- 正文
- 作者
- 点赞 / 收藏 / 评论
- 标签
- 图片或视频直链

### 作者主页

返回：

- 作者昵称 / 作者 ID / 小红书号
- 地区 / 简介
- 关注 / 粉丝 / 获赞与收藏
- 最近笔记标题、类型、点赞数、详情链接、封面
- 如果开启 `include_note_details`，会继续附带最近若干条笔记正文
- 如果主页直链先返回验证壳页，启用 `use_browser` 后会自动切到浏览器持久会话模式

### 笔记附带作者最近内容

如果开启 `include_author_recent_notes` 或 `author_recent_notes_only`，插件会直接复用当前笔记页里已返回的作者主页数据，附带输出：

- 作者昵称 / 作者 ID / 小红书号
- 最近笔记标题、类型、点赞数、详情链接、封面
- 如果再配合 `include_note_details`，会继续展开最近若干条笔记正文

## 注意事项

- 小红书 CDN 链接通常有时效性，建议及时保存
- Cookie 过期后需要重新提取
- 主页模式下如果开启详情展开，请适当控制 `max_notes`，避免结果过长
- 目前小红书作者主页直链在部分账号 / Cookie 组合下会触发“安全验证”。如果你启用了 `use_browser`，插件会自动打开浏览器等待你完成验证
- 首次浏览器验证建议把 `browser_headless` 保持为 `false`，并适当增大 `browser_timeout_ms`
