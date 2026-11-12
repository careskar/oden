// The Oden daemon (plan, section 5): ingest, event log, processor and read API
// in one process. Listens on 127.0.0.1 only.
//
//   POST /ingest            one or more envelopes (JSON or JSONL), e.g. from Korpen's ODEN_INGEST_URL
//   GET  /api/view?from=ms  derived sessions and intervals plus a brief event list
//   GET  /api/events/:id    one full envelope
//   GET  /api/stream        Server-Sent Events: "change" whenever new events arrive
//   GET  /                  the dashboard
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initial, reduce, toolDetail, view, type State } from './derive.ts';
import { type Envelope, Store, validate } from './store.ts';
import { Tailer } from './tail.ts';

const MAX_BODY = 16 * 1024 * 1024;
const webDir = join(import.meta.dirname, '../web');

// A short row for the dashboard's event list. The full envelope is fetched on click.
export type Brief = { id: string; t: number; event: string; sid: string; tool: string | null; detail: string };

export function brief(e: Envelope): Brief {
  const r = (e.raw && typeof e.raw === 'object' ? e.raw : {}) as Record<string, unknown>;
  const event = e.event ?? (r.hook_event_name as string) ?? 'Okänt';
  const s = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : '');
  let detail = '';
  switch (event) {
    case 'UserPromptSubmit': { const p = s('prompt'); detail = p ? `”${p.slice(0, 200)}” (${p.length} tecken)` : ''; break; }
    case 'PreToolUse': case 'PostToolUse': case 'PermissionRequest': detail = toolDetail(r.tool_input); break;
    case 'PostToolUseFailure': detail = s('error').slice(0, 200); break;
    case 'Notification': detail = s('message'); break;
    case 'SessionStart': detail = `source: ${s('source')}`; break;
    case 'SessionEnd': detail = `reason: ${s('reason')}`; break;
    case 'PreCompact': detail = `trigger: ${s('trigger')}`; break;
    case 'SubagentStart': case 'SubagentStop': detail = s('agent_type'); break;
  }
  return {
    id: e.id, t: Date.parse(e.received_at), event,
    sid: e.session_id ?? (s('session_id') || 'okänd'), tool: s('tool_name') || null, detail,
  };
}

export type Daemon = { server: Server; store: Store; tail: Tailer | null; state: State; close: () => Promise<void> };

export function startDaemon(opts: { home: string; port: number; db?: string; tail?: boolean }): Promise<Daemon> {
  const store = new Store(opts.db ?? join(opts.home, 'oden.db'));
  // Rebuild the read model from the event log (event sourcing).
  const state = initial();
  const briefs: Brief[] = [];
  for (const e of store.since(-Infinity)) { reduce(state, e); briefs.push(brief(e)); }

  const clients = new Set<ServerResponse>();
  let pending: ReturnType<typeof setTimeout> | null = null;
  const accept = (added: Envelope[]) => {
    if (!added.length) return;
    added.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
    for (const e of added) { reduce(state, e); briefs.push(brief(e)); }
    // Arrival order can differ slightly from time order across sessions.
    if (briefs.length > added.length && briefs[briefs.length - added.length - 1].t > briefs[briefs.length - added.length].t) {
      briefs.sort((a, b) => a.t - b.t);
    }
    // Coalesce bursts (a tool call is 2–3 events within milliseconds).
    if (!pending) pending = setTimeout(() => {
      pending = null;
      for (const c of clients) c.write(`event: change\ndata: ${JSON.stringify({ count: briefs.length })}\n\n`);
    }, 100);
  };

  const tail = opts.tail === false ? null : new Tailer(opts.home, store, accept);

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/ingest') {
        const text = await readBody(req);
        const envs: Envelope[] = [];
        let bad = 0;
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let e: Envelope | null = null;
          try { e = validate(JSON.parse(line)); } catch { /* counted */ }
          if (e) envs.push(e); else bad++;
        }
        const added = store.insert(envs);
        accept(added);
        return json(res, bad && !envs.length ? 400 : 202, { inserted: added.length, duplicates: envs.length - added.length, bad });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(join(webDir, 'index.html')));
      }
      if (url.pathname === '/api/view') {
        const now = Date.now();
        const fromParam = url.searchParams.get('from');
        const from = fromParam ? Number(fromParam) : -Infinity;
        const session = url.searchParams.get('session') || undefined;
        const v = view(state, now, { from, session });
        const events = briefs.filter(b => b.t >= from && (!session || b.sid === session));
        return json(res, 200, { ...v, events, total: briefs.length });
      }
      const m = url.pathname.match(/^\/api\/events\/([^/]+)$/);
      if (m) {
        const e = store.get(decodeURIComponent(m[1]));
        return e ? json(res, 200, e) : json(res, 404, { error: 'not found' });
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: change\ndata: ${JSON.stringify({ count: briefs.length })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, events: briefs.length });
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      tail?.start();
      resolve({
        server, store, tail, state,
        close: () => new Promise(done => {
          tail?.stop();
          for (const c of clients) c.end();
          server.close(() => { store.close(); done(); });
        }),
      });
    });
  });
}
