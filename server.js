const express = require('express');
const fs = require('fs');
const app = express();
app.use(express.json({ limit: '50mb' }));
app.post('/backup', (req, res) => {
const data = req.body;
fs.writeFileSync('/tmp/backup.json', JSON.stringify(data));
res.json({ success: true, message: '备份成功，阿梓老板' });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));