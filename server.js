import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

// ── 配置 ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';           // 空 = 不校验
const AUTH_HEADER_NAME = process.env.AUTH_HEADER_NAME || 'X-Auth-Token';
const SIGNING_SECRET = process.env.SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

const SLOTS = ['manual', 'auto-1', 'auto-2', 'auto-3'];
const TOKEN_TTL_MS = 10 * 60 * 1000;                      // 签名 URL 10 分钟有效
const MAX_BODY_BYTES = 512 * 1024 * 1024;                  // 512MB 上限

// ── 数据目录 ──────────────────────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
const BACKUPS_FILE = path.join(DATA_DIR, 'backups.json');
const encFile = (slot) => path.join(DATA_DIR, `${slot}.enc`);
const pendingFile = (slot) => path.join(DATA_DIR, `pending_${slot}.json`);

// ── 工具函数 ──────────────────────────────────────────
function readBackups() {
  try { return JSON.parse(fs.readFileSync(BACKUPS_FILE, 'utf-8')); }
  catch { return {}; }
}
function writeBackups(data) {
  fs.writeFileSync(BACKUPS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function signPayload(payload) {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    if (!data || !sig) return null;
    const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
    if (Buffer.from(sig).length !== Buffer.from(expected).length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return req.headers[AUTH_HEADER_NAME.toLowerCase()] || '';
}

// ── 存储层 ────────────────────────────────────────────
function listSnapshots() {
  const all = readBackups();
  return SLOTS
    .filter(s => all[s])
    .map(s => all[s])
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

function getSnapshot(slot, snapshotId) {
  const all = readBackups();
  const entry = all[slot];
  if (!entry || entry.id !== snapshotId) return null;
  if (!fs.existsSync(encFile(slot))) return null;
  return entry;
}

function saveUpload(slot, metadata) {
  const all = readBackups();
  const id = `${slot}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const uploadedAt = new Date().toISOString();
  const bytes = fs.statSync(encFile(slot)).size;
  all[slot] = {
    id, slot,
    createdAt: metadata.createdAt || uploadedAt,
    uploadedAt,
    bytes,
    sha256: metadata.sha256 || undefined,
    exportVersion: metadata.exportVersion || undefined,
    summary: metadata.summary || undefined,
  };
  writeBackups(all);
  return all[slot];
}

// ── MCP Server ────────────────────────────────────────
const mcp = new McpServer({ name: 'niannian-cloud', version: '1.0.0' });

mcp.tool(
  'phone_cloud_backup',
  {
    action: z.enum(['list', 'prepare_upload', 'prepare_download']).describe('操作类型'),
    protocolVersion: z.literal(1).describe('协议版本，固定为 1'),
    slot: z.enum(['manual', 'auto-1', 'auto-2', 'auto-3']).optional()
      .describe('备份槽位'),
    snapshotId: z.string().optional()
      .describe('快照 ID'),
    metadata: z.any().optional()
      .describe('存档元数据（含 createdAt/sha256/bytes/summary 等）'),
  },
  async (args) => {
    switch (args.action) {
      case 'list': {
        const snapshots = listSnapshots();
        return {
          content: [{ type: 'text', text: JSON.stringify({ snapshots }) }],
          structuredContent: { snapshots },
          isError: false,
        };
      }

      case 'prepare_upload': {
        if (!args.slot) throw new Error('slot 为必填项');
        if (!args.metadata) throw new Error('metadata 为必填项');

        fs.writeFileSync(pendingFile(args.slot), JSON.stringify(args.metadata), 'utf-8');

        const token = signPayload({ slot: args.slot, action: 'upload', exp: Date.now() + TOKEN_TTL_MS });
        const uploadUrl = `${PUBLIC_URL}/api/upload/${args.slot}?token=${encodeURIComponent(token)}`;

        return {
          content: [{ type: 'text', text: JSON.stringify({ uploadUrl, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } }) }],
          structuredContent: { uploadUrl, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } },
          isError: false,
        };
      }

      case 'prepare_download': {
        if (!args.slot) throw new Error('slot 为必填项');
        if (!args.snapshotId) throw new Error('snapshotId 为必填项');

        const snapshot = getSnapshot(args.slot, args.snapshotId);
        if (!snapshot) throw new Error('快照不存在或不属于当前槽位');

        const token = signPayload({ slot: args.slot, action: 'download', exp: Date.now() + TOKEN_TTL_MS });
        const downloadUrl = `${PUBLIC_URL}/api/download/${args.slot}?token=${encodeURIComponent(token)}`;

        return {
          content: [{ type: 'text', text: JSON.stringify({ downloadUrl, headers: {} }) }],
          structuredContent: { downloadUrl, headers: {} },
          isError: false,
        };
      }
    }
  },
);

// ── Express ───────────────────────────────────────────
const app = express();

// CORS
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'Accept',
    'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID',
    AUTH_HEADER_NAME,
  ],
  exposedHeaders: ['Mcp-Session-Id'],
}));
app.options('*', cors());

// Auth helper
function authGuard(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (extractToken(req) !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: token 不正确' });
  }
  next();
}

// ── MCP SSE 端点 ──
let transport;

app.get('/sse', authGuard, async (req, res) => {
  transport = new SSEServerTransport('/messages', res);
  await mcp.connect(transport);
});

app.post('/messages', authGuard, express.json({ limit: '1mb' }), async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).json({ error: 'No active SSE connection — 请先 GET /sse' });
  }
});

// ── 上传端点（签名 URL 认证，不走 MCP token）──
app.put('/api/upload/:slot', express.raw({ type: '*/*', limit: '512mb' }), (req, res) => {
  const { slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: '无效的槽位' });

  const payload = verifyToken(req.query.token || '');
  if (!payload || payload.slot !== slot || payload.action !== 'upload') {
    return res.status(403).json({ error: '签名无效或已过期' });
  }

  const buf = req.body;
  if (!Buffer.isBuffer(buf)) return res.status(400).json({ error: '请求体必须是原始二进制' });
  if (buf.length > MAX_BODY_BYTES) return res.status(413).json({ error: '文件超过 512MB 上限' });

  fs.writeFileSync(encFile(slot), buf);

  let metadata = {};
  try { metadata = JSON.parse(fs.readFileSync(pendingFile(slot), 'utf-8')); } catch {}
  const saved = saveUpload(slot, metadata);
  try { fs.unlinkSync(pendingFile(slot)); } catch {}

  console.log(`[upload] slot=${slot} id=${saved.id} bytes=${saved.bytes}`);
  res.status(200).json({ ok: true, id: saved.id });
});

// ── 下载端点（签名 URL 认证）──
app.get('/api/download/:slot', (req, res) => {
  const { slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: '无效的槽位' });

  const payload = verifyToken(req.query.token || '');
  if (!payload || payload.slot !== slot || payload.action !== 'download') {
    return res.status(403).json({ error: '签名无效或已过期' });
  }

  const file = encFile(slot);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });

  const buf = fs.readFileSync(file);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.status(200).send(buf);
});

// ── 健康检查 ──
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'niannian-cloud' });
});

// ── 启动 ──
app.listen(PORT, () => {
  console.log(`[niannian-cloud] MCP → ${PUBLIC_URL}/sse  +  POST ${PUBLIC_URL}/messages`);
  console.log(`[niannian-cloud] Auth → ${AUTH_TOKEN ? 'Bearer / ' + AUTH_HEADER_NAME : 'OFF'}`);
  console.log(`[niannian-cloud] Data → ${DATA_DIR}`);
  console.log(`[niannian-cloud] Port → ${PORT}`);
});
