// Follows Korpen's spool file and overflow files and inserts new lines into
// the store. The read offset per file is saved in the database, so a restart
// continues where it stopped. If a file is replaced or truncated it is read
// from the start again, which is safe because inserts are deduplicated.
import { closeSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { type Envelope, type Store, validate } from './store.ts';

const CHUNK = 4 * 1024 * 1024;

export type TailStats = { added: number; bad: number };

export class Tailer {
  home: string;
  store: Store;
  onEvents: (added: Envelope[]) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private busy = false;

  constructor(home: string, store: Store, onEvents: (added: Envelope[]) => void = () => {}) {
    this.home = home;
    this.store = store;
    this.onEvents = onEvents;
  }

  files(): string[] {
    const out = [join(this.home, 'spool.jsonl')];
    try {
      for (const f of readdirSync(join(this.home, 'overflow')).sort()) {
        if (f.endsWith('.jsonl')) out.push(join(this.home, 'overflow', f));
      }
    } catch { /* no overflow directory yet */ }
    return out;
  }

  // Reads everything new in all files. Returns what was added.
  poll(): TailStats {
    const stats = { added: 0, bad: 0 };
    if (this.busy) return stats;
    this.busy = true;
    try {
      for (const f of this.files()) {
        const s = this.readFile(f);
        stats.added += s.added;
        stats.bad += s.bad;
      }
    } finally {
      this.busy = false;
    }
    if (stats.bad) console.error(`oden: ${stats.bad} rader i spool-filerna gick inte att läsa och hoppades över`);
    return stats;
  }

  readFile(path: string): TailStats {
    const stats = { added: 0, bad: 0 };
    let st;
    try { st = statSync(path, { bigint: true }); } catch { return stats; }
    const ino = String(st.ino), size = Number(st.size);
    const src = this.store.getSource(path);
    let offset = src && src.ino === ino && src.offset <= size ? src.offset : 0;
    if (offset >= size) return stats;

    const fd = openSync(path, 'r');
    try {
      let len = Math.min(CHUNK, size - offset);
      while (offset < size) {
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        const end = buf.subarray(0, n).lastIndexOf(10);
        if (end < 0) {
          // No complete line yet. Read more if the line is longer than the
          // chunk, otherwise wait for Korpen to finish writing it.
          if (offset + n >= size) break;
          len *= 2;
          continue;
        }
        const envs: Envelope[] = [];
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let e: Envelope | null = null;
          try { e = validate(JSON.parse(line)); } catch { /* counted below */ }
          if (e) envs.push(e); else stats.bad++;
        }
        const added = this.store.insert(envs);
        offset += end + 1;
        this.store.setSource(path, { ino, offset });
        stats.added += added.length;
        if (added.length) this.onEvents(added);
        len = Math.min(CHUNK, size - offset) || CHUNK;
      }
    } finally {
      closeSync(fd);
    }
    return stats;
  }

  // Polls on an interval and, where the OS supports it, as soon as the
  // directory changes.
  start(intervalMs = 500): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
    try {
      let pending = false;
      this.watcher = watch(this.home, { recursive: true }, () => {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; this.poll(); }, 30);
      });
    } catch { /* polling is enough */ }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
  }
}
