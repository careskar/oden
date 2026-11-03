#!/usr/bin/env bash
# Install Korpen (raven) and register it for every Claude Code hook event.
#
#   ./install.sh                       install into ~/.oden and ~/.claude/settings.json
#   ./install.sh --uninstall           remove Oden's hook entries (keeps the spool)
#   ./install.sh --settings PATH       use another settings file (e.g. a project's
#                                      .claude/settings.json)
#
# Existing hooks are never touched: Oden's entry is appended to each event's
# list, and only entries that run raven ($ODEN_HOME/bin/raven or the default
# ~/.oden/bin/raven) are removed.
# The settings file is backed up to <file>.bak before every change.
set -euo pipefail

ODEN_HOME="${ODEN_HOME:-$HOME/.oden}"
settings="$HOME/.claude/settings.json"
mode=install

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) mode=uninstall ;;
    --settings) settings="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null || { echo "jq is required (brew install jq / apt install jq)" >&2; exit 1; }

# Events with a tool matcher get "*"; the others match everything without one.
tool_events="PreToolUse PermissionRequest PostToolUse PostToolUseFailure"
other_events="SessionStart UserPromptSubmit Notification SubagentStart SubagentStop Stop PreCompact SessionEnd"

src_dir="$(cd "$(dirname "$0")" && pwd)"
raven="$ODEN_HOME/bin/raven"

mkdir -p "$(dirname "$settings")"
[ -s "$settings" ] || echo '{}' >"$settings"
jq empty "$settings" 2>/dev/null || { echo "$settings is not valid JSON, aborting" >&2; exit 1; }
cp "$settings" "$settings.bak"

# Drop Oden's entries from every event, and events left with no entries.
strip='
  def ours: (.command // "") as $c | $c == $cmd or ($c | test("/\\.oden/bin/raven$"));
  if .hooks then
    .hooks |= (
      with_entries(
        .value |= (map(.hooks |= map(select(ours | not))) | map(select((.hooks | length) > 0)))
      )
      | with_entries(select((.value | length) > 0))
    )
  else . end'

tmp="$(mktemp "${settings}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if [ "$mode" = uninstall ]; then
  jq --arg cmd "$raven" "$strip" "$settings" >"$tmp"
  mv "$tmp" "$settings"
  echo "Removed Oden hooks from $settings (backup: $settings.bak)"
  exit 0
fi

mkdir -p "$ODEN_HOME/bin"
cp "$src_dir/raven" "$raven"
chmod +x "$raven"

# Re-running is idempotent: strip our old entries, then append fresh ones.
jq --arg cmd "$raven" --arg tools "$tool_events" --arg others "$other_events" "$strip"'
  | def entry($m): ($m // {}) + {hooks: [{type: "command", command: $cmd, timeout: 5}]};
  .hooks //= {}
  | reduce ($tools | splits(" ")) as $e (.; .hooks[$e] = ((.hooks[$e] // []) + [entry({matcher: "*"})]))
  | reduce ($others | splits(" ")) as $e (.; .hooks[$e] = ((.hooks[$e] // []) + [entry(null)]))
' "$settings" >"$tmp"
mv "$tmp" "$settings"

echo "Installed $raven"
echo "Registered for: $tool_events $other_events"
echo "Settings: $settings (backup: $settings.bak)"
echo "Events go to $ODEN_HOME/spool.jsonl"
