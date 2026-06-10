import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, 'tools.json'), 'utf8'));

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Use the exact tool definitions stored in Salesforce ESR
const TOOLS = schema.tools;

async function driveRequest(path, token) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function mapFile(f) {
  return {
    id: f.id,
    title: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    createdTime: f.createdTime,
    viewUrl: f.webViewLink,
    owner: f.owners?.[0]?.emailAddress,
    fileSize: f.size ? String(f.size) : undefined,
    fileExtension: f.fileExtension,
    parentId: f.parents?.[0],
    description: f.description,
    canAddChildren: false
  };
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,webViewLink,owners,size,fileExtension,parents,description';

async function searchFiles(token, query, pageSize = 10, pageToken) {
  const q = query ? `&q=${encodeURIComponent(query)}` : '';
  const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`);
  const data = await driveRequest(
    `files?pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime%20desc${q}${pt}`,
    token
  );
  return { files: (data.files || []).map(mapFile), nextPageToken: data.nextPageToken };
}

async function listRecentFiles(token, pageSize = 10, orderBy, pageToken) {
  const sort = orderBy === 'lastModifiedByMe' ? 'modifiedByMeTime' : 'modifiedTime';
  const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`);
  const data = await driveRequest(
    `files?pageSize=${pageSize}&fields=${fields}&orderBy=${sort}%20desc${pt}`,
    token
  );
  return { files: (data.files || []).map(mapFile), nextPageToken: data.nextPageToken };
}

async function readFileContent(token, fileId) {
  const meta = await driveRequest(`files/${fileId}?fields=name,mimeType`, token);
  const mime = meta.mimeType || '';
  if (mime.includes('google-apps.document')) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return { fileContent: await res.text() };
  }
  if (mime.startsWith('text/') || mime.includes('json')) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return { fileContent: await res.text() };
  }
  return { fileContent: `File "${meta.name}" is of type ${mime} — text extraction not supported for this format.` };
}

async function getFileMetadata(token, fileId) {
  const fields = encodeURIComponent(FILE_FIELDS);
  const f = await driveRequest(`files/${fileId}?fields=${fields}`, token);
  return mapFile(f);
}

async function getFilePermissions(token, fileId) {
  const data = await driveRequest(
    `files/${fileId}/permissions?fields=${encodeURIComponent('permissions(id,role,type,emailAddress,displayName,view)')}`,
    token
  );
  return { permissions: data.permissions || [] };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpResult(id, data, isError = false) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

app.post('/', async (req, res) => {
  const body = req.body || {};
  console.log('INCOMING:', JSON.stringify({ method: body.method, params: body.params, headers: { authorization: req.headers.authorization ? 'Bearer ***' : 'NONE' } }));
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    return res.status(400).json(mcpError(id, -32600, 'Invalid JSON-RPC'));
  }

  if (method === 'initialize') {
    // Echo client's requested protocol version to avoid version mismatch
    const clientVersion = params?.protocolVersion || schema.serverDescriptor.protocolVersion;
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: schema.serverDescriptor.serverInfo
      }
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(204).send();
  }

  if (method === 'tools/list') {
    return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token) {
      return res.json(mcpResult(id, 'No authorization token provided.', true));
    }

    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      let result;
      if (toolName === 'search_files') {
        result = await searchFiles(token, args.query, args.pageSize || 10, args.pageToken);
      } else if (toolName === 'list_recent_files') {
        result = await listRecentFiles(token, args.pageSize || 10, args.orderBy, args.pageToken);
      } else if (toolName === 'read_file_content') {
        result = await readFileContent(token, args.fileId);
      } else if (toolName === 'get_file_metadata') {
        result = await getFileMetadata(token, args.fileId);
      } else if (toolName === 'get_file_permissions') {
        result = await getFilePermissions(token, args.fileId);
      } else if (toolName === 'copy_file' || toolName === 'create_file' || toolName === 'download_file_content') {
        return res.json(mcpResult(id, `Tool ${toolName} is not supported in this read-only implementation.`, true));
      } else {
        return res.json(mcpError(id, -32601, `Unknown tool: ${toolName}`));
      }
      return res.json(mcpResult(id, result));
    } catch (err) {
      return res.json(mcpResult(id, `Error: ${err.message}`, true));
    }
  }

  return res.json(mcpError(id, -32601, `Unknown method: ${method}`));
});

app.listen(PORT, () => console.log(`Google Drive MCP server running on port ${PORT}`));
