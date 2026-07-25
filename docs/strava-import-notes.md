# Strava 导入功能实施记录

> 记录 Strava 活动/路线导入功能的实现要点、踩坑与解决方案，供后续回溯。

---

## 1. 功能概述

在「每日记录（daily-segment）」页面支持从 Strava 导入骑行/跑步等活动：

1. 用户点击「从 Strava 导入」
2. 未授权则跳转 Strava OAuth 授权页
3. 授权成功后展示 Strava 活动列表
4. 用户选择活动后导入路线、海拔、距离、用时等数据
5. 回填到当前日记的 GPX 区域，复用现有保存逻辑

---

## 2. 技术实现

### 2.1 数据库表

| 表名 | 用途 |
|------|------|
| `strava_tokens` | 持久化 Strava access_token / refresh_token / expires_at |
| `strava_session_tokens` | 短期导入会话 token，跨 OAuth redirect 使用，默认 1 小时过期 |
| `strava_oauth_states` | OAuth state 参数，10 分钟过期，一次性使用 |

### 2.2 Edge Functions

| Function | 作用 |
|----------|------|
| `strava-auth` | 用 Strava 回调的 `code` 换 token，存入 `strava_tokens`，创建 session token |
| `strava-activities` | 拉取当前用户 Strava 活动列表，支持分页 |
| `strava-activity-streams` | 获取单条活动的路线 streams，fallback 到 `map.polyline` 和 Open-Elevation |

### 2.3 前端页面

| 文件 | 作用 |
|------|------|
| `daily-segment.html` | 导入入口、活动列表弹窗、路线回填 |
| `strava-callback.html` | Strava OAuth 回调处理页 |

---

## 3. 关键卡点与解决方案

### 3.1 Strava API 2026 政策：必须付费订阅

**问题**：调用 `/athlete/activities` 返回 `403 Forbidden`，错误信息为 `Application Status: Inactive`。

**原因**：自 2026 年起，Strava Standard Tier 开发者需要有效的 Strava 会员订阅才能调用 API。

**解决**：购买 Strava 会员后，API 调用恢复正常。

