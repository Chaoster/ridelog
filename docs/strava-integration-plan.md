# Strava 路线导入方案

## 目标

在「每日记录（daily-segment）」页面的 GPX 路线区域，增加「从 Strava 导入」选项。用户首次使用时完成 Strava OAuth 授权，之后可直接从 Strava 历史活动中选择一条路线导入到当前日记。

---

## 用户流程

```
daily-segment.html
       ↓
点击「从 Strava 导入」
       ↓
已授权？ ──否──→ 跳转 Strava OAuth 授权页
  ↓ 是              ↓
调 Edge Function    回调 strava-callback.html
获取活动列表        用 code 换 token 并存入数据库
       ↓                ↓
用户选活动 ←────────── 回到 daily-segment.html
       ↓
调 Edge Function 抓路线 streams
       ↓
填充 gpxPoints / distance / elevation / duration
       ↓
用户继续填写日期、笔记、照片
       ↓
保存 segment（复用现有 daily-segment 保存逻辑）
```

---

## 新增内容

### 1. 数据库表

表名：`strava_tokens`

| 字段 | 类型 | 说明 |
|------|------|------|
| user_id | uuid | 关联 auth.users，主键 |
| access_token | text | Strava access token |
| refresh_token | text | Strava refresh token |
| expires_at | bigint | token 过期时间戳（秒） |
| athlete_id | bigint | Strava athlete id |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 更新时间 |

说明：token 必须服务端存储，不能放 localStorage 或前端代码。

---

### 2. Supabase Edge Functions

#### `strava-auth`

- **调用方式**：`POST /strava-auth` 或 `GET /strava-auth?code=xxx`
- **输入**：Strava 授权回调返回的 `code`
- **处理**：
  - 用 `code + client_id + client_secret` 调用 Strava `/oauth/token`
  - 获取 `access_token`、`refresh_token`、`expires_at`、`athlete.id`
  - 存入 `strava_tokens` 表（upsert）
- **输出**：`{ success: true }`
- **安全**：`client_secret` 只能从 Edge Function 环境变量读取。

#### `strava-activities`

- **调用方式**：`GET /strava-activities?page=1&per_page=30`
- **处理**：
  - 从 `strava_tokens` 读取当前用户 token
  - token 过期时自动 refresh
  - 调用 Strava `/athlete/activities`
- **输出**：活动列表，每条包含 `id`、`name`、`start_date`、`distance`、`moving_time`、`total_elevation_gain`、`type`

#### `strava-activity-streams`

- **调用方式**：`POST /strava-activity-streams` body `{ activityId }`
- **处理**：
  - 调用 Strava `/activities/{id}/streams?keys=latlng,elevation,distance,time`
  - 将 streams 转换成前端可用的 GPX 点格式
- **输出**：
  ```json
  {
    "points": [[lat, lng, elevation], ...],
    "distance": 12345.6,
    "elevationGain": 234.5,
    "duration": "02:15:30"
  }
  ```

---

### 3. 前端改动

#### 新增 `strava-callback.html`

- 作为 Strava OAuth 回调页
- URL 示例：`strava-callback.html?code=xxx&scope=xxx`
- 逻辑：
  - 解析 `code`
  - 调用 `strava-auth` Edge Function 换 token
  - 成功后跳转回 `daily-segment.html?strava=connected`

#### 修改 `daily-segment.html`

GPX 区域从单一上传入口改为双选项：

```
GPX 路线文件
[+] 上传 GPX 文件
或
[Strava 图标] 从 Strava 导入
```

点击「从 Strava 导入」后：
1. 检查当前用户是否已在 `strava_tokens` 表中有记录
2. 无记录 → 跳转 Strava 授权页
3. 有记录 → 显示活动选择弹窗/抽屉
4. 用户选择活动 → 调用 `strava-activity-streams`
5. 返回的数据填充到当前表单的 `gpxPoints` 变量
6. 复用现有 `renderGPXPreview()` 逻辑显示地图、海拔、距离

#### 可选：修改 `js/journey-service.js`

- 添加 `checkStravaAuth()`、`listStravaActivities()`、`getStravaActivityStreams()` 等辅助方法
- 也可以直接在 `daily-segment.html` 中调用 Edge Function，视代码组织而定

---

## Strava OAuth 授权链接

```
https://www.strava.com/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  response_type=code&
  redirect_uri=https://your-domain.com/strava-callback.html&
  approval_prompt=auto&
  scope=activity:read_all
```

- `scope=activity:read_all` 用于读取用户的全部历史活动（含 private）。
- 如果只需要 public 活动，可用 `activity:read`。

---

## 关键约束

1. **client_secret 不能泄露**：只能存在于 Supabase Edge Function 环境变量中。
2. **Rate Limit**：Strava 读取限制为每 15 分钟 100 次、每天 1000 次。`activities` + `streams` 分别计 1 次请求。
3. **Token 刷新**：`access_token` 会过期，Edge Function 中需自动用 `refresh_token` 续期。
4. **数据复用**：Strava 路线导入后，应复用现有 GPX 的上传、预览、简化、保存逻辑。
5. **分支管理**：所有开发在 `feature/strava-import` 分支进行，完成后通过 PR 合并到 `main`。

---

## 建议开发顺序

1. 创建 `strava_tokens` 表
2. 实现 `strava-auth` Edge Function（打通 OAuth）
3. 实现 `strava-activities` Edge Function（列出活动）
4. 实现 `strava-activity-streams` Edge Function（抓路线）
5. 新建 `strava-callback.html` 回调页
6. 修改 `daily-segment.html`：加入口、授权检查、活动选择弹窗
7. 联调测试：授权 → 列表 → 选择 → 回填 → 保存
8. 发 PR 合并到 main

---

## 备注

- 线上部署前需要配置 Edge Function 环境变量：`STRAVA_CLIENT_ID`、`STRAVA_CLIENT_SECRET`。
- 本地开发同样需要在 `supabase/config.toml` 或 `.env` 中配置这些变量。
- 未来可扩展：支持自动按日期匹配、批量导入多天活动等。
