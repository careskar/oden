#!/usr/bin/env bash
# Anonymise a Korpen spool file so it can be shared or used as test data.
#
#   ./anonymize.sh [--map FROM=TO]... [--host NAME] [--max N] < spool.jsonl > out.jsonl
#
#   --map FROM=TO  replace the literal string FROM with TO in every string value.
#                  Claude Code's encoded form of a path (/ and . replaced by -,
#                  as in ~/.claude/projects/<dir>) is replaced as well.
#                  $HOME=/home/dev is always applied last.
#   --host NAME    value for the envelope's host field (default: devbox)
#   --max N        cut string values longer than N characters (default: 400),
#                  e.g. file contents in PostToolUse.tool_response
#
# Session ids, tool_use ids and timestamps are kept, since they carry no
# personal data and the state machine needs them. Prompts and tool output are
# kept (cut to --max), so read the result before sharing it.
set -euo pipefail

host=devbox
max=400
maps='[]'

while [ $# -gt 0 ]; do
  case "$1" in
    --map) maps=$(jq -c --arg m "$2" '. + [[($m | split("=")[0]), ($m | split("=")[1:] | join("="))]]' <<<"$maps"); shift ;;
    --host) host="$2"; shift ;;
    --max) max="$2"; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

maps=$(jq -c --arg home "$HOME" '. + [[$home, "/home/dev"]]' <<<"$maps")

jq -c --argjson maps "$maps" --arg host "$host" --argjson max "$max" '
  def enc: gsub("[/.]"; "-");
  # Longest FROM first, so that a more specific mapping wins over $HOME.
  ($maps | map(select(.[0] != "")) | map(., [(.[0] | enc), (.[1] | enc)]) | sort_by(-(.[0] | length))) as $pairs
  | def anon: reduce $pairs[] as $p (.; split($p[0]) | join($p[1]));
  def cut: if length > $max then .[:$max] + "…[cut]" else . end;
  .host = $host
  | walk(if type == "string" then (anon | cut) else . end)
'
