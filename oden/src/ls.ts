// `oden ls`: sessions with derived status, read straight from the spool file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initial, reduce, view, type SessionView, type Status } from './derive.ts';
import { Store } from './store.ts';
import { Tailer } from './tail.ts';

const ORDER: Record<Status, number> = { waiting_permission: 0, waiting_input: 1, working: 2, started: 3, stale: 4, ended: 5 };
const LABEL: Record<Status, string> = {
  waiting_permission: '⏸ väntar på tillstånd',
  waiting_input: '● väntar på dig',
  working: '▶ jobbar',
  started: '▷ startad',
  stale: '○ inaktiv',
  ended: '■ avslutad',
};
const DAY = 24 * 3600_000;

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// Waiting for you first (longest wait at the top), then working, then the rest.
export function sortSessions(list: SessionView[]): SessionView[] {
  return [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.since - b.since);
}

// Sessions shown by default: everything that is not over, and stale sessions
// from the last day (they may have crashed). --all shows ended ones too.
export function visible(list: SessionView[], now: number, all: boolean): SessionView[] {
  if (all) return list;
  return list.filter(s => s.status !== 'ended' && !(s.status === 'stale' && now - s.last > DAY));
}

export function table(list: SessionView[], now: number, opts: { color?: boolean; width?: number } = {}): string {
  const color = opts.color ?? false;
  const paint = (s: Status, text: string) => {
    if (!color) return text;
    const code = { waiting_permission: '1;31', waiting_input: '1;33', working: '32', started: '36', stale: '2', ended: '2' }[s];
    return `\x1b[${code}m${text}\x1b[0m`;
  };
  const rows = list.map(s => [
    LABEL[s.status] + (s.tool && (s.status === 'working' || s.status === 'waiting_permission') ? ` · ${s.tool}` : ''),
    fmtAge(now - s.since),
    s.repo ?? '?',
    s.id.slice(0, 8),
    String(s.turns),
    (s.status === 'working' || s.status === 'waiting_permission') && s.detail ? s.detail : s.prompt ? `”${s.prompt}”` : '',
  ]);
  const head = ['STATUS', 'SEDAN', 'REPO', 'SESSION', 'TURER', 'DETALJ'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => [...r[i]].length)));
  const pad = (v: string, n: number) => v + ' '.repeat(Math.max(0, n - [...v].length));
  const width = opts.width ?? Infinity;
  const line = (r: string[]) => {
    const fixed = r.slice(0, 5).map((v, i) => pad(v, w[i])).join('  ') + '  ';
    const room = Math.max(10, width - [...fixed].length);
    const detail = [...r[5]].length > room ? [...r[5]].slice(0, room - 1).join('') + '…' : r[5];
    return (fixed + detail).trimEnd();
  };
  const out = [line(head)];
  list.forEach((s, i) => out.push(paint(s.status, line(rows[i]))));
  return out.join('\n');
}

export function summary(list: SessionView[]): string {
  const n = (st: Status) => list.filter(s => s.status === st).length;
  const waiting = n('waiting_permission') + n('waiting_input');
  return `${list.length} sessioner · ${waiting} väntar på dig · ${n('working')} jobbar`;
}

export function ls(home: string, opts: { all?: boolean; watch?: boolean }): void {
  if (!existsSync(join(home, 'spool.jsonl'))) {
    console.error(`Hittar ingen spool-fil i ${home}. Har du kört raven/install.sh och startat om Claude Code?`);
    process.exitCode = 1;
    return;
  }
  const store = new Store(':memory:');
  const st = initial();
  const tail = new Tailer(home, store, added => {
    added.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at)).forEach(e => reduce(st, e));
  });
  const print = () => {
    tail.poll();
    const now = Date.now();
    const list = sortSessions(visible(view(st, now).sessions, now, !!opts.all));
    const tty = process.stdout.isTTY;
    const text = list.length
      ? table(list, now, { color: tty, width: tty ? process.stdout.columns : undefined }) + '\n\n' + summary(list)
      : opts.all ? 'Inga sessioner i spool-filen.' : 'Inga aktiva sessioner. Visa även avslutade med --all.';
    if (opts.watch) process.stdout.write('\x1b[H\x1b[2J' + text + `\n\nUppdateras varje sekund · Ctrl-C avslutar\n`);
    else console.log(text);
  };
  print();
  if (opts.watch) setInterval(print, 1000);
}