**参考**：
- [Strava Community – An Update To Our Developer Program](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428)
- [Strava API Policy 2026](https://www.strava.com/legal/api_policy)

---

### 3.2 Token 过期策略

| Token | 有效期 | 处理逻辑 |
|-------|--------|----------|
| Strava access_token | 6 小时 | Edge Function 在过期前 5 分钟自动 refresh |
| Strava refresh_token | 30 天 | 每次 refresh 会轮换。过期后必须重新走 OAuth |
| 我们的 session token | 1 小时 | 过期后前端提示「Strava授权已过期，请重新授权」 |

**注意**：refresh_token 30 天过期后，用户必须重新在 Strava 授权页点击同意，不能静默恢复。

---

### 3.3 `latlng` stream 不返回

**问题**：选择活动后报错「该活动没有路线数据」，但活动列表显示 `has_route=true`。

**原因**：`latlng` 属于 Strava sensitive stream，即使会员也可能不返回具体坐标流。

**解决**：
1. 先请求 `/activities/{id}/streams?keys=latlng,elevation,distance,time`
2. 如果 `latlng` 为空，请求 `/activities/{id}` 获取 `map.polyline` 或 `map.summary_polyline`
3. 用 Google Polyline 算法解码成坐标，作为路线 fallback

**影响**：
- 路线可以正常导入
- 海拔数据需要通过 Open-Elevation 第三方 API 补充，精度不如 Strava 原生数据
- 距离、用时、爬升从 activity detail 的 `distance` / `moving_time` / `total_elevation_gain` 获取

---

### 3.4 海拔数据补充

**问题**：polyline fallback 只有 lat/lng，没有海拔，导致没有海拔剖面和爬升数据。

**解决**：
1. 优先使用 Strava 返回的 `elevation` stream
2. 没有 elevation stream 时，调用 Open-Elevation API（`https://api.open-elevation.com/api/v1/lookup`）
3. 对路线坐标均匀采样最多 100 个点获取海拔，其余点线性插值
4. 总爬升优先使用 Strava 的 `total_elevation_gain`，否则从计算出的海拔推导

**注意**：Open-Elevation 是免费第三方服务，数据精度有限，且可能不稳定。

---

### 3.5 npx serve 的 cleanUrls 导致回调参数丢失

**问题**：Strava 回调到 `strava-callback.html?code=xxx&state=xxx` 后，页面提示「未收到授权码」，URL 变成 `/strava-callback` 且没有 query string。

**原因**：`npx serve` 默认启用 `cleanUrls`，会把 `.html` 请求 301 重定向到无后缀路径，过程中丢失 query string。

**解决**：
1. 所有内部跳转链接改为无 `.html` 后缀（如 `daily-segment`、`ongoing`、`strava-callback`）
2. `startStravaOAuth()` 中的 `redirect_uri` 改为 `${location.origin}/strava-callback`
3. 生产环境同样建议使用无 `.html` 路径或关闭 cleanUrls

---

### 3.6 授权成功后点击「放弃」回到 callback 页面报错

**问题**：用户授权成功回到 daily-segment 后，点击「放弃」触发 `history.back()`，回到 `strava-callback.html`，此时 OAuth state 已被删除，报错 `Invalid or expired OAuth state`。

**解决**：
1. `strava-callback.html` 成功或 state 过期时，使用 `location.replace(returnUrl)` 替代 `location.href`，让 callback 页面不留在历史记录中
2. `daily-segment.html` 的「放弃」按钮改为固定跳转到 `ongoing?id=...` 或 `my-records`，不再使用 `history.back()`

---

### 3.7 活动列表无路线数据的标记

**问题**：用户可能选择没有 GPS 数据的活动（如室内骑行、手动记录），导致导入失败。

**解决**：
1. `strava-activities` 返回 `has_route` 字段（基于 `map.summary_polyline`）
2. 前端列表中无路线活动显示「无路线数据」标签，禁用点击
3. 选择有路线活动才允许导入

---

### 3.8 活动列表滚动分页

**实现**：
- 默认每次加载 10 条活动
- 监听 `strava-list` 滚动事件，接近底部时自动加载下一页
- 返回数据不足 10 条时停止加载

---

## 4. 当前状态

- [x] OAuth 授权流程
- [x] 活动列表分页加载
- [x] 无路线活动标记
- [x] SVG 路线快照
- [x] 路线导入（polyline fallback）
- [x] 海拔/爬升/用时 fallback
- [x] 统一错误提示
- [x] 回调页 history 问题修复

---

## 5. 待优化 / 生产注意事项

1. **生产 Strava 应用**：建议生产环境单独创建一个 Strava App，Callback Domain 改为生产域名
2. **Secrets 管理**：生产 `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` 通过 Supabase Secrets 设置，不要硬编码
3. **海拔精度**：Open-Elevation 是近似数据，若对海拔精度要求高，可考虑付费高程服务
4. **本地 env 文件**：`supabase/functions/_shared/local-env.ts` 和 `supabase/.env` 已在 `.gitignore` 中，不要提交
5. **Rate Limit**：Strava 读取限制为每 15 分钟 100 次、每天 1000 次
6. **清理过期 token**：已通过 migration `20260725083000_cleanup_expired_strava_tokens.sql` 添加每日清理任务

---

## 6. 相关文件

- `docs/strava-integration-plan.md` — 原始设计方案
- `daily-segment.html` — 前端导入入口与弹窗
- `strava-callback.html` — OAuth 回调页
- `supabase/functions/strava-auth/index.ts`
- `supabase/functions/strava-activities/index.ts`
- `supabase/functions/strava-activity-streams/index.ts`
- `supabase/migrations/20260724124257_create_strava_tokens_table.sql`
- `supabase/migrations/20260724160751_create_strava_oauth_states_table.sql`
- `supabase/migrations/20260724162032_create_strava_session_tokens_table.sql`
- `supabase/migrations/20260725083000_cleanup_expired_strava_tokens.sql`
