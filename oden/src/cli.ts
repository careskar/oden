// Oden's command line: `oden ls` and `oden serve`.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ls } from './ls.ts';
import { startDaemon } from './server.ts';

const usage = `Användning:
  oden ls [--all] [--watch]     Sessioner med status, läst direkt från spool-filen
  oden serve [--port 4747]      Starta daemonen och dashboarden på http://127.0.0.1:4747

Flaggor:
  --home DIR    Odens katalog (standard: $ODEN_HOME eller ~/.oden)
  -a, --all     Visa även avslutade sessioner
  -w, --watch   Uppdatera listan varje sekund
  -p, --port N  Port för daemonen (standard: 4747)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
    all: { type: 'boolean', short: 'a' },
    watch: { type: 'boolean', short: 'w' },
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  },
});

const home = values.home ?? process.env.ODEN_HOME ?? join(homedir(), '.oden');
const cmd = positionals[0];

if (values.help || !cmd) {
  console.log(usage);
} else if (cmd === 'ls') {
  ls(home, { all: values.all, watch: values.watch });
} else if (cmd === 'serve') {
  mkdirSync(home, { recursive: true });
  const port = Number(values.port ?? 4747);
  startDaemon({ home, port }).then(d => {
    console.log(`Oden lyssnar på http://127.0.0.1:${port} · ${d.store.count()} events i ${join(home, 'oden.db')}`);
    console.log(`Följer ${join(home, 'spool.jsonl')} och overflow/. Ctrl-C avslutar.`);
    const stop = () => d.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} används redan. Kör daemonen redan?` : String(err));
    process.exit(1);
  });
} else {
  console.error(`Okänt kommando: ${cmd}\n\n${usage}`);
  process.exitCode = 2;
}
