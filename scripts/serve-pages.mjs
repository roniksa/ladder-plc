// Preview the static site the way GitHub Pages serves it: under a
// sub-path, with no API. Run: npm run preview:pages

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../site', import.meta.url));
const port = Number(process.env.PAGES_PORT) || 4791;
const base = '/ladder-plc/';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

if (!fs.existsSync(path.join(site, 'index.html'))) {
  console.error('site/ is missing: run "npm run build:pages" first');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const route = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (route === '/' || route === base.slice(0, -1)) {
    res.writeHead(302, { Location: base });
    return res.end();
  }
  const relative = route.startsWith(base) ? route.slice(base.length) || 'index.html' : null;
  const file = relative === null ? null : path.resolve(site, relative);
  if (!file || !file.startsWith(site + path.sep) || !types[path.extname(file)]) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => console.log(`Static site preview: http://localhost:${port}${base}`));
