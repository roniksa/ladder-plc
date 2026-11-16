#!/usr/bin/env node
// Standalone entry point: serves the simulator front end without the MCP server.

import { startHttp } from './http.js';
import { ProjectStore, defaultPort, defaultProjectPath } from './store.js';

const store = new ProjectStore(defaultProjectPath());
const port = defaultPort();
const handle = await startHttp(store, port);
if (!handle) {
  console.error(`Port ${port} is already in use. The simulator may already be running at http://localhost:${port}, or set LADDER_PORT to another port.`);
  process.exit(1);
}
console.log(`Ladder simulator: ${handle.url}`);
console.log(`Project file: ${store.path}`);
