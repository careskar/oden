# Korpen (raven)

Odens insamlare för Claude Code. Ett litet Bash-skript som registreras för alla hook-events, lägger på metadata och skriver en rad per event till `~/.oden/spool.jsonl`. Se avsnitt 4 i [`docs/plan.html`](../docs/plan.html) och issue #5.

## Krav

`bash` (3.2 räcker, alltså standard på macOS), `jq` och, för valfri POST, `curl`.

## Installera

```bash
./raven/install.sh
```

Skriptet kopierar `raven` till `~/.oden/bin/raven` och lägger till en hook för vart och ett av de tolv eventen i `~/.claude/settings.json`: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `PreCompact` och `SessionEnd`.

- Befintliga hooks lämnas orörda. Odens post läggs sist i varje events lista.
- Inställningsfilen säkerhetskopieras till `settings.json.bak` före varje ändring.
- Skriptet går att köra flera gånger utan att posterna dubbleras.
- `--settings PATH` installerar i en annan fil, t.ex. ett projekts `.claude/settings.json`.
- `--uninstall` tar bort Odens poster men behåller spool-filen.

Starta om pågående Claude Code-sessioner för att de ska läsa in de nya hooksen.

## Format

En JSON-rad per event:

```json
{"v":1,"id":"01M6GZT1R6XRDMGJHBVM0EJ12M","received_at":"2026-11-03T15:17:56.614Z",
 "harness":"claude-code","host":"macbook","event":"Stop","session_id":"abc",
 "raw":{"hook_event_name":"Stop","session_id":"abc","cwd":"/Users/karl/code/oden", "…": "…"}}
```

- `id` är ett ULID och kan användas för deduplicering vid ingest.
- `event` och `session_id` är kopior av fält i `raw`, för att det ska gå att gruppera och greppa utan att packa upp.
- `raw` är hookens JSON oförändrad. Indata som inte är giltig JSON sparas som `{"unparsed": "…"}` i stället för att tappas.

## Miljövariabler

| Variabel | Standard | Betydelse |
|---|---|---|
| `ODEN_HOME` | `~/.oden` | Katalog för spool, lås och fellogg |
| `ODEN_HARNESS` | `claude-code` | Värdet i `harness` |
| `ODEN_INGEST_URL` | (av) | Om satt, POST:as varje event i bakgrunden, t.ex. `http://localhost:4747/ingest` |
| `ODEN_DISABLE` | (av) | `1` stänger av insamlingen helt |
| `ODEN_LOCK_WAIT` | `3` | Sekunder (räknat från start) som Korpen väntar på spool-låset innan eventet läggs i `overflow/` |

## Garantier

- Avslutar alltid med kod 0 och skriver aldrig till stdout. Fel loggas i `~/.oden/raven.err`.
- Parallella sessioner skriver via ett lås, så raderna blandas inte ihop även när payloaden är stor. Låset är en symlänk (`spool.lck`) som pekar på ägarens PID, eftersom `flock` saknas på macOS. En levande ägare behåller alltid låset. Bara ett lås vars ägare har dött, t.ex. dödats av hookens timeout, rensas bort.
- Korpen skriver aldrig till spool-filen utan lås. Om låset fortfarande är upptaget efter `ODEN_LOCK_WAIT` sekunder sparas eventet i en egen fil i `~/.oden/overflow/` och en rad skrivs till `raven.err`. Ingest ska läsa även de filerna.
- POST:en körs helt frikopplad med 1 s timeout. Om daemonen är nere finns eventet ändå i spool-filen.

## Test och latens

```bash
./raven/test.sh
```

```bash
./raven/bench.sh 200 2000
```

Uppmätt i en Linux-container: medel 20 ms och p95 24 ms med 2 kB payload, medel 29 ms och p95 34 ms med 200 kB. Målet är under ~50 ms. Siffrorna på din egen maskin kan skilja sig, särskilt på macOS där processer startar långsammare.

## Kända begränsningar

- `PostToolUse` innehåller hela verktygssvaret, så spool-filen kan växa snabbt. Ingen trunkering eller rotation ännu.
- Hook-namn och fält bygger på dokumentationen och verifieras mot riktiga sessioner i #6.
