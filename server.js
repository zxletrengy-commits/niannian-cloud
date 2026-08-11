import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const app = express();
app.use(cors({
 origin: true,
 credentials: true,
 methods: ['GET', 'POST', 'OPTIONS'],
 allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID']
}));

const server = new McpServer({ name: 'phone-backup', version: '1.0.0' });

server.tool('phone_cloud_backup',
 {
 action: z.enum(['list', 'prepare_upload', 'prepare_download']),
 protocolVersion: z.literal(1),
 slot: z.enum(['manual', 'auto-1', 'auto-2', 'auto-3']).optional(),
 snapshotId: z.string().optional(),
 metadata: z.any().optional()
 },
 async (args) => {
 if (args.action === 'list') {
 return { content: [{ type: 'text', text: JSON.stringify({ snapshots: [] }) }] };
 }
 return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
 }
);

let transport;
app.get('/sse', async (req, res) => {
 transport = new SSEServerTransport('/messages', res);
 await server.connect(transport);
});

app.post('/messages', async (req, res) => {
 if (transport) {
 await transport.handlePostMessage(req, res);
 } else {
 res.status(400).send('No active SSE connection');
 }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));