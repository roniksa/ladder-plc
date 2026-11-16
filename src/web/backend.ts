// Where the project lives. With the local Node server it is the shared
// project file, reached over the HTTP API. On a static host (GitHub Pages)
// there is no server, so the project is kept in this browser's storage and
// the same editing operations run in the page.

import { Project, emptyProject } from '../core/model.js';
import { applyOp, checkProject } from '../core/ops.js';
import { Issue, validate } from '../core/validate.js';

export interface Snapshot {
  project: Project;
  issues: Issue[];
  /** Shown under the project name: the file path, or where the browser keeps it. */
  path: string;
}

export interface Backend {
  /** True when the project is stored in this browser and file controls apply. */
  readonly local: boolean;
  load(): Promise<Snapshot>;
  /** Apply an edit. Rejects with a user-facing message when it is refused. */
  op(name: string, args: Record<string, unknown>): Promise<Snapshot>;
  /** Call `listener` when the project changes somewhere else (the chat, another tab). */
  onChange(listener: () => void): void;
}

/** The extra controls a browser-stored project offers. */
export interface LocalBackend extends Backend {
  /** Replace the whole project, from an opened file or a new one. */
  replace(data: unknown): Snapshot;
  /** Load the bundled demo project. */
  loadDemo(): Promise<Snapshot>;
  undo(): Snapshot | undefined;
  redo(): Snapshot | undefined;
  canUndo(): boolean;
  canRedo(): boolean;
}

// ---------------------------------------------------------------- server

class ServerBackend implements Backend {
  readonly local = false;

  private async request(url: string, init?: RequestInit): Promise<Snapshot> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(`Could not reach the server: ${e instanceof Error ? e.message : e}`);
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? 'The change was rejected');
    return body;
  }

  load(): Promise<Snapshot> {
    return this.request('api/project');
  }

  op(name: string, args: Record<string, unknown>): Promise<Snapshot> {
    return this.request('api/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: name, args }) });
  }

  onChange(listener: () => void): void {
    new EventSource('api/events').onmessage = listener;
  }
}

// ---------------------------------------------------------------- browser storage

const STORAGE_KEY = 'ladder-plc:project';
const HISTORY_LIMIT = 100;

class BrowserBackend implements LocalBackend {
  readonly local = true;
  private project: Project | undefined;
  private persistent = true;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private read(): Project | undefined {
    try {
      const text = window.localStorage.getItem(STORAGE_KEY);
      return text ? checkProject(JSON.parse(text)) : undefined;
    } catch {
      return undefined;
    }
  }

  private write(project: Project): void {
    this.project = project;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      this.persistent = true;
    } catch {
      // Storage is blocked or full: keep working in memory for this visit.
      this.persistent = false;
    }
  }

  private snapshot(): Snapshot {
    const project = this.project ?? emptyProject();
    return {
      project,
      issues: validate(project),
      path: this.persistent ? 'Saved in this browser' : 'Not saved: browser storage is unavailable',
    };
  }

  /** Store a new version, remembering the previous one for undo. */
  private commit(next: Project): Snapshot {
    if (this.project) {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.write(next);
    return this.snapshot();
  }

  private async fetchDemo(): Promise<Project> {
    const res = await fetch('demo.ladder.json');
    if (!res.ok) throw new Error('The demo project could not be loaded');
    return checkProject(await res.json(), 'The demo project');
  }

  async load(): Promise<Snapshot> {
    const stored = this.read();
    if (stored) {
      this.project = stored;
    } else if (!this.project) {
      // First visit: start from the demo so there is something to operate.
      let first: Project;
      try {
        first = await this.fetchDemo();
      } catch {
        first = emptyProject();
      }
      this.write(first);
    }
    return this.snapshot();
  }

  async op(name: string, args: Record<string, unknown>): Promise<Snapshot> {
    // Re-read first so an edit made in another tab is not overwritten.
    const current = this.read() ?? this.project ?? emptyProject();
    this.project = current;
    return this.commit(applyOp(current, name, args));
  }

  onChange(listener: () => void): void {
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) listener();
    });
  }

  replace(data: unknown): Snapshot {
    return this.commit(checkProject(data));
  }

  async loadDemo(): Promise<Snapshot> {
    return this.commit(await this.fetchDemo());
  }

  private step(from: string[], to: string[]): Snapshot | undefined {
    const text = from.pop();
    if (text === undefined) return undefined;
    if (this.project) to.push(JSON.stringify(this.project));
    this.write(JSON.parse(text));
    return this.snapshot();
  }

  undo(): Snapshot | undefined {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): Snapshot | undefined {
    return this.step(this.redoStack, this.undoStack);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

/** The page says which backend it was built for: <meta name="ladder-backend" content="local">. */
export function createBackend(): Backend | LocalBackend {
  const mode = document.querySelector('meta[name="ladder-backend"]')?.getAttribute('content');
  return mode === 'local' ? new BrowserBackend() : new ServerBackend();
}

export function isLocal(backend: Backend): backend is LocalBackend {
  return backend.local;
}
