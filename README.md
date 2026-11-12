# Oden

Kontrolltorn för AI-agenter och prompter.

- [Systemplan (issue #1)](docs/plan.html)
- [Analys: herdr, T3 Code, Orca och Paseo](docs/analys-referensrepon.html)
- [Claude Codes hook-events i praktiken (issue #6)](docs/hook-events.md)

## Komponenter

- [`oden/`](oden/): daemonen, dashboarden och `oden ls` (#7, #11)
- [`raven/`](raven/): Korpen, insamlaren för Claude Code-hooks (#5)
- [`testdata/claude-code/`](testdata/claude-code/): anonymiserade hook-loggar från riktiga sessioner (#6)
