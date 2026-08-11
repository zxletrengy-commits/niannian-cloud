# niannian-cloud

小手机云端备份 MCP Server。按《小手机 MCP 云端能力协议 v1》实现。

## 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/mcp` | POST | MCP Streamable HTTP |
| `/api/upload/:slot` | PUT | 加密存档上传（签名 URL） |
| `/api/download/:slot` | GET | 加密存档下载（签名 URL） |
| `/` | GET | 健康检查 |

## 工具

### phone_cloud_backup

- `list` — 列出所有槽位快照
- `prepare_upload` — 获取一次性上传 URL（PUT 原始二进制）
- `prepare_download` — 获取一次性下载 URL

四个槽位：`manual` `auto-1` `auto-2` `auto-3`，每次上传覆盖当前槽位。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AUTH_TOKEN` | MCP 认证 token | 空（不校验） |
| `AUTH_HEADER_NAME` | 自定义认证头 | `X-Auth-Token` |
| `PUBLIC_URL` | 公网地址 | `http://localhost:3000` |
| `SIGNING_SECRET` | 上传/下载签名密钥 | 自动生成 |
| `DATA_DIR` | 存档目录 | `/data` |
| `PORT` | 端口 | `3000` |

## 部署（Zeabur）

1. **Volume**：在 Volumes 标签页挂载一个卷到 `/data`
2. **环境变量**：
   - `AUTH_TOKEN` = `<你的 token>`
   - `PUBLIC_URL` = `https://niannian-cloud.zeabur.app`
   - `SIGNING_SECRET` = `<随机字符串>`
3. 连接 GitHub，自动部署

## 小手机年年机配置

- MCP 地址：`https://niannian-cloud.zeabur.app/mcp`
- 认证：Bearer Token 或自定义头 `X-Auth-Token`
