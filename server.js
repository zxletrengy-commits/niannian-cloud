import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── 配置 ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const AUTH_HEADER_NAME = process.env.AUTH_HEADER_NAME || 'X-Auth-Token';
const SIGNING_SECRET = process.env.SIGNING_SECRET || crypto.randomBytes(32).toString('hex');

const SLOTS = ['manual', 'auto-1', 'auto-2', 'auto-3'];
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 512 * 1024 * 1024;

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
  return SLOTS.filter(s => all[s]).map(s => all[s])
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

// ── 手写 JSON-RPC 处理 ────────────────────────────────
const SERVER_INFO = { name: 'niannian-cloud', version: '1.0.0' };

function handleJsonRpc(method, params) {
  switch (method) {

    // ── initialize ──
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };

    // ── tools/list ──
    case 'tools/list':
      return {
        tools: [{
          name: 'phone_cloud_backup',
          description: '小手机云端备份 — 按小手机固定协议列出、上传和下载加密存档。',
          inputSchema: {
            type: 'object',
            required: ['action', 'protocolVersion'],
            properties: {
              action: {
                type: 'string',
                enum: ['list', 'prepare_upload', 'prepare_download'],
              },
              protocolVersion: { type: 'integer', const: 1 },
              slot: {
                type: 'string',
                enum: ['manual', 'auto-1', 'auto-2', 'auto-3'],
              },
              snapshotId: { type: 'string' },
              metadata: { type: 'object' },
            },
            additionalProperties: true,
          },
        }],
      };

    // ── tools/call ──
    case 'tools/call': {
      const { name, arguments: args } = params;
      if (name !== 'phone_cloud_backup') throw createRpcError(-32601, `Unknown tool: ${name}`);

      validateProtocolVersion(args?.protocolVersion);

      switch (args?.action) {
        case 'list': {
          const snapshots = listSnapshots();
          return { content: [{ type: 'text', text: JSON.stringify({ snapshots }) }], isError: false };
        }
        case 'prepare_upload': {
          if (!args.slot) throw createRpcError(-32602, 'slot 为必填项');
          if (!args.metadata) throw createRpcError(-32602, 'metadata 为必填项');
          fs.writeFileSync(pendingFile(args.slot), JSON.stringify(args.metadata), 'utf-8');
          const token = signPayload({ slot: args.slot, action: 'upload', exp: Date.now() + TOKEN_TTL_MS });
          const uploadUrl = `${PUBLIC_URL}/api/upload/${args.slot}?token=${encodeURIComponent(token)}`;
          return {
            content: [{ type: 'text', text: JSON.stringify({ uploadUrl, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' } }) }],
            isError: false,
          };
        }
        case 'prepare_download': {
          if (!args.slot) throw createRpcError(-32602, 'slot 为必填项');
          if (!args.snapshotId) throw createRpcError(-32602, 'snapshotId 为必填项');
          const snapshot = getSnapshot(args.slot, args.snapshotId);
          if (!snapshot) throw createRpcError(-32602, '快照不存在或不属于当前槽位');
          const token = signPayload({ slot: args.slot, action: 'download', exp: Date.now() + TOKEN_TTL_MS });
          const downloadUrl = `${PUBLIC_URL}/api/download/${args.slot}?token=${encodeURIComponent(token)}`;
          return {
            content: [{ type: 'text', text: JSON.stringify({ downloadUrl, headers: {} }) }],
            isError: false,
          };
        }
        default:
          throw createRpcError(-32602, `不支持的 action: ${args?.action}`);
      }
    }

    // ── notifications/initialized ──
    case 'notifications/initialized':
      return null; // 无需响应

    case 'ping':
      return {};

    default:
      throw createRpcError(-32601, `Method not found: ${method}`);
  }
}

function createRpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateProtocolVersion(v) {
  if (v !== 1) throw createRpcError(-32602, `不支持的 protocolVersion: ${v}，仅支持 1`);
}

// ── Express ───────────────────────────────────────────
const app = express();

app.use(cors({
  origin: true, credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'Accept',
    'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID',
    AUTH_HEADER_NAME,
  ],
  exposedHeaders: ['Mcp-Session-Id'],
}));

app.use('/mcp', express.json());

// Auth
function authGuard(req, res, next) {
  if (!AUTH_TOKEN) return next();
  if (extractToken(req) !== AUTH_TOKEN) {
    return res.status(401).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Unauthorized' },
    });
  }
  next();
}

// ── MCP 端点 ──
app.post('/mcp', authGuard, (req, res) => {
  const { method, params, id } = req.body || {};

  if (!method || typeof method !== 'string') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  try {
    const result = handleJsonRpc(method, params);

    // notification（无 id）= 不需要响应
    if (id === undefined || id === null) {
      if (result === null) return res.status(202).end();
      return res.status(200).json({ jsonrpc: '2.0', result });
    }

    return res.status(200).json({ jsonrpc: '2.0', id, result });
  } catch (err) {
    const code = err.code || -32603;
    return res.status(200).json({ jsonrpc: '2.0', id: id || null, error: { code, message: err.message } });
  }
});

// ── 上传 ──
app.put('/api/upload/:slot', (req, res) => {
  const { slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: '无效的槽位' });
  const payload = verifyToken(req.query.token || '');
  if (!payload || payload.slot !== slot || payload.action !== 'upload')
    return res.status(403).json({ error: '签名无效或已过期' });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf || buf.length === 0) return res.status(400).json({ error: '请求体为空' });
    if (buf.length > MAX_BODY_BYTES) return res.status(413).json({ error: '文件超过 512MB 上限' });
    fs.writeFileSync(encFile(slot), buf);
    let metadata = {};
    try { metadata = JSON.parse(fs.readFileSync(pendingFile(slot), 'utf-8')); } catch {}
    const saved = saveUpload(slot, metadata);
    try { fs.unlinkSync(pendingFile(slot)); } catch {}
    console.log(`[upload] slot=${slot} id=${saved.id} bytes=${saved.bytes}`);
    res.status(200).json({ ok: true, id: saved.id });
  });
});

// ── 下载 ──
app.get('/api/download/:slot', (req, res) => {
  const { slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: '无效的槽位' });
  const payload = verifyToken(req.query.token || '');
  if (!payload || payload.slot !== slot || payload.action !== 'download')
    return res.status(403).json({ error: '签名无效或已过期' });
  const file = encFile(slot);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '文件不存在' });
  const buf = fs.readFileSync(file);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.status(200).send(buf);
});

app.get('/', (_req, res) => res.json({ ok: true, name: 'niannian-cloud', mcp: '/mcp' }));

app.listen(PORT, () => {
  console.log(`[niannian-cloud] MCP → ${PUBLIC_URL}/mcp`);
  console.log(`[niannian-cloud] Auth → ${AUTH_TOKEN ? 'Bearer / ' + AUTH_HEADER_NAME : 'OFF'}`);
  console.log(`[niannian-cloud] Port → ${PORT}`);
});
