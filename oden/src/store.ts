// Event log in SQLite. Events are stored unchanged and deduplicated on the
// envelope id, so the same event may be ingested any number of times (from the
// spool file, an overflow file and a POST) without being counted twice.
import { DatabaseSync } from 'node:sqlite';

export type Envelope = {
  v: number;
  id: string;
  received_at: string;
  harness?: string;
  host?: string;
  event?: string | null;
  session_id?: string | null;
  raw: unknown;
};

export type Source = { ino: string; offset: number };

// Returns the envelope if it looks like one Korpen wrote, otherwise null.
export function validate(o: unknown): Envelope | null {
  if (!o || typeof o !== 'object') return null;
  const e = o as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) return null;
  if (typeof e.received_at !== 'string' || isNaN(Date.parse(e.received_at))) return null;
  if (!('raw' in e)) return null;
  return e as unknown as Envelope;
}

export class Store {
  db: DatabaseSync;
  private insertStmt;
  private sinceStmt;
  private getStmt;
  private getSourceStmt;
  private setSourceStmt;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY,
        id          TEXT NOT NULL UNIQUE,
        ts          INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        harness     TEXT,
        host        TEXT,
        session_id  TEXT,
        event       TEXT,
        envelope    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
      CREATE INDEX IF NOT EXISTS events_session ON events (session_id, ts);
      -- How far each spool or overflow file has been read.
      CREATE TABLE IF NOT EXISTS sources (
        path   TEXT PRIMARY KEY,
        ino    TEXT NOT NULL,
        offset INTEGER NOT NULL
      );
    `);
    this.insertStmt = this.db.prepare(`INSERT OR IGNORE INTO events
      (id, ts, received_at, harness, host, session_id, event, envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.sinceStmt = this.db.prepare('SELECT envelope FROM events WHERE ts >= ? ORDER BY ts, seq');
    this.getStmt = this.db.prepare('SELECT envelope FROM events WHERE id = ?');
    this.getSourceStmt = this.db.prepare('SELECT ino, offset FROM sources WHERE path = ?');
    this.setSourceStmt = this.db.prepare(`INSERT INTO sources (path, ino, offset) VALUES (?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET ino = excluded.ino, offset = excluded.offset`);
  }

  // Inserts the envelopes in one transaction and returns the ones that were new.
  insert(envs: Envelope[]): Envelope[] {
    const added: Envelope[] = [];
    if (!envs.length) return added;
    this.db.exec('BEGIN');
    try {
      for (const e of envs) {
        const raw = (e.raw && typeof e.raw === 'object' ? e.raw : {}) as Record<string, unknown>;
        const event = e.event ?? (typeof raw.hook_event_name === 'string' ? raw.hook_event_name : null);
        const session = e.session_id ?? (typeof raw.session_id === 'string' ? raw.session_id : null);
        const r = this.insertStmt.run(e.id, Date.parse(e.received_at), e.received_at, e.harness ?? null,
          e.host ?? null, session, event, JSON.stringify(e));
        if (r.changes) added.push(e);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  since(ts: number): Envelope[] {
    return this.sinceStmt.all(ts).map(r => JSON.parse(r.envelope as string));
  }

  get(id: string): Envelope | null {
    const r = this.getStmt.get(id);
    return r ? JSON.parse(r.envelope as string) : null;
  }

  count(): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM events').get()!.n);
  }

  getSource(path: string): Source | null {
    const r = this.getSourceStmt.get(path);
    return r ? { ino: r.ino as string, offset: Number(r.offset) } : null;
  }

  setSource(path: string, s: Source): void {
    this.setSourceStmt.run(path, s.ino, s.offset);
  }

  close(): void {
    this.db.close();
  }
}

// A copy without the bulky parts, for the dashboard's event list. The full
// envelope is fetched on demand. tool_response is dropped (it holds whole
// files and command output) and other long strings are cut. The prompt is kept,
// since the dashboard shows its length.
export function light(e: Envelope, max = 2000): Envelope & { _light?: true } {
  let cut = false;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') {
      if (key === 'prompt' || v.length <= max) return v;
      cut = true;
      return v.slice(0, max) + '…';
    }
    if (Array.isArray(v)) return v.map(x => walk(x, ''));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'tool_response' && key === 'raw') { cut = true; continue; }
        out[k] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  const raw = walk(e.raw, 'raw');
  const out = { ...e, raw };
  return cut ? { ...out, _light: true } : out;
}
