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
# On a slow or busy machine some events may go to overflow/ (see below), but
# the spool must only hold whole lines and no event may be lost.
check "40 parallel 200 kB events: every spool line is valid JSON" \
  '[ "$(jq -c .session_id "$spool" 2>/dev/null | wc -l | tr -d " ")" = "$(wc -l <"$spool" | tr -d " ")" ]'
all=$(cat "$spool" "$ODEN_HOME"/overflow/*.jsonl 2>/dev/null)
check "40 parallel 200 kB events: none lost" \
  '[ "$(jq -r .session_id <<<"$all" | sort -u | wc -l | tr -d " ")" = 40 ]'
ids=$(jq -r .id <<<"$all" | sort -u | wc -l | tr -d ' ')
check "ids are unique" '[ "$ids" = 40 ]'
rm -rf "$ODEN_HOME/overflow"

# --- spool lock ----------------------------------------------------------

lock="$ODEN_HOME/spool.lck"
lines() { wc -l <"$spool" | tr -d ' '; }

# A live holder must never lose the lock, however long it holds it. This is
# the bug behind interleaved lines on slow CI runners: waiters used to break
# the lock after ~1 s while the holder was still writing.
sleep 30 & holder=$!
ln -s "raven-$holder" "$lock"
before=$(lines)
ODEN_LOCK_WAIT=5 "$dir/raven" <<<'{"hook_event_name":"Stop","session_id":"wait"}' & waiter=$!
sleep 1.5
check "waits while a live holder has the lock" '[ "$(lines)" = "$before" ]'
rm -f "$lock"
wait "$waiter"
check "writes once the holder releases" '[ "$(tail -n1 "$spool" | jq -r .session_id)" = wait ]'

# If the lock stays busy past ODEN_LOCK_WAIT, the event goes to overflow/
# instead of being appended without the lock.
ln -s "raven-$holder" "$lock"
before=$(lines)
ODEN_LOCK_WAIT=1 "$dir/raven" <<<'{"hook_event_name":"Stop","session_id":"busy"}'
check "busy lock: spool untouched" '[ "$(lines)" = "$before" ]'
check "busy lock: event kept in overflow/" \
  '[ "$(cat "$ODEN_HOME"/overflow/*.jsonl 2>/dev/null | jq -r .session_id)" = busy ]'
check "busy lock: holder keeps its lock" '[ "$(readlink "$lock")" = "raven-$holder" ]'
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
rm -f "$lock"

# A lock left by a dead holder (crashed, or killed by the hook timeout) is cleared.
sleep 0 & dead=$!; wait "$dead"
ln -s "raven-$dead" "$lock"
ODEN_LOCK_WAIT=1 "$dir/raven" <<<'{"hook_event_name":"Stop","session_id":"stale"}'
check "clears a dead holder's lock" '[ "$(tail -n1 "$spool" | jq -r .session_id)" = stale ] && [ ! -L "$lock" ]'

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

# --- anonymize.sh --------------------------------------------------------

a=$(HOME=/Users/karl "$dir/anonymize.sh" --map /Users/karl/code/app=/home/dev/projekt --max 80 <<<'{"host":"mac","raw":{"cwd":"/Users/karl/code/app","transcript_path":"/Users/karl/.claude/projects/-Users-karl-code-app/s.jsonl","other":"/Users/karl/x","tool_response":"'"$(printf "x%.0s" $(seq 90))"'"}}')
check "anonymize maps paths and their encoded form" \
  '[ "$(jq -r "[.raw.cwd, .raw.transcript_path] | join(\",\")" <<<"$a")" = "/home/dev/projekt,/home/dev/.claude/projects/-home-dev-projekt/s.jsonl" ]'
check "anonymize maps HOME and host" '[ "$(jq -r "[.raw.other, .host] | join(\",\")" <<<"$a")" = "/home/dev/x,devbox" ]'
check "anonymize cuts long strings" '[ "$(jq -r .raw.tool_response <<<"$a")" = "$(printf "x%.0s" $(seq 80))…[cut]" ]'

# --- test data ------------------------------------------------------------

td="$dir/../testdata/claude-code"
check "test data is valid JSONL in Korpen's format" \
  '[ "$(cat "$td"/*.jsonl | jq -s "map(select(.v == 1 and .event == .raw.hook_event_name)) | length")" = "$(cat "$td"/*.jsonl | wc -l | tr -d " ")" ]'

echo
[ "$fails" -eq 0 ] && echo "all tests passed" || { echo "$fails test(s) failed"; exit 1; }
