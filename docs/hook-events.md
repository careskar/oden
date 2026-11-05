# Claude Codes hook-events i praktiken

Underlag för issue #6. Hook-tabellen i avsnitt 4 i [`plan.html`](plan.html) bygger på dokumentationen. Här jämförs den med vad Korpen faktiskt fick in från riktiga sessioner.

## Hur datan samlades in

- Claude Code 2.1.318 på Linux, i en molncontainer (Claude Code on the web). Modell: Haiku.
- Korpen installerades med `raven/install.sh --settings <fil>` och användes med `claude --settings <fil>`, både headless (`claude -p`) och interaktivt i tmux.
- Tio scenarier och 103 events. Anonymiserade loggar finns i [`testdata/claude-code/`](../testdata/claude-code/).
- **Inte testat ännu:** flera dagars vanligt arbete, macOS, IDE- och desktop-klienterna, automatisk komprimering (`trigger: "auto"`), MCP-verktyg och fler `notification_type` än de två nedan. Det behöver köras på din egen maskin (se sist).

## Gemensamma fält

Planen säger att alla events har `session_id`, `transcript_path`, `cwd`, `permission_mode` och `hook_event_name`. Det stämmer inte helt.

| Fält | Finns i | Kommentar |
|---|---|---|
| `session_id`, `transcript_path`, `cwd`, `hook_event_name` | alla | Som planen |
| `permission_mode` | `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop` | **Saknas** i `SessionStart`, `SessionEnd`, `Notification`, `SubagentStart` och `PreCompact`. Värdet måste alltså bäras vidare från senaste event som hade det. |
| `prompt_id` | alla utom den första `SessionStart` | **Nytt.** UUID per prompt. Alla events i en tur, även subagentens, har samma `prompt_id`. Det är en bättre turnyckel än att para `UserPromptSubmit` med `Stop`. |
| `effort` | verktygs-events, `Stop`, `SubagentStop` | **Nytt.** T.ex. `{"level": "medium"}` |
| `agent_id`, `agent_type` | events som kommer inifrån en subagent | **Nytt.** Se Subagenter nedan |
| `scratchpad_dir` | alla | Troligen specifikt för molnmiljön. Räkna inte med att det finns lokalt. |

## Per event

