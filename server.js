import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TOOLS = [
  {
    name: 'search_files',
    description: 'Search for Drive files using a structured query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (e.g. "title contains \'hello\'")" },
        pageSize: { type: 'integer', format: 'int32', description: 'Max results per page' },
        pageToken: { type: 'string', description: 'Pagination token' },
        excludeContentSnippets: { type: 'boolean' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { $ref: '#/$defs/File' } },
        nextPageToken: { type: 'string' }
      },
      $defs: { File: fileSchema() }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'list_recent_files',
    description: 'List the most recently modified files in Google Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'integer', format: 'int32', description: 'Max results' },
        pageToken: { type: 'string' },
        orderBy: { type: 'string', description: 'Sort order: recency, lastModified, lastModifiedByMe' },
        excludeContentSnippets: { type: 'boolean' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { $ref: '#/$defs/File' } },
        nextPageToken: { type: 'string' }
      },
      $defs: { File: fileSchema() }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'read_file_content',
    description: 'Read the text content of a Google Drive file by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Required. The ID of the file to retrieve.' }
      },
      required: ['fileId']
    },
    outputSchema: {
      type: 'object',
      properties: {
        fileContent: { type: 'string', description: 'Drive file content in text format.' }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'get_file_metadata',
    description: 'Get metadata about a Google Drive file.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Required. The ID of the file.' },
        excludeContentSnippets: { type: 'boolean' }
      },
      required: ['fileId']
    },
    outputSchema: { type: 'object', properties: fileSchema().properties, $defs: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }
];

function fileSchema() {
  return {
    type: 'object',
    description: 'A file resource.',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      mimeType: { type: 'string' },
      modifiedTime: { type: 'string', format: 'date-time' },
      createdTime: { type: 'string', format: 'date-time' },
      viewUrl: { type: 'string' },
      owner: { type: 'string' },
      fileSize: { type: 'string' },
      fileExtension: { type: 'string' },
      parentId: { type: 'string' },
      description: { type: 'string' },
      contentSnippet: { type: 'string' }
    }
  };
}

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
    fileSize: f.size,
    fileExtension: f.fileExtension,
    parentId: f.parents?.[0],
    description: f.description,
    contentSnippet: undefined
  };
}

async function searchFiles(token, query, pageSize = 10, pageToken) {
  const q = query ? `&q=${encodeURIComponent(query)}` : '';
  const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners,size,fileExtension,parents,description)');
  const data = await driveRequest(
    `files?pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime%20desc${q}${pt}`,
    token
  );
  return { files: (data.files || []).map(mapFile), nextPageToken: data.nextPageToken };
}

async function listRecentFiles(token, pageSize = 10, orderBy, pageToken) {
  const sortField = orderBy === 'lastModified' ? 'modifiedTime' : orderBy === 'lastModifiedByMe' ? 'modifiedByMeTime' : 'modifiedTime';
  const pt = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  const fields = encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners,size,fileExtension,parents,description)');
  const data = await driveRequest(
    `files?pageSize=${pageSize}&fields=${fields}&orderBy=${sortField}%20desc${pt}`,
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
  return { fileContent: `File "${meta.name}" is of type ${mime} — text extraction not supported.` };
}

async function getFileMetadata(token, fileId) {
  const fields = encodeURIComponent('id,name,mimeType,modifiedTime,createdTime,webViewLink,owners,size,fileExtension,parents,description');
  const f = await driveRequest(`files/${fileId}?fields=${fields}`, token);
  return mapFile(f);
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpResult(id, data, isError = false) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
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
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'gdrive-mcp', version: '1.0.0' }
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
      return res.json(mcpResult(id, 'No authorization token provided. Please authenticate with Google first.', true));
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
