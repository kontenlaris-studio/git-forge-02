// The forge's HTTP server: one listener routing the four surfaces — git smart HTTP,
// REST v3, GraphQL v4 and MCP — over a single in-memory store. Auth is a bearer token
// check against $MAKEFUN_SHOP_TOKEN whenever the environment provides one; the token's
// owner is the forge's sole user.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { forge } from './store.ts';
import { routeRest, type Ctx } from './rest.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
}

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${EXPECTED_TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
  });
  res.end(body);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const segments = url.pathname.split('/').filter((s) => s !== '').map(decodeSegment);
  const method = req.method ?? 'GET';

  if (url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = await readBody(req);

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const tail = segments.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      const reply = infoRefs(repo, service, v2);
      sendRaw(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const reply = uploadPack(repo, body, typeof protocol === 'string' ? protocol : null);
      sendRaw(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const reply = receivePack(repo, body);
      sendRaw(res, reply.status, reply.contentType, reply.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    let json: unknown;
    let jsonError = false;
    if (body.length > 0) {
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        jsonError = true;
      }
    }
    const ctx: Ctx = {
      method,
      query: url.searchParams,
      body,
      json,
      jsonError,
      host: req.headers.host ?? 'localhost',
    };
    const reply = routeRest(segments, ctx);
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // GraphQL v4
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(parsed));
    return;
  }

  // MCP
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const reply = handleMcp(body);
    if (reply.status === 202 || reply.body === undefined) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId(), 'content-length': '0' });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
