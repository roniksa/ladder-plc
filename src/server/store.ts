// The project lives in one JSON file. Every operation re-reads it, so the
// MCP server and a separately started web server can share the same file.

import fs from 'node:fs';
import path from 'node:path';
import { Project, emptyProject } from '../core/model.js';
import { checkProject } from '../core/ops.js';

export class ProjectStore {
  readonly path: string;

  constructor(file: string) {
    this.path = path.resolve(file);
  }

  exists(): boolean {
    return fs.existsSync(this.path);
  }

  load(): Project {
    let text: string;
    try {
      text = fs.readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyProject();
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${this.path} is not valid JSON`);
    }
    return checkProject(data, this.path);
  }

  save(project: Project): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2) + '\n');
    fs.renameSync(tmp, this.path);
  }

  update(change: (project: Project) => Project): Project {
    const next = change(this.load());
    this.save(next);
    return next;
  }

  /** Call `listener` whenever the file changes on disk. Returns a function that stops watching. */
  watch(listener: () => void): () => void {
    const handler = (curr: fs.Stats, prev: fs.Stats) => {
      if (curr.mtimeMs !== prev.mtimeMs) listener();
    };
    fs.watchFile(this.path, { interval: 250 }, handler);
    return () => fs.unwatchFile(this.path, handler);
  }
}

export function defaultProjectPath(): string {
  return process.env.LADDER_PROJECT || process.argv[2] || 'project.ladder.json';
}

export function defaultPort(): number {
  const port = Number(process.env.LADDER_PORT);
  return Number.isInteger(port) && port > 0 ? port : 4790;
}
