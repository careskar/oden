// The status machine and the pairing of events into intervals (plan, section 7
// and 10). One reducer is shared by `oden ls`, the daemon and the dashboard, so
// they always agree.
//
// reduce(state, event) has no I/O and depends only on its input: replaying the
// same events gives the same state. For speed it updates the state it is given
// and returns it. view() reads the state at a point in time without changing it.
//
// What real Claude Code sessions send is documented in docs/hook-events.md. In
// short: interrupted turns send no Stop, denied tools send no Post,
// PermissionRequest has no tool_use_id, duration_ms excludes waiting for
// permission, and internal agents send SubagentStop without SubagentStart.
import type { Envelope } from './store.ts';

export const STALE_MS = 15 * 60_000;

export type Status = 'started' | 'working' | 'waiting_permission' | 'waiting_input' | 'ended' | 'stale';

export type ToolCall = {
  sid: string; id: string; tool: string; agent: string | null; detail: string;
  start: number; end?: number; ok?: boolean; dur?: number | null;
  perm: boolean; aborted?: boolean; open?: boolean;
};
export type Turn = {
  sid: string; start: number; end?: number; prompt: string; tools: number;
  auto: boolean; interrupted?: boolean; open?: boolean;
};
export type Wait = { sid: string; start: number; end?: number; open?: boolean; tool?: string; denied?: boolean };
export type Agent = { sid: string; id: string; type: string; start: number; end?: number; open?: boolean };
export type Compact = { sid: string; t: number; trigger: string | null };

export type Session = {
  id: string; harness: string | null; host: string | null; cwd: string | null; repo: string | null;
  first: number; last: number;
  status: Status; since: number;          // status and when it was entered
  tool: string | null; detail: string;    // current tool call, if any
  turns: number; interrupted: number; prompt: string | null;
  model: string | null; endReason: string | null;
  // Internal bookkeeping for open intervals.
  turn: Turn | null; stopAt: number | null; perm: (Wait & { call?: ToolCall }) | null;
};

export type State = {
  sessions: Record<string, Session>;
  tools: ToolCall[]; turns: Turn[]; waitsHuman: Wait[]; waitsPerm: Wait[]; agents: Agent[]; compacts: Compact[];
  openTools: Record<string, ToolCall>; openAgents: Record<string, Agent>;
};

export function initial(): State {
  return { sessions: {}, tools: [], turns: [], waitsHuman: [], waitsPerm: [], agents: [], compacts: [], openTools: {}, openAgents: {} };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const cut = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

// A one-line summary of a tool input: the command, path, pattern or URL.
export function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'pattern', 'url', 'description', 'prompt']) {
    if (typeof i[k] === 'string' && i[k]) return cut((i[k] as string).replace(/\s+/g, ' ').trim());
  }
  return '';
}

function setStatus(s: Session, status: Status, t: number) {
  if (s.status !== status) { s.status = status; s.since = t; }
}

// Closes what is still open in a session. Claude Code sends no Stop and no
// Post when a turn is interrupted (Esc) or a permission is denied interactively,
// so those intervals are closed by the next event instead.
function closeOpen(st: State, s: Session, t: number, interrupted: boolean) {
  if (s.turn) {
    st.turns.push(Object.assign(s.turn, { end: t, interrupted }));
    if (interrupted) s.interrupted++;
    s.turn = null;
  }
  if (s.perm) { const { call, ...w } = s.perm; st.waitsPerm.push({ ...w, end: t, denied: true }); s.perm = null; }
  for (const [k, o] of Object.entries(st.openTools)) {
    if (o.sid === s.id) { st.tools.push(Object.assign(o, { end: t, ok: false, aborted: true })); delete st.openTools[k]; }
  }
  s.tool = null; s.detail = '';
}

export function reduce(st: State, e: Envelope): State {
  const t = Date.parse(e.received_at);
  const r = (e.raw && typeof e.raw === 'object' ? e.raw : {}) as Record<string, unknown>;
  const name = e.event ?? str(r.hook_event_name);
  const sid = e.session_id ?? str(r.session_id);
  if (!sid || !name || isNaN(t)) return st;

  let s = st.sessions[sid];
  if (!s) {
    s = st.sessions[sid] = {
      id: sid, harness: e.harness ?? null, host: e.host ?? null, cwd: null, repo: null,
      first: t, last: t, status: 'started', since: t, tool: null, detail: '',
      turns: 0, interrupted: 0, prompt: null, model: null, endReason: null,
      turn: null, stopAt: null, perm: null,
    };
  }
  const prev = s.last;
  s.last = Math.max(s.last, t);
  const cwd = str(r.cwd);
  if (cwd && !s.cwd) { s.cwd = cwd; s.repo = cwd.split('/').filter(Boolean).pop() || '/'; }
  const agent = str(r.agent_id);

  switch (name) {
    case 'SessionStart':
      // --resume and --continue reopen a session that has ended.
      if (s.status === 'ended') { setStatus(s, 'started', t); s.endReason = null; }
      if (str(r.model)) s.model = str(r.model);
      break;

    case 'UserPromptSubmit': {
      // A finished background job starts a turn too, but it is not your prompt.
      const prompt = str(r.prompt) ?? '';
      const auto = prompt.startsWith('<task-notification>');
      if (s.turn) closeOpen(st, s, prev, true);
      if (s.stopAt != null) {
        if (!auto) st.waitsHuman.push({ sid, start: s.stopAt, end: t });
        s.stopAt = null;
      }
      s.turn = { sid, start: t, prompt: auto ? 'Bakgrundsjobb klart' : prompt, tools: 0, auto };
      if (!auto) s.prompt = cut(prompt.replace(/\s+/g, ' ').trim());
      s.turns++;
      setStatus(s, 'working', t);
      break;
    }

    case 'PreToolUse': {
      const id = str(r.tool_use_id) ?? `${sid}:${t}`;
      const call: ToolCall = { sid, id, tool: str(r.tool_name) ?? '?', agent, detail: toolDetail(r.tool_input), start: t, perm: false };
      st.openTools[id] = call;
      s.tool = call.tool; s.detail = call.detail;
      if (s.turn) s.turn.tools++;
      setStatus(s, 'working', t);
      break;
    }

    case 'PermissionRequest': {
      // No tool_use_id: pair with the latest open call of the same tool and agent.
      const tool = str(r.tool_name);
      const call = Object.values(st.openTools).filter(o => o.sid === sid && o.tool === tool && o.agent === agent).pop();
      if (call) call.perm = true;
      s.perm = { sid, start: t, tool: tool ?? undefined, call };
      setStatus(s, 'waiting_permission', t);
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const id = str(r.tool_use_id);
      const o = id ? st.openTools[id] : undefined;
      const dur = typeof r.duration_ms === 'number' ? r.duration_ms : null;
      if (o && id) { st.tools.push(Object.assign(o, { end: t, ok: name === 'PostToolUse', dur })); delete st.openTools[id]; }
      if (s.perm && (!s.perm.call || s.perm.call === o)) {
        // You answered roughly when the tool started running.
        const { call, ...w } = s.perm;
        st.waitsPerm.push({ ...w, end: dur != null ? Math.max(w.start, t - dur) : t });
        s.perm = null;
      }
      // Another call of the same session may still be open (parallel tools).
      const still = Object.values(st.openTools).filter(c => c.sid === sid).pop();
      s.tool = still ? still.tool : null; s.detail = still ? still.detail : '';
      setStatus(s, s.perm ? 'waiting_permission' : 'working', t);
      break;
    }

    case 'SubagentStart': {
      const id = str(r.agent_id);
      if (id) st.openAgents[id] = { sid, id, type: str(r.agent_type) ?? '', start: t };
      break;
    }

    case 'SubagentStop': {
      // Internal agents send SubagentStop without a start: skip them.
      const id = str(r.agent_id);
      const a = id ? st.openAgents[id] : undefined;
      if (a && id) { st.agents.push(Object.assign(a, { end: t })); delete st.openAgents[id]; }
      break;
    }

    case 'Stop':
      // Calls without a Post at Stop were denied (headless) or interrupted.
      closeOpen(st, s, t, false);
      s.stopAt = t;
      setStatus(s, 'waiting_input', t);
      break;

    case 'PreCompact':
      st.compacts.push({ sid, t, trigger: str(r.trigger) });
      break;

    case 'SessionEnd':
      closeOpen(st, s, t, false);
      for (const [k, a] of Object.entries(st.openAgents)) {
        if (a.sid === sid) { st.agents.push(Object.assign(a, { end: t })); delete st.openAgents[k]; }
      }
      s.stopAt = null;
      s.endReason = str(r.reason);
      setStatus(s, 'ended', t);
      break;
  }
  return st;
}

export function fold(events: Envelope[], st: State = initial()): State {
  for (const e of events) reduce(st, e);
  return st;
}

// The status at a given time: a session without events for a long time is
// stale (crash, kill -9, or a turn interrupted during a tool, which sends
// nothing at all).
export function statusAt(s: Session, now: number, staleMs = STALE_MS): { status: Status; since: number } {
  if (s.status !== 'ended' && now - s.last > staleMs) return { status: 'stale', since: s.last + staleMs };
  return { status: s.status, since: s.since };
}

export type SessionView = Omit<Session, 'turn' | 'stopAt' | 'perm'>;

export type View = {
  now: number;
  sessions: SessionView[];
  tools: ToolCall[]; turns: Turn[]; waitsHuman: Wait[]; waitsPerm: Wait[]; agents: Agent[]; compacts: Compact[];
};

// A snapshot at `now`, with open intervals closed at `now` and marked open.
// `from` drops intervals that ended before it; `session` keeps one session.
export function view(st: State, now: number, opts: { from?: number; session?: string; staleMs?: number } = {}): View {
  const from = opts.from ?? -Infinity;
  const keep = (sid: string, end: number) => end >= from && (!opts.session || sid === opts.session);
  const out: View = { now, sessions: [], tools: [], turns: [], waitsHuman: [], waitsPerm: [], agents: [], compacts: [] };

  for (const s of Object.values(st.sessions)) {
    const { turn, stopAt, perm, ...rest } = s;
    const { status, since } = statusAt(s, now, opts.staleMs);
    if (!keep(s.id, s.status === 'ended' ? s.last : now)) continue;
    out.sessions.push({ ...rest, status, since });
    if (turn) out.turns.push({ ...turn, end: now, open: true });
    if (stopAt != null && s.status !== 'ended') out.waitsHuman.push({ sid: s.id, start: stopAt, end: now, open: true });
    if (perm) { const { call, ...w } = perm; out.waitsPerm.push({ ...w, end: now, open: true }); }
  }
  for (const o of Object.values(st.openTools)) if (keep(o.sid, now)) out.tools.push({ ...o, end: now, open: true });
  for (const a of Object.values(st.openAgents)) if (keep(a.sid, now)) out.agents.push({ ...a, end: now, open: true });

  out.tools.push(...st.tools.filter(x => keep(x.sid, x.end!)));
  out.turns.push(...st.turns.filter(x => keep(x.sid, x.end!)));
  out.waitsHuman.push(...st.waitsHuman.filter(x => keep(x.sid, x.end!)));
  out.waitsPerm.push(...st.waitsPerm.filter(x => keep(x.sid, x.end!)));
  out.agents.push(...st.agents.filter(x => keep(x.sid, x.end!)));
  out.compacts.push(...st.compacts.filter(x => keep(x.sid, x.t)));
  out.sessions.sort((a, b) => a.first - b.first);
  return out;
}
