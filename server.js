import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TOOLS = [
  {
    name: 'search_files',
    description: 'Search for files in Google Drive by name or content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        pageSize: { type: 'number', description: 'Max results (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_recent_files',
    description: 'List the most recently modified files in Google Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Max results (default 10)' }
      }
    }
  },
  {
    name: 'get_file_content',
    description: 'Get the text content of a Google Drive file by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Google Drive file ID' }
      },
      required: ['fileId']
    }
  }
];

async function callDriveAPI(path, token) {
  const url = `https://www.googleapis.com/drive/v3/${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function searchFiles(token, query, pageSize = 10) {
  const q = encodeURIComponent(`name contains '${query}' or fullText contains '${query}'`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink)');
  const data = await callDriveAPI(
    `files?q=${q}&pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime%20desc`,
    token
  );
  return data.files || [];
}

async function listRecentFiles(token, pageSize = 10) {
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink)');
  const data = await callDriveAPI(
    `files?pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime%20desc`,
    token
  );
  return data.files || [];
}

async function getFileContent(token, fileId) {
  // Get metadata first
  const meta = await callDriveAPI(`files/${fileId}?fields=name,mimeType`, token);
  const mimeType = meta.mimeType || '';

  if (mimeType.includes('google-apps.document')) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return await res.text();
  }

  if (mimeType.startsWith('text/') || mimeType.includes('json')) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return await res.text();
  }

  return `[File "${meta.name}" is type ${mimeType} — cannot extract text content]`;
}

function formatFiles(files) {
  if (!files.length) return 'No files found.';
  return files
    .map((f, i) => `${i + 1}. ${f.name} (${f.mimeType})\n   Modified: ${f.modifiedTime}\n   ID: ${f.id}\n   Link: ${f.webViewLink || 'N/A'}`)
    .join('\n\n');
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpResult(id, text, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], isError }
  };
}

app.post('/', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};

  if (jsonrpc !== '2.0') {
    return res.status(400).json(mcpError(id, -32600, 'Invalid JSON-RPC'));
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'gdrive-mcp', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    });
  }

  if (method === 'tools/call') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token) {
      return res.json(mcpResult(id, 'No authorization token provided. Please authenticate with Google.', true));
    }

    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      let text;
      if (toolName === 'search_files') {
        const files = await searchFiles(token, args.query, args.pageSize || 10);
        text = formatFiles(files);
      } else if (toolName === 'list_recent_files') {
        const files = await listRecentFiles(token, args.pageSize || 10);
        text = formatFiles(files);
      } else if (toolName === 'get_file_content') {
        text = await getFileContent(token, args.fileId);
      } else {
        return res.json(mcpError(id, -32601, `Unknown tool: ${toolName}`));
      }
      return res.json(mcpResult(id, text));
    } catch (err) {
      return res.json(mcpResult(id, `Error: ${err.message}`, true));
    }
  }

  return res.json(mcpError(id, -32601, `Unknown method: ${method}`));
});

app.listen(PORT, () => console.log(`Google Drive MCP server running on port ${PORT}`));
