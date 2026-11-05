# Testdata: Claude Code-hooks

Riktiga events som Korpen samlat in från Claude Code 2.1.318 (issue #6), anonymiserade med `raven/anonymize.sh`. En fil per scenario, en rad per event i Korpens format, sorterade på `received_at`. Vad som händer i varje fall beskrivs i [`docs/hook-events.md`](../../docs/hook-events.md).

Sökvägar är utbytta mot `/home/dev/projekt`, `host` är `devbox` och strängar längre än 400 tecken är avkortade. `session_id`, `tool_use_id`, `prompt_id` och tidsstämplar är oförändrade.

| Fil | Scenario | Förväntad slutstatus |
|---|---|---|
| `01-enkel-tur` | `claude -p`, ett `Read` | *ended* |
| `02-verktygsfel-och-nekat-headless` | Nekat `Bash` (inget Post) och `Read` som misslyckas | *ended* |
| `03-subagent` | `Agent` med Explore-subagent som kör `Bash` | *ended* |
| `04-tre-parallella-sessioner` | Tre `claude -p` samtidigt, events blandade | tre sessioner, alla *ended* |
| `05-resume-och-compact` | Start, `--resume`, `/compact`, `--continue`, samma `session_id` | *ended*, fyra körningar och en komprimering |
| `06-tillstand-nekat-headless` | `Write` nekas, men `Stop` kommer | *ended* |
| `07-interaktiv-tillstand-bakgrund-esc-clear-idle-kill` | Godkänt tillstånd, bakgrundsjobb (`<task-notification>`), Esc under svar (två `UserPromptSubmit` utan `Stop`), `/clear` (nytt `session_id`), `idle_prompt` och sedan `kill -9` | första sessionen *ended* (clear), den andra *stale* |
| `08-interaktiv-nekat-och-exit` | Tillstånd nekas (inget Post, inget `Stop`), sedan `/exit` | *ended* (`prompt_input_exit`) |
| `09-terminal-stangd` | tmux-sessionen stängs (SIGHUP) | *ended* (`other`) |
| `10-interaktiv-esc-under-verktyg` | Esc medan `Bash` kör: inga fler events förrän terminalen stängs | *ended*. Före `SessionEnd` ska den gå till *waiting_input* efter transkriptkontroll, inte stå kvar i *working* |
