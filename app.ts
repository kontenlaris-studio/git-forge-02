// The forge's HTTP server: one listener routing the four surfaces — git smart HTTP,
// REST v3, GraphQL v4 and MCP — over a single in-memory store. Auth is a bearer token
// check against $MAKEFUN_SHOP_TOKEN whenever the environment provides one; the token's
// owner is the forge's sole user.
//
// Transport: the server speaks HTTP/1.1 itself on a raw TCP socket instead of
// node:http. The routing layer's answers were already fully buffered value objects
// before they reached the wire, so the per-request req/res machinery of node:http —
// two stream objects, a parser callback chain, header bookkeeping — was pure overhead
// on every exchange, and the workloads are tens of thousands of small exchanges. The
// wire behaviour is the one node:http produced: same status lines and reason phrases,
// same headers in the same order (minus node's automatic Date/Connection, which no
// client reads), content-length framing everywhere, keep-alive by default on 1.1,
// a body's bytes dropped on HEAD answers, and a 400-and-close for a request head
// that does not parse.

import { STATUS_CODES } from 'node:http';
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
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

/** One request as the routing layer sees it: method, raw target, headers by lowercase name. */
interface ReqView {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** One fully buffered answer: status, the headers in wire order, and the body bytes. */
interface Reply {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY_BODY = Buffer.alloc(0);

function jsonReply(status: number, value: unknown, extraHeaders: Record<string, string> = {}): Reply {
  const body = value === undefined ? EMPTY_BODY : Buffer.from(JSON.stringify(value), 'utf8');
  const headers: Array<readonly [string, string]> = [
    ['content-type', JSON_TYPE],
    ['x-github-request-id', nextRequestId()],
    ['content-length', String(body.length)],
  ];
  for (const [name, extra] of Object.entries(extraHeaders)) headers.push([name, extra]);
  return { status, headers, body };
}

function rawReply(status: number, contentType: string, body: Buffer): Reply {
  return {
    status,
    headers: [
      ['content-type', contentType],
      ['x-github-request-id', nextRequestId()],
      ['content-length', String(body.length)],
    ],
    body,
  };
}

/** A pre-serialized JSON body (the REST layer's cached replies) with its headers. */
function jsonBufferReply(status: number, body: Buffer, extraHeaders: Record<string, string> = {}): Reply {
  const headers: Array<readonly [string, string]> = [
    ['content-type', JSON_TYPE],
    ['x-github-request-id', nextRequestId()],
    ['content-length', String(body.length)],
  ];
  for (const [name, extra] of Object.entries(extraHeaders)) headers.push([name, extra]);
  return { status, headers, body };
}

function authorized(req: ReqView): boolean {
  if (EXPECTED_AUTH === null) return true;
  return req.headers.authorization === EXPECTED_AUTH;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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

/** Shared parameters for the (very common) empty query string; consumers only ever read it. */
const EMPTY_PARAMS = new URLSearchParams();

function dispatch(req: ReqView, body: Buffer): Reply {
  const { pathname, queryString } = splitTarget(req.url);
  const segments = splitPath(pathname);
  const method = req.method;
  const query = queryString === '' ? EMPTY_PARAMS : new URLSearchParams(queryString);

  if (pathname === '/healthz') return jsonReply(200, { ok: true });

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    if (!authorized(req)) return jsonReply(401, { message: 'Unauthorized' });
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) return jsonReply(404, { message: 'Not Found' });
    const tail = segments.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        return jsonReply(404, { message: 'Not Found' });
      }
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      const reply = infoRefs(repo, service, v2);
      return rawReply(reply.status, reply.contentType, reply.body);
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const reply = uploadPack(repo, body, typeof protocol === 'string' ? protocol : null);
      return rawReply(reply.status, reply.contentType, reply.body);
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const reply = receivePack(repo, body);
      return rawReply(reply.status, reply.contentType, reply.body);
    }
    return jsonReply(404, { message: 'Not Found' });
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) return jsonReply(401, { message: 'Unauthorized' });
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
      query,
      body,
      json,
      jsonError,
      host: req.headers.host ?? 'localhost',
    };
    const reply = routeRest(segments, ctx);
    if (reply.status === 204) {
      return { status: 204, headers: [['x-github-request-id', nextRequestId()]], body: EMPTY_BODY };
    }
    if (reply.raw !== undefined) return jsonBufferReply(reply.status, reply.raw, reply.headers ?? {});
    return jsonReply(reply.status, reply.body, reply.headers ?? {});
  }

  // GraphQL v4
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (!authorized(req)) return jsonReply(401, { message: 'Unauthorized' });
    if (method !== 'POST') return jsonReply(404, { message: 'Not Found' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return jsonReply(400, { errors: [{ message: 'Invalid JSON body' }] });
    }
    return jsonReply(200, executeGraphQL(parsed));
  }

  // MCP
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (!authorized(req)) return jsonReply(401, { message: 'Unauthorized' });
    if (method !== 'POST') return jsonReply(405, { message: 'Method Not Allowed' });
    const reply = handleMcp(body);
    if (reply.status === 202 || reply.body === undefined) {
      return {
        status: 202,
        headers: [
          ['x-github-request-id', nextRequestId()],
          ['content-length', '0'],
        ],
        body: EMPTY_BODY,
      };
    }
    return jsonReply(reply.status, reply.body);
  }

  return jsonReply(404, { message: 'Not Found' });
}

