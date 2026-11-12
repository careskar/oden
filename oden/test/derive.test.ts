// The status machine against the real sessions in testdata/claude-code
// (issue #6). Expected outcomes are listed in testdata/claude-code/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold, initial, reduce, statusAt, view, STALE_MS } from '../src/derive.ts';
import type { Envelope } from '../src/store.ts';

const dir = join(import.meta.dirname, '../../testdata/claude-code');
const load = (name: string): Envelope[] =>
  readFileSync(join(dir, name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const lastT = (evs: Envelope[]) => Date.parse(evs[evs.length - 1].received_at);
const sessions = (name: string) => {
  const evs = load(name);
  const st = fold(evs);
  return { evs, st, list: Object.values(st.sessions) };
};

test('01 enkel tur: one turn, one tool, ended', () => {
  const { st, list } = sessions('01-enkel-tur');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'ended');
  assert.equal(list[0].turns, 1);
  assert.equal(st.tools.length, 1);
  assert.equal(st.tools[0].ok, true);
  assert.equal(typeof st.tools[0].dur, 'number');
});

test('02 headless: denied Bash is aborted, failed Read is a failure', () => {
  const { st, list } = sessions('02-verktygsfel-och-nekat-headless');
  assert.equal(list[0].status, 'ended');
  const bash = st.tools.find(t => t.tool === 'Bash')!;
  const read = st.tools.find(t => t.tool === 'Read')!;
  assert.equal(bash.aborted, true);
  assert.equal(bash.perm, true);
  assert.equal(read.ok, false);
  assert.ok(!read.aborted);
  assert.equal(st.waitsPerm.length, 1);
  assert.equal(st.waitsPerm[0].denied, true);
});

test('03 subagent: one agent, its tool call keeps the agent id', () => {
  const { st } = sessions('03-subagent');
  assert.equal(st.agents.length, 1);
  assert.equal(st.agents[0].type, 'Explore');
  assert.ok(st.tools.some(t => t.tool === 'Bash' && t.agent === st.agents[0].id));
  assert.ok(st.tools.some(t => t.tool === 'Agent' && t.agent === null));
});

test('04 three parallel sessions are kept apart', () => {
  const { list } = sessions('04-tre-parallella-sessioner');
  assert.equal(list.length, 3);
  for (const s of list) {
    assert.equal(s.status, 'ended');
    assert.equal(s.turns, 1);
  }
});

test('05 resume and compact: one session reopened, one compaction', () => {
  const { st, list } = sessions('05-resume-och-compact');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'ended');
  assert.equal(list[0].turns, 3);
  assert.equal(st.compacts.length, 1);
  assert.equal(st.compacts[0].trigger, 'manual');
  assert.equal(st.agents.length, 0, 'internal SubagentStop is skipped');
});

test('05 a resumed session is not ended between SessionStart and SessionEnd', () => {
  const evs = load('05-resume-och-compact');
  const st = initial();
  const i = evs.findIndex((e, k) => k > 0 && e.event === 'SessionStart');
  evs.slice(0, i + 1).forEach(e => reduce(st, e));
  assert.equal(Object.values(st.sessions)[0].status, 'started');
});

test('06 headless permission denied: Stop comes, session waits for input before it ends', () => {
  const evs = load('06-tillstand-nekat-headless');
  const st = fold(evs.filter(e => e.event !== 'SessionEnd'));
  const s = Object.values(st.sessions)[0];
  assert.equal(s.status, 'waiting_input');
  assert.equal(st.tools[0].aborted, true);
});

test('07 interactive: permission, background job, Esc, /clear, kill -9', () => {
  const { evs, st, list } = sessions('07-interaktiv-tillstand-bakgrund-esc-clear-idle-kill');
  assert.equal(list.length, 2, '/clear starts a new session');
  const [first, second] = list.sort((a, b) => a.first - b.first);
  assert.equal(first.status, 'ended');
  assert.equal(first.endReason, 'clear');
  assert.equal(first.interrupted, 2, 'two prompts interrupted with Esc');
  // The approved Bash call: duration_ms excludes the ~20 s wait for permission.
  const bash = st.tools.find(t => t.perm && t.ok)!;
  assert.ok(bash.dur! < 1000);
  assert.ok(bash.end! - bash.start > 10_000);
  // The background job's turn is not counted as your prompt or your wait.
  assert.ok(st.turns.some(t => t.auto));
  assert.ok(!first.prompt!.startsWith('<task-notification>'));
  // After kill -9 the second session waits for input, then goes stale.
  const end = lastT(evs);
  assert.equal(statusAt(second, end).status, 'waiting_input');
  assert.equal(statusAt(second, end + STALE_MS + 1).status, 'stale');
});

test('08 interactive deny: waiting for permission, then ended by /exit', () => {
  const evs = load('08-interaktiv-nekat-och-exit');
  const before = fold(evs.filter(e => e.event !== 'SessionEnd'));
  assert.equal(Object.values(before.sessions)[0].status, 'waiting_permission');
  const { st, list } = sessions('08-interaktiv-nekat-och-exit');
  assert.equal(list[0].status, 'ended');
  assert.equal(list[0].endReason, 'prompt_input_exit');
  assert.equal(st.tools[0].aborted, true);
});

test('09 closed terminal still ends the session', () => {
  const { list } = sessions('09-terminal-stangd');
  assert.equal(list[0].status, 'ended');
  assert.equal(list[0].endReason, 'other');
});

test('10 Esc during a tool: working with the tool until the session ends', () => {
  const evs = load('10-interaktiv-esc-under-verktyg');
  const st = fold(evs.filter(e => e.event !== 'SessionEnd'));
  const s = Object.values(st.sessions)[0];
  assert.equal(s.status, 'working');
  assert.equal(s.tool, 'Bash');
  assert.match(s.detail, /time\.sleep/);
});

test('view closes open intervals at now and filters by time and session', () => {
  const evs = load('10-interaktiv-esc-under-verktyg');
  const st = fold(evs.filter(e => e.event !== 'SessionEnd'));
  const now = lastT(evs);
  const v = view(st, now);
  assert.equal(v.tools.length, 1);
  assert.equal(v.tools[0].open, true);
  assert.equal(v.tools[0].end, now);
  assert.equal(v.turns[0].open, true);
  assert.equal(view(st, now, { session: 'nope' }).sessions.length, 0);
  assert.ok(!('turn' in v.sessions[0]), 'internal bookkeeping is not exposed');
  // reduce state is unchanged by view
  assert.equal(Object.keys(st.openTools).length, 1);
});

test('all test data together: 13 sessions, deterministic', () => {
  const all = ['01-enkel-tur', '02-verktygsfel-och-nekat-headless', '03-subagent', '04-tre-parallella-sessioner',
    '05-resume-och-compact', '06-tillstand-nekat-headless', '07-interaktiv-tillstand-bakgrund-esc-clear-idle-kill',
    '08-interaktiv-nekat-och-exit', '09-terminal-stangd', '10-interaktiv-esc-under-verktyg']
    .flatMap(load).sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
  const a = fold(all), b = fold(all);
  assert.equal(Object.keys(a.sessions).length, 13);
  const now = lastT(all);
  assert.deepEqual(view(a, now), view(b, now));
});
