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
/** The exact Authorization header value every protected surface demands, built once. */
const EXPECTED_AUTH = EXPECTED_TOKEN === '' ? null : `Bearer ${EXPECTED_TOKEN}`;
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq}`;
}

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_AUTH === null) return true;
  return req.headers.authorization === EXPECTED_AUTH;
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

/** Send a pre-serialized JSON body (the REST layer's cached replies). */
function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
    ...extraHeaders,
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

const EMPTY_BODY = Buffer.alloc(0);

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Split a request target into pathname + query string without the full URL
 * parser. Exotic targets (non-ASCII bytes, fragments, dot segments) take the
 * legacy URL path so their handling is byte-for-byte what it always was.
 */
function splitTarget(rawUrl: string): { pathname: string; queryString: string } {
  // (A backslash counts as exotic too: the URL parser treats it as a path
  // separator for http URLs, the fast path must not disagree.)
  let exotic = rawUrl.includes('#') || rawUrl.includes('\\');
  for (let i = 0; !exotic && i < rawUrl.length; i += 1) {
    const code = rawUrl.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) exotic = true;
  }
  if (!exotic) {
    // Dot segments are the one place the URL parser rewrites the path itself.
    // A dot segment is always either the target's first segment or preceded by
    // a '/', so these two probes find every one the split-and-compare scan did.
    const q = rawUrl.indexOf('?');
    const pathPart = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (pathPart.includes('/.') || pathPart.startsWith('.')) exotic = true;
  }
  if (exotic) {
    const url = new URL(rawUrl, 'http://forge.invalid');
    return { pathname: url.pathname, queryString: url.search === '' ? '' : url.search.slice(1) };
  }
  const q = rawUrl.indexOf('?');
  if (q === -1) return { pathname: rawUrl, queryString: '' };
  return { pathname: rawUrl.slice(0, q), queryString: rawUrl.slice(q + 1) };
}

/** Path segments of a pathname, percent-decoded exactly like decodeURIComponent per segment. */
function splitPath(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    out.push(part.includes('%') ? decodeSegment(part) : part);
  }
  return out;
}

/** Whether the request can carry a body worth reading, from its headers alone. */
function mayHaveBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && length !== '0';
}

/** Shared parameters for the (very common) empty query string; consumers only ever read it. */
const EMPTY_PARAMS = new URLSearchParams();

/** The 500 a handler failure earns, when the response is still ours to write. */
function fail(res: ServerResponse): void {
  try {
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
  } catch {
    // The socket is already gone; there is no one left to answer.
  }
}

export function createApp(): Server {
  // noDelay is stated explicitly: the workloads are strict request/response
  // ping-pong on one socket, where a Nagle/delayed-ACK stall would tax every
  // single operation; the option costs nothing where it is already the default.
  const server = createServer({ noDelay: true }, (req, res) => {
    let pending: Promise<void> | undefined;
    try {
      pending = dispatch(req, res);
    } catch {
      fail(res);
      return;
    }
    if (pending !== undefined) pending.catch(() => fail(res));
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

/**
 * Route one request. Requests that cannot carry a body (every GET, and the
 * benchmark's hot paths are full of them) are routed synchronously: wrapping
 * them in an async function allocated a promise and a catch chain per request
 * for an await that never happens. Requests with a body read it first, then
 * route from the promise continuation, as before.
 */
function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> | undefined {
  const { pathname, queryString } = splitTarget(req.url ?? '/');
  const segments = splitPath(pathname);
  const method = req.method ?? 'GET';
  let queryCache: URLSearchParams | null = null;
  const query = (): URLSearchParams => {
    if (queryCache === null) queryCache = queryString === '' ? EMPTY_PARAMS : new URLSearchParams(queryString);
    return queryCache;
  };

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return undefined;
  }

  if (!mayHaveBody(req)) {
    route(req, res, segments, method, query, EMPTY_BODY);
    return undefined;
  }
  return readBody(req).then((body) => {
    route(req, res, segments, method, query, body);
  });
}

function route(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  query: () => URLSearchParams,
  body: Buffer,
): void {

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
      const service = query().get('service') ?? '';
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
      query: query(),
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
    if (reply.raw !== undefined) {
      sendJsonBuffer(res, reply.status, reply.raw, reply.headers ?? {});
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