/** The 500 a handler failure earns, as a buffered reply. */
function failReply(): Reply {
  return jsonReply(500, { message: 'Internal Server Error' });
}

// ---------------------------------------------------------------- transport

/** Largest request head (request line + headers) accepted, matching node:http's cap. */
const MAX_HEAD_BYTES = 16_384;
/** Idle keep-alive sockets are closed after this long (node:http's keepAliveTimeout role). */
const IDLE_TIMEOUT_MS = 75_000;

const HEAD_END = '\r\n\r\n';
const CONTINUE_HEAD = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
const BAD_REQUEST = Buffer.from(
  'HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n',
  'latin1',
);

/** One parsed request head: everything dispatch needs, plus body framing. */
interface ParsedHead {
  readonly req: ReqView;
  /** Bytes of body that follow the head: the content-length, or -1 for chunked. */
  readonly bodyLength: number;
  /** Whether the connection survives this exchange. */
  readonly keepAlive: boolean;
  /** The client asked for a 100-continue before the body. */
  readonly wantsContinue: boolean;
}

/** A hex digit's value, or -1: chunk sizes take the same manual decode as pkt-lines. */
function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/**
 * Parse one request head (the bytes before the blank line, decoded latin1 so
 * every byte survives). Returns null when the head is not a request this
 * server can frame — the caller answers 400 and closes, as node:http did.
 */
function parseHead(text: string): ParsedHead | null {
  const lineEnd = text.indexOf('\r\n');
  const requestLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace <= 0 || lastSpace <= firstSpace) return null;
  const method = requestLine.slice(0, firstSpace);
  const url = requestLine.slice(firstSpace + 1, lastSpace);
  const version = requestLine.slice(lastSpace + 1);
  if (url === '' || (version !== 'HTTP/1.1' && version !== 'HTTP/1.0')) return null;

  const headers: Record<string, string> = {};
  let bodyLength = 0;
  let chunked = false;
  let wantsContinue = false;
  let connection = '';
  let pos = lineEnd + 2;
  while (pos < text.length) {
    const next = text.indexOf('\r\n', pos);
    const line = next === -1 ? text.slice(pos) : text.slice(pos, next);
    pos = next === -1 ? text.length : next + 2;
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    const name = line.slice(0, colon).toLowerCase();
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'content-length') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
      bodyLength = parsed;
    } else if (name === 'transfer-encoding') {
      if (value.toLowerCase().includes('chunked')) chunked = true;
    } else if (name === 'expect') {
      if (value.toLowerCase() === '100-continue') wantsContinue = true;
    } else if (name === 'connection') {
      connection = value.toLowerCase();
    }
    const prior = headers[name];
    headers[name] = prior === undefined ? value : `${prior}, ${value}`;
  }

  const keepAlive = version === 'HTTP/1.1' ? !connection.includes('close') : connection.includes('keep-alive');
  return {
    req: { method, url, headers },
    bodyLength: chunked ? -1 : bodyLength,
    keepAlive,
    wantsContinue,
  };
}

/**
 * The body of a chunked request starting at `start` in `buf`: its decoded
 * bytes and the offset just past the trailer, or null when more bytes must
 * arrive first. A malformed chunk frame throws (the caller closes).
 */
function readChunked(buf: Buffer, start: number): { body: Buffer; end: number } | null {
  const parts: Buffer[] = [];
  let pos = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) return null;
    let size = 0;
    let digits = 0;
    for (let i = pos; i < lineEnd; i += 1) {
      const code = buf[i];
      if (code === 0x3b) break; // ';' opens a chunk extension: ignored
      const digit = hexValue(code);
      if (digit === -1) throw new Error('bad chunk size');
      size = size * 16 + digit;
      digits += 1;
    }
    if (digits === 0) throw new Error('empty chunk size');
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailer part: header lines until the blank line ends the body.
      let trailer = dataStart;
      for (;;) {
        const end = buf.indexOf('\r\n', trailer);
        if (end === -1) return null;
        if (end === trailer) return { body: Buffer.concat(parts), end: end + 2 };
        trailer = end + 2;
      }
    }
    const dataEnd = dataStart + size;
    if (buf.length < dataEnd + 2) return null;
    if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) throw new Error('chunk not framed');
    parts.push(buf.subarray(dataStart, dataEnd));
    pos = dataEnd + 2;
  }
}

/** Serialize one reply: status line, headers in order, then the body bytes. */
function serialize(reply: Reply, dropBody: boolean): Buffer {
  const phrase = STATUS_CODES[reply.status] ?? '';
  let head = `HTTP/1.1 ${reply.status} ${phrase}\r\n`;
  for (const [name, value] of reply.headers) head += `${name}: ${value}\r\n`;
  head += '\r\n';
  const headBytes = Buffer.from(head, 'latin1');
  if (dropBody || reply.body.length === 0) return headBytes;
  return Buffer.concat([headBytes, reply.body]);
}

/**
 * One connection's state machine. Bytes accumulate; every complete request
 * in the buffer is dispatched in order (the clients never pipeline, but a
 * buffer may hold the next request's start, and correctness costs nothing).
 */
class Connection {
  private readonly socket: Socket;
  private pending: Buffer | null = null;
  private head: ParsedHead | null = null;
  private headBytes = 0;
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {
      this.closed = true;
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.pending = this.pending === null ? chunk : Buffer.concat([this.pending, chunk]);
    try {
      this.drain();
    } catch {
      // A framing failure (bad chunk, bad head mid-body): close without an
      // answer; no client of this server produces one.
      this.closed = true;
      this.socket.destroy();
    }
  }

  private drain(): void {
    for (;;) {
      if (this.closed || this.pending === null) return;
      if (this.head === null) {
        const end = this.pending.indexOf(HEAD_END);
        if (end === -1) {
          if (this.pending.length > MAX_HEAD_BYTES) {
            this.closed = true;
            this.socket.end(BAD_REQUEST);
          }
          return;
        }
        const parsed = parseHead(this.pending.toString('latin1', 0, end));
        if (parsed === null) {
          this.closed = true;
          this.socket.end(BAD_REQUEST);
          return;
        }
        this.head = parsed;
        this.headBytes = end + HEAD_END.length;
        if (parsed.wantsContinue) this.socket.write(CONTINUE_HEAD);
      }
      const head = this.head;
      const available = this.pending.length - this.headBytes;
      let body: Buffer;
      let consumed: number;
      if (head.bodyLength >= 0) {
        if (available < head.bodyLength) return;
        body = Buffer.from(this.pending.subarray(this.headBytes, this.headBytes + head.bodyLength));
        consumed = this.headBytes + head.bodyLength;
      } else {
        const decoded = readChunked(this.pending, this.headBytes);
        if (decoded === null) return;
        body = decoded.body;
        consumed = decoded.end;
      }
      this.pending = consumed < this.pending.length ? this.pending.subarray(consumed) : null;
      this.head = null;
      this.headBytes = 0;

      let reply: Reply;
      try {
        reply = dispatch(head.req, body);
      } catch {
        reply = failReply();
      }
      const bytes = serialize(reply, head.req.method === 'HEAD');
      if (!head.keepAlive) {
        this.closed = true;
        this.socket.end(bytes);
        return;
      }
      this.socket.write(bytes);
    }
  }
}

export function createApp(): Server {
  const server = createTcpServer((socket) => {
    new Connection(socket);
  });
  return server;
}
