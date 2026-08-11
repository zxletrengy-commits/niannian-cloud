const express = require('express');
const cors = require('cors');
const fs = require('fs');
const app = express();

// 严格按照文档要求配置跨域
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID']
}));

app.use(express.json({ limit: '512mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '512mb' }));

// 临时保存在内存中，用于演示
let snapshots = [];

// 根目录健康检查
app.get('/', (req, res) => res.send('MCP Server is running.'));

// MCP 协议主接口
app.post('/mcp', (req, res) => {
  const { method, params, id } = req.body;

  // 1. 处理初始化握手
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'zeabur-mcp', version: '1.0.0' }
      }
    });
  }

  if (method === 'notifications/initialized') {
    return res.json({ jsonrpc: '2.0' });
  }

  // 2. 声明云端备份工具
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'phone_cloud_backup',
          description: '小手机云端备份',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              protocolVersion: { type: 'integer' },
              slot: { type: 'string' },
              metadata: { type: 'object' }
            }
          }
        }]
      }
    });
  }

  // 3. 处理工具调用
  if (method === 'tools/call' && params.name === 'phone_cloud_backup') {
    const { action, slot, metadata } = params.arguments;
    
    if (action === 'list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ snapshots }) }] }
      });
    }
    
    if (action === 'prepare_upload') {
      const uploadUrl = `https://${req.get('host')}/upload/${slot}`;
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              uploadUrl,
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream' }
            })
          }]
        }
      });
    }
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// 处理实际的二进制文件上传
app.put('/upload/:slot', (req, res) => {
  const slot = req.params.slot;
  // 实际部署中应存入持久化存储，这里存入临时目录
  fs.writeFileSync(`/tmp/backup_${slot}.bin`, req.body);
  
  // 更新快照列表
  snapshots = [{
    id: Date.now().toString(),
    slot: slot,
    createdAt: new Date().toISOString(),
    bytes: req.body.length
  }];
  
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));