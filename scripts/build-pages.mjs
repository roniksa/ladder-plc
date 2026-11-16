// Assemble the static site for GitHub Pages in ./site.
// Run after the TypeScript build: npm run build:pages
//
// The site is the simulator front end with the project kept in the browser
// (no server), so it needs only the page, the styles and the compiled
// browser and core modules. Every path in it is relative, so it works under
// https://<user>.github.io/<repository>/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'site');
const from = (...parts) => path.join(root, ...parts);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The page, switched to browser storage.
const marker = '<meta name="ladder-backend" content="server" />';
const page = fs.readFileSync(from('public', 'index.html'), 'utf8');
if (!page.includes(marker)) throw new Error(`public/index.html is missing ${marker}`);
fs.writeFileSync(path.join(out, 'index.html'), page.replace(marker, '<meta name="ladder-backend" content="local" />'));
fs.copyFileSync(from('public', 'style.css'), path.join(out, 'style.css'));

// Compiled modules. The browser imports ../core/*.js from web/*.js.
let modules = 0;
for (const dir of ['web', 'core']) {
  const source = from('dist', dir);
  if (!fs.existsSync(source)) throw new Error('dist/ is missing: run "npm run build" first');
  fs.mkdirSync(path.join(out, dir));
  for (const file of fs.readdirSync(source)) {
    if (!file.endsWith('.js')) continue;
    fs.copyFileSync(path.join(source, file), path.join(out, dir, file));
    modules++;
  }
}

// The project a first-time visitor starts with.
fs.copyFileSync(from('project.ladder.json'), path.join(out, 'demo.ladder.json'));

// Serve the files as they are, without Jekyll processing.
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Static site written to ${path.relative(process.cwd(), out) || '.'} (${modules} modules)`);
