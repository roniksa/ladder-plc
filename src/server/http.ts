// Local HTTP server for the simulator front end: static files, a small JSON
// API over the shared project file, and server-sent events on change.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpError, applyOp } from '../core/ops.js';
import { exportPlcopen } from '../core/plcopen.js';
import { validate } from '../core/validate.js';
import { ProjectStore } from './store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export interface HttpHandle {
  url: string;
  close(): void;
}

/** Start the server on 127.0.0.1. Resolves to undefined when the port is already taken. */
export function startHttp(store: ProjectStore, port: number): Promise<HttpHandle | undefined> {
  const clients = new Set<http.ServerResponse>();
  const notify = () => clients.forEach((res) => res.write('data: changed\n\n'));
  const stopWatching = store.watch(notify);

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const snapshot = () => {
    const project = store.load();
    return { project, issues: validate(project), path: store.path };
  };

  const serveFile = (res: http.ServerResponse, base: string, relative: string) => {
    const file = path.resolve(base, relative);
    if (!file.startsWith(path.resolve(base) + path.sep) || !MIME[path.extname(file)]) return json(res, 404, { error: 'Not found' });
    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) reject(new Error('Request too large'));
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // Only answer requests addressed to this machine (guards against DNS rebinding).
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname;

      if (req.method === 'GET') {
        if (route === '/') return serveFile(res, path.join(ROOT, 'public'), 'index.html');
        if (route === '/style.css') return serveFile(res, path.join(ROOT, 'public'), 'style.css');
        if (route.startsWith('/web/') || route.startsWith('/core/')) return serveFile(res, path.join(ROOT, 'dist'), route.slice(1));
        if (route === '/api/project') return json(res, 200, snapshot());
        if (route === '/api/export.xml') {
          const project = store.load();
          const name = (project.name || 'project').replace(/[^A-Za-z0-9_-]+/g, '_');
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.xml"`, 'Cache-Control': 'no-store' });
          return res.end(exportPlcopen(project));
        }
        if (route === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write('retry: 1000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        return json(res, 404, { error: 'Not found' });
      }

      if (req.method === 'POST' && route === '/api/op') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Send JSON' });
        const body = JSON.parse(await readBody(req));
        try {
          store.update((project) => applyOp(project, String(body.op), body.args ?? {}));
        } catch (e) {
          if (e instanceof OpError) return json(res, 400, { error: e.message });
          throw e;
        }
        notify();
        return json(res, 200, snapshot());
      }

      return json(res, 405, { error: 'Method not allowed' });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  // "localhost" may resolve to IPv4 or IPv6 depending on the client, so
  // listen on both loopback addresses. IPv6 is optional.
  const server = http.createServer(handler);
  const server6 = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      stopWatching();
      if (e.code === 'EADDRINUSE') resolve(undefined);
      else reject(e);
    });
    server.listen(port, '127.0.0.1', () => {
      server6.once('error', () => undefined);
      server6.listen(port, '::1');
      resolve({
        url: `http://localhost:${port}`,
        close: () => {
          stopWatching();
          clients.forEach((res) => res.end());
          server.close();
          server6.close();
        },
      });
    });
  });
}