| Event | Fält utöver de gemensamma | Avvikelse mot planen |
|---|---|---|
| `SessionStart` | `source`: `startup` / `resume` / `clear` / `compact`. Ibland `model`. Vid `resume` även `context_tokens`, `estimated_cache_write_usd`, `prompt_cache_likely_expired` och `seconds_since_last_response` | `model` finns bara vid interaktiv start och efter `compact`, inte vid `claude -p` eller `resume`. `context_tokens` vid resume ger kontextfyllnaden utan att läsa transkriptet. |
| `UserPromptSubmit` | `prompt` | Kommer även för **bakgrundsjobb som blir klara**: `prompt` börjar då med `<task-notification>`. Det är inte en prompt från dig. Slash-kommandon (`/clear`, `/compact`, `/exit`) ger **inget** `UserPromptSubmit`. |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | Som planen |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions` | **Saknar `tool_use_id`.** Måste paras med senaste `PreToolUse` med samma `tool_name` och `tool_input` i sessionen. Kommer 30–80 ms efter `PreToolUse`. |
| `PostToolUse` | `tool_response`, `tool_use_id`, `duration_ms` | **`duration_ms` räknar inte väntan på tillstånd** (119 ms i stället för 26 s från Pre till Post). Fallgropen i avsnitt 10 i planen försvinner om vi använder `duration_ms`. Från `Agent`-verktyget innehåller `tool_response` dessutom `usage`, `totalTokens`, `totalDurationMs` och `resolvedModel`. |
| `PostToolUseFailure` | `error` (text), `is_interrupt`, `tool_use_id`, `duration_ms` | Fältet heter `error`. Esc under ett verktyg ger **inte** det här eventet (se nedan). |
| `Notification` | `message`, `notification_type` | Sett: `permission_prompt` (cirka 6 s efter `PermissionRequest`, bara om du inte redan svarat) och `idle_prompt` (exakt 60 s efter `Stop`). Båda är bara reservsignaler. |
| `SubagentStart` | `agent_id`, `agent_type` | Som planen. Saknar `permission_mode`. |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `background_tasks` | Kommer även för **interna agenter** som aldrig hade något `SubagentStart`, med `agent_type: ""`. De syns efter varje `Stop` i interaktiva sessioner och två gånger vid `/compact`. Ignorera dem, eller räkna dem för sig. |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | **Nytt:** `last_assistant_message` ger förhandsvisning i dashboarden utan att läsa transkriptet. `background_tasks` listar skal som fortfarande kör (`id`, `type`, `status`, `command`). |
| `PreCompact` | `trigger` (`manual`), `custom_instructions` | Som planen. Följs av `SessionStart` med `source: "compact"` och samma `session_id`. |
| `SessionEnd` | `reason` | Sett: `other` (slutet på `claude -p` och stängd terminal), `clear` och `prompt_input_exit` (`/exit`). |

## Specialfall

| Fall | Vad som händer | Följd för statusmaskinen |
|---|---|---|
| **Esc under svar** | Inget `Stop`. Nästa event är nytt `UserPromptSubmit`. | Ett nytt `UserPromptSubmit` medan sessionen är *working* betyder att förra turen avbröts. |
| **Esc under verktyg** | Varken `PostToolUse`, `PostToolUseFailure`, `Stop` eller `idle_prompt` (väntade i 70 s). Transkriptet får `[Request interrupted by user for tool use]`. | **Ser ut som *working* för alltid.** Om en session varit *working* i N sekunder utan events: läs slutet av transkriptet och leta efter `[Request interrupted by user`. Det är den viktigaste rättelsen av planen. |
| **Tillstånd nekat, interaktivt** | `PreToolUse` och `PermissionRequest`, sedan inget alls: varken Post eller `Stop`. | Samma som Esc under verktyg. |
| **Tillstånd nekat, headless** | `PreToolUse` och `PermissionRequest`, inget Post, men `Stop` kommer. | Ett verktyg utan Post är nekat eller avbrutet. Visa det inte som ett pågående anrop. |
| **Tillstånd godkänt** | `PreToolUse`, `PermissionRequest`, `Notification(permission_prompt)` och sedan `PostToolUse` när du svarat. | Tiden från `PermissionRequest` till `PostToolUse` minus `duration_ms` är din svarstid. |
| **`/clear`** | `SessionEnd(clear)` och sedan `SessionStart(clear)` med **nytt** `session_id`. | Ny session i samma terminal. Länka ihop dem med `cwd` och tidpunkt om vi vill visa dem som en. |
| **`/compact`** | `PreCompact(manual)`, två interna `SubagentStop` och `SessionStart(compact)`. Samma `session_id`. | Räkna komprimeringar på `PreCompact`. |
| **`--resume` / `--continue`** | `SessionStart(resume)` med samma `session_id`. | En session kan ha många `SessionStart`/`SessionEnd`-par. *ended* måste kunna öppnas igen. |
| **`claude -p`** | Varje körning slutar med `SessionEnd(other)`. | Headless-sessioner är kortlivade. |
| **Stängd terminal (SIGHUP)** | `SessionEnd(other)` kommer ändå. | |
| **Krasch (`kill -9`)** | Inget `SessionEnd`. | Bara timeout ger *stale*. Som planen. |
| **Bakgrundsjobb** | `Stop.background_tasks` listar jobbet. När det blir klart kommer `UserPromptSubmit` med `<task-notification>` och sedan en ny tur. | Räkna inte de turerna som dina prompter, och inte väntan före dem som din reaktionstid. |
| **Subagenter** | Samma `session_id` som huvudsessionen. Subagentens verktygs-events har `agent_id`. `SubagentStop` kommer före huvudagentens `PostToolUse` för `Agent`. | Agentträdet byggs med `agent_id`. Utan `agent_id` är eventet huvudagentens. |
| **Parallella sessioner** | Tre samtidiga sessioner gav 18 hela rader. Ingen rad blandades ihop och inget hamnade i `overflow/`. | Korpens lås fungerar. |

## Rättelser av planen

1. `permission_mode` är inte gemensamt, men `prompt_id` nästan är det. Använd `prompt_id` som turnyckel.
2. Avbrott syns inte i hooks. Statusmaskinen behöver ett *working*-timeout som läser transkriptet. Det påverkar #7 och #8.
3. `PermissionRequest` saknar `tool_use_id`.
4. Verktygstider ska tas från `duration_ms`, inte från Pre till Post.
5. Filtrera bort `SubagentStop` med `agent_type: ""` och `UserPromptSubmit` som börjar med `<task-notification>`.
6. `Stop.last_assistant_message` och `SessionStart.context_tokens` (vid resume) ger data som planen bara räknade med att hämta ur transkriptet.

## Kvar att göra på din egen maskin

```bash
./raven/install.sh
```

Arbeta som vanligt i några dagar. Anonymisera sedan loggen och jämför med tabellerna ovan, särskilt vid automatisk komprimering, MCP-verktyg och IDE/desktop:

```bash
./raven/anonymize.sh --map "$HOME/code=/home/dev/code" < ~/.oden/spool.jsonl > min-logg.jsonl
```
