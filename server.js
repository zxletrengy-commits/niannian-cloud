const express = require('express');
const cors = require('cors');
const app = express();

// 彻底放开跨域限制
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 根目录健康检查，防止直接打开报 404
app.get('/', (req, res) => res.send('Server is running normally.'));

// 处理 MCP 协议的请求
app.post('/backup', (req, res) => {
  const { method, id } = req.body;

  // 响应小手机的“读取工具”请求
  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'backup',
          description: 'Cloud backup tool',
          inputSchema: {
            type: 'object',
            properties: { action: { type: 'string' } }
          }
        }]
      }
    });
  }

  // 默认响应，接住其他数据
  res.json({ jsonrpc: '2.0', id, result: { success: true } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));