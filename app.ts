// app.ts — the HTTP server: one process, four surfaces.
//
//   GET  /healthz                       the env's boot probe
//   /api/v3/...                         the REST v3 surface (rest.ts)
//   POST /api/graphql                  the GraphQL v4 surface (graphql.ts)
//   POST /mcp                          the MCP endpoint (mcp.ts)
//   /{owner}/{repo}.git/...            git smart HTTP (git.ts)
//
// Everything else is a JSON 404. The server never throws from a request: a
// handler failure is a 500 JSON body and the process keeps serving.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store } from './store.ts';

const JSON_CT = 'application/json; charset=utf-8';
/** The largest request body the server reads (packs are far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'content-length': data.length, ...headers });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, status, { 'content-type': JSON_CT, ...headers }, `${JSON.stringify(value)}\n`);
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const data = chunk as Buffer;
    total += data.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks, total);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? null;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, store, expectedToken).catch((err: unknown) => {
      try {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store, expectedToken: string | null): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
    return;
  }
  const path = url.pathname;
  const headers = lowerHeaders(req);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const segments = path.split('/').filter((part) => part !== '');
  const decoded: string[] = [];
  for (const part of segments) {
    const value = decodeSegment(part);
    if (value === null) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    decoded.push(value);
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);

  // -- REST v3 ---------------------------------------------------------------
  if (decoded.length >= 2 && decoded[0] === 'api' && decoded[1] === 'v3') {
    const restReq: RestRequest = {
      method,
      segments: decoded,
      query: url.searchParams,
      headers,
      baseUrl: `http://${headers.host ?? '127.0.0.1'}`,
      body: undefined,
      bodyMalformed: false,
    };
    if (body.length > 0) {
      try {
        restReq.body = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        restReq.bodyMalformed = true;
      }
    }
    const rep = handleRest(store, { expectedToken }, restReq);
    send(res, rep.status, rep.headers, rep.body);
    return;
  }

  // -- GraphQL v4 ------------------------------------------------------------
  if (decoded.length === 2 && decoded[0] === 'api' && decoded[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const auth = headers.authorization ?? '';
    const token = /^Bearer (.+)$/.exec(auth)?.[1];
    if (!token || (expectedToken !== null && token !== expectedToken)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    let parsed: unknown;
    let malformed = false;
    if (body.length === 0) malformed = true;
    else {
      try {
        parsed = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        malformed = true;
      }
    }
    const out = handleGraphql(store, { body: parsed, bodyMalformed: malformed });
    send(res, out.status, { 'content-type': JSON_CT, 'x-github-request-id': store.nextRequestId() }, out.body);
    return;
  }

  // -- MCP -------------------------------------------------------------------
  if (decoded.length === 1 && decoded[0] === 'mcp') {
    if (method === 'DELETE') {
      send(res, 204, { 'content-type': JSON_CT }, '');
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const rep = handleMcp(store, expectedToken, { rawBody: body.toString('utf8'), authorization: headers.authorization });
    send(res, rep.status, rep.headers, rep.body);
    return;
  }

  // -- git smart HTTP --------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    if (owner === null || repoName === null) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const rest = gitMatch[3] ?? '';
    const gitReq = {
      owner,
      repoName,
      service: url.searchParams.get('service') ?? '',
      query: url.searchParams,
      headers,
      body,
    };
    if (method === 'GET' && rest === '/info/refs') {
      const rep = handleInfoRefs(store, gitReq);
      send(res, rep.status, { 'content-type': rep.contentType }, rep.body);
      return;
    }
    if (method === 'POST' && rest === '/git-upload-pack') {
      const rep = handleUploadPack(store, gitReq);
      send(res, rep.status, { 'content-type': rep.contentType }, rep.body);
      return;
    }
    if (method === 'POST' && rest === '/git-receive-pack') {
      const rep = handleReceivePack(store, gitReq);
      send(res, rep.status, { 'content-type': rep.contentType }, rep.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': store.nextRequestId() });
}
