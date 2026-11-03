#!/usr/bin/env bash
# Tests for raven and install.sh. Run: ./test.sh
set -uo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export ODEN_HOME="$work/oden"
unset ODEN_INGEST_URL ODEN_DISABLE

fails=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
spool="$ODEN_HOME/spool.jsonl"

# --- raven ---------------------------------------------------------------

out=$(echo '{"hook_event_name":"Stop","session_id":"s1","cwd":"/tmp"}' | "$dir/raven"; echo "exit=$?")
check "exits 0 and prints nothing" '[ "$out" = "exit=0" ]'
check "writes one line" '[ "$(wc -l <"$spool" | tr -d " ")" = 1 ]'

e=$(tail -n1 "$spool")
check "envelope fields" \
  '[ "$(jq -r "[.v,.harness,.event,.session_id,.raw.cwd]|join(\",\")" <<<"$e")" = "1,claude-code,Stop,s1,/tmp" ]'
check "id is a 26-char ULID" '[[ "$(jq -r .id <<<"$e")" =~ ^[0-7][0-9A-HJKMNP-TV-Z]{25}$ ]]'
check "received_at is ISO-8601 with ms" '[[ "$(jq -r .received_at <<<"$e")" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\.[0-9]{3}Z$ ]]'

echo 'not json {' | "$dir/raven"
check "keeps invalid input as raw.unparsed" '[ "$(tail -n1 "$spool" | jq -r .raw.unparsed)" = "not json {" ]'

: | "$dir/raven"; check "handles empty stdin" '[ $? -eq 0 ]'

ODEN_HARNESS=cowork "$dir/raven" <<<'{}'
check "ODEN_HARNESS overrides harness" '[ "$(tail -n1 "$spool" | jq -r .harness)" = cowork ]'

before=$(wc -l <"$spool")
ODEN_DISABLE=1 "$dir/raven" <<<'{}'
check "ODEN_DISABLE=1 writes nothing" '[ "$(wc -l <"$spool")" = "$before" ]'

out=$(ODEN_INGEST_URL=http://127.0.0.1:1/ingest "$dir/raven" <<<'{}'; echo "exit=$?")
check "unreachable ingest URL is harmless" '[ "$out" = "exit=0" ]'

# Parallel sessions with large payloads must not interleave lines.
big=$(head -c 200000 /dev/zero | tr '\0' x)
: >"$spool"
for i in $(seq 1 40); do
  printf '{"hook_event_name":"PostToolUse","session_id":"p%s","tool_response":"%s"}' "$i" "$big" | "$dir/raven" &
done
wait
check "40 parallel 200 kB events: 40 valid lines" \
  '[ "$(jq -c .session_id "$spool" 2>/dev/null | wc -l | tr -d " ")" = 40 ]'
ids=$(jq -r .id "$spool" | sort -u | wc -l | tr -d ' ')
check "ids are unique" '[ "$ids" = 40 ]'

# --- install.sh ----------------------------------------------------------

settings="$work/settings.json"
cat >"$settings" <<'EOF'
{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}],
 "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"my-guard"}]}]}}
EOF

"$dir/install.sh" --settings "$settings" >/dev/null
check "install copies raven" '[ -x "$ODEN_HOME/bin/raven" ]'
check "keeps unrelated settings" '[ "$(jq -r .model "$settings")" = opus ]'
check "keeps existing hooks" \
  '[ "$(jq -r "[.hooks.Stop[].hooks[].command, .hooks.PreToolUse[].hooks[].command] | join(\",\")" "$settings")" = "say done,$ODEN_HOME/bin/raven,my-guard,$ODEN_HOME/bin/raven" ]'
check "registers all 12 events" '[ "$(jq "[.hooks[][].hooks[] | select(.command == \"$ODEN_HOME/bin/raven\")] | length" "$settings")" = 12 ]'
check "tool events use matcher *" '[ "$(jq -r ".hooks.PostToolUse[-1].matcher" "$settings")" = "*" ]'
check "writes a backup" '[ -f "$settings.bak" ]'

"$dir/install.sh" --settings "$settings" >/dev/null
check "re-install is idempotent" '[ "$(jq "[.hooks[][].hooks[] | select(.command == \"$ODEN_HOME/bin/raven\")] | length" "$settings")" = 12 ]'

"$dir/install.sh" --settings "$settings" --uninstall >/dev/null
check "uninstall restores the original hooks" \
  '[ "$(jq -cS . "$settings")" = "$(jq -cS . <<<"{\"model\":\"opus\",\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"say done\"}]}],\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"my-guard\"}]}]}}")" ]'

"$dir/install.sh" --settings "$work/new/settings.json" >/dev/null
check "creates a missing settings file" '[ "$(jq ".hooks | length" "$work/new/settings.json")" = 12 ]'

echo
[ "$fails" -eq 0 ] && echo "all tests passed" || { echo "$fails test(s) failed"; exit 1; }
