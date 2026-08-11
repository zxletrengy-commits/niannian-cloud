const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '50mb' }));

// 严格的跨域设置，专门对付小手机的检查
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.post('/backup', (req, res) => {
  const data = req.body;
  fs.writeFileSync('/tmp/backup.json', JSON.stringify(data));
  res.json({ success: true, message: '备份成功' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));