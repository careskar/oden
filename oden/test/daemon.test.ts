// Store, tail and daemon: dedup, partial lines, truncation, overflow, POST
// /ingest, the read API and SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { light, Store, validate, type Envelope } from '../src/store.ts';
import { Tailer } from '../src/tail.ts';
import { startDaemon } from '../src/server.ts';

let n = 0;
const env = (event: string, sid = 's1', extra: Record<string, unknown> = {}): Envelope => ({
  v: 1, id: `id-${++n}`, received_at: new Date(Date.now() - 60_000 + n * 100).toISOString(),
  harness: 'claude-code', host: 'test', event, session_id: sid,
  raw: { hook_event_name: event, session_id: sid, cwd: '/home/dev/app', ...extra },
});
const line = (e: Envelope) => JSON.stringify(e) + '\n';
const tmp = () => mkdtempSync(join(tmpdir(), 'oden-test-'));

test('validate rejects what is not an envelope', () => {
  assert.equal(validate({ v: 1, id: 'x', received_at: 'nope', raw: {} }), null);
  assert.equal(validate({ v: 1, received_at: '2026-11-12T12:00:00Z', raw: {} }), null);
  assert.ok(validate(env('Stop')));
});

test('store deduplicates on id', () => {
  const s = new Store(':memory:');
  const e = env('Stop');
  assert.equal(s.insert([e, e]).length, 1);
  assert.equal(s.insert([e]).length, 0);
  assert.equal(s.count(), 1);
  assert.deepEqual(s.get(e.id), e);
});

test('light drops tool_response and cuts long strings but keeps the prompt', () => {
  const e = env('PostToolUse', 's1', { tool_response: { stdout: 'x'.repeat(10) }, tool_input: { content: 'y'.repeat(50) }, prompt: 'p'.repeat(50) });
  const l = light(e, 20) as Envelope & { _light?: boolean; raw: Record<string, any> };
  assert.equal(l._light, true);
  assert.ok(!('tool_response' in l.raw));
  assert.equal(l.raw.tool_input.content.length, 21);
  assert.equal(l.raw.prompt.length, 50);
});

test('tail reads new lines, waits for a partial line, survives truncation', () => {
  const home = tmp();
  try {
    const spool = join(home, 'spool.jsonl');
    const store = new Store(':memory:');
    const seen: string[] = [];
    const t = new Tailer(home, store, added => seen.push(...added.map(e => e.event!)));
    assert.equal(t.poll().added, 0, 'no spool file yet');

    writeFileSync(spool, line(env('SessionStart')) + line(env('UserPromptSubmit')));
    assert.equal(t.poll().added, 2);

    // Korpen is halfway through writing a line.
    const stop = line(env('Stop'));
    appendFileSync(spool, stop.slice(0, 20));
    assert.equal(t.poll().added, 0);
    appendFileSync(spool, stop.slice(20));
    assert.equal(t.poll().added, 1);

    appendFileSync(spool, 'not json\n');
    assert.deepEqual(t.poll(), { added: 0, bad: 1 });

    // Truncated and rewritten: read from the start, duplicates are skipped.
    writeFileSync(spool, stop + line(env('SessionEnd')));
    assert.equal(t.poll().added, 1);
    assert.deepEqual(seen, ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);

    // A restart continues from the saved offset.
    const t2 = new Tailer(home, store);
    assert.equal(t2.poll().added, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('tail picks up overflow files', () => {
  const home = tmp();
  try {
    mkdirSync(join(home, 'overflow'));
    writeFileSync(join(home, 'overflow', '123.456.jsonl'), line(env('Notification')));
    const store = new Store(':memory:');
    assert.equal(new Tailer(home, store).poll().added, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('daemon: ingest, view, events, SSE and spool tail', async () => {
  const home = tmp();
  const d = await startDaemon({ home, port: 0, db: ':memory:' });
  try {
    const port = (d.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    // SSE: the first message comes on connect, the next after new events.
    const ac = new AbortController();
    const res = await fetch(base + '/api/stream', { signal: ac.signal });
    const reader = res.body!.getReader();
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    assert.match(await next(), /event: change/);

    const evs = [env('SessionStart', 'a'), env('UserPromptSubmit', 'a', { prompt: 'hej' }), env('PreToolUse', 'a', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } })];
    const r = await fetch(base + '/ingest', { method: 'POST', body: evs.map(line).join('') + 'trasig\n' });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { inserted: 3, duplicates: 0, bad: 1 });
    assert.match(await next(), /"count":3/);

    const again = await (await fetch(base + '/ingest', { method: 'POST', body: line(evs[0]) })).json();
    assert.equal(again.duplicates, 1);

    // Korpen's spool file is followed too.
    writeFileSync(join(home, 'spool.jsonl'), line(env('PermissionRequest', 'a', { tool_name: 'Bash' })));
    d.tail!.poll();
    await next();

    const v = await (await fetch(base + '/api/view')).json();
    assert.equal(v.sessions.length, 1);
    assert.equal(v.sessions[0].status, 'waiting_permission');
    assert.equal(v.sessions[0].repo, 'app');
    assert.equal(v.tools[0].open, true);
    assert.equal(v.tools[0].detail, 'npm test');
    assert.equal(v.events.length, 4);
    assert.equal(v.events[1].detail, '”hej” (3 tecken)');

    const full = await (await fetch(base + '/api/events/' + evs[2].id)).json();
    assert.deepEqual(full, evs[2]);
    assert.equal((await fetch(base + '/api/events/nope')).status, 404);
    assert.match(await (await fetch(base + '/')).text(), /<h1>Oden<\/h1>/);
    ac.abort();
  } finally {
    await d.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('daemon rebuilds its state from the event log on restart', async () => {
  const home = tmp();
  const db = join(home, 'oden.db');
  try {
    const d1 = await startDaemon({ home, port: 0, db, tail: false });
    const port = (d1.server.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: line(env('SessionStart', 'b')) + line(env('Stop', 'b')) });
    await d1.close();
    const d2 = await startDaemon({ home, port: 0, db, tail: false });
    assert.equal(d2.state.sessions.b.status, 'waiting_input');
    await d2.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
