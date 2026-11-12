# Oden

Daemonen, dashboarden och CLI:t. Korpen (`raven/`) skriver events till `~/.oden/spool.jsonl`. Oden läser dem, härleder vad varje session gör och visar det. Se avsnitt 5–7 i [`docs/plan.html`](../docs/plan.html).

## Krav

Node.js 22.18 eller senare (`brew install node`). Inga npm-paket: SQLite och TypeScript är inbyggda i Node.

## Kom igång

Installera Korpen om du inte redan gjort det, och starta om Claude Code:

```bash
./raven/install.sh
```

Lägg gärna till ett alias i `~/.zshrc`, så att `oden` fungerar överallt. Kör det från repots rot:

```bash
echo "alias oden='$PWD/oden/oden'" >> ~/.zshrc
```

### `oden ls`

Sessionerna med status, läst direkt från spool-filen. Ingen daemon behövs.

```bash
oden ls
```

```
STATUS                        SEDAN  REPO     SESSION   TURER  DETALJ
⏸ väntar på tillstånd · Bash  26 s   projekt  6310c100  1      touch nej.txt
● väntar på dig               1 min  projekt  52174d3a  1      ”Säg hej.”
▶ jobbar · Bash               41 s   projekt  bf00b58a  1      python3 -c 'import time; time.sleep(20)'

3 sessioner · 2 väntar på dig · 1 jobbar
```

Sessioner som väntar på dig hamnar överst, den som väntat längst först. `--watch` uppdaterar varje sekund och `--all` visar även avslutade sessioner.

### `oden serve`

Startar daemonen och dashboarden på http://127.0.0.1:4747.

```bash
oden serve
```

- Följer `~/.oden/spool.jsonl` och `~/.oden/overflow/`. Nya rader syns i dashboarden inom en halv sekund.
- Tar även emot `POST /ingest`, så att Korpen kan skicka direkt med `ODEN_INGEST_URL=http://127.0.0.1:4747/ingest`. Det behövs inte, eftersom spool-filen räcker, men det går lite snabbare. Events som kommer båda vägarna räknas bara en gång.
- Sparar alla events oförändrade i `~/.oden/oden.db` (SQLite). Vid start byggs status och statistik om från den, så en ny version av statusmaskinen gäller även gammal data.
- Lyssnar bara på 127.0.0.1. Ingenting lämnar datorn.

## Delar

| Fil | Vad |
|---|---|
| `src/derive.ts` | Statusmaskinen och ihopparningen av events till turer, verktygsanrop och väntetider. En ren `reduce(state, event)` som delas av allt annat. |
| `src/store.ts` | Händelseloggen i SQLite, med dubblettkontroll på event-id |
| `src/tail.ts` | Följer spool- och overflow-filerna, med sparad position per fil |
| `src/server.ts` | `POST /ingest`, läs-API:t och SSE |
| `src/ls.ts`, `src/cli.ts` | `oden ls` och `oden serve` |
| `web/index.html` | Dashboarden (#11) |

### Läs-API

| | |
|---|---|
| `GET /api/view?from=<ms>` | Sessioner med status, turer, verktygsanrop, väntetider, subagenter och komprimeringar, plus en kort eventlista |
| `GET /api/events/<id>` | Ett event, oförändrat |
| `GET /api/stream` | Server-Sent Events: `change` när nya events kommit in |
| `POST /ingest` | Ett eller flera events i Korpens format (JSON eller JSONL) |

## Status

| Status | När |
|---|---|
| `working` | Efter `UserPromptSubmit`, `PreToolUse` och `PostToolUse` |
| `waiting_permission` | Efter `PermissionRequest`, tills verktyget körs eller turen tar slut |
| `waiting_input` | Efter `Stop` |
| `ended` | Efter `SessionEnd`. `--resume` öppnar sessionen igen. |
| `stale` | Inga events på 15 minuter: krasch, `kill -9` eller en tur som avbröts med Esc mitt i ett verktyg |

Avbrott syns inte i hooks, se [`docs/hook-events.md`](../docs/hook-events.md). En session som avbröts med Esc under ett verktyg står därför som *jobbar* tills den blir *inaktiv*. Att läsa transkriptet för att upptäcka det direkt är nästa steg (#8).

## Test

```bash
cd oden && npm test
```

Statusmaskinen testas mot de riktiga sessionerna i [`testdata/claude-code/`](../testdata/claude-code/).
