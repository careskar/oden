# Oden

Kontrolltorn för AI-agenter och prompter.

- [Systemplan (issue #1)](docs/plan.html)
- [Event explorer](docs/prototypes/event-explorer.html): öppna i webbläsaren och läs in din `~/.oden/spool.jsonl`
- [Analys: herdr, T3 Code, Orca och Paseo](docs/analys-referensrepon.html)
- [Claude Codes hook-events i praktiken (issue #6)](docs/hook-events.md)

## Komponenter

- [`raven/`](raven/): Korpen, insamlaren för Claude Code-hooks (#5)
- [`testdata/claude-code/`](testdata/claude-code/): anonymiserade hook-loggar från riktiga sessioner (#6)
