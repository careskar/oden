#!/usr/bin/env bash
# Measure how long raven adds per hook event. Run: ./bench.sh [runs] [payload-bytes]
# Target from issue #5: under ~50 ms per event.
set -euo pipefail

runs="${1:-200}"
size="${2:-2000}"
dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export ODEN_HOME="$work"

pad=$(head -c "$size" /dev/zero | tr '\0' x)
payload="{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"bench\",\"tool_name\":\"Read\",\"tool_response\":\"$pad\"}"
printf '%s' "$payload" >"$work/payload.json"

# Each run is timed from perl (on every macOS and Linux box). The figure includes
# spawning /bin/sh for the run, so it slightly overstates raven's own cost.
perl -MTime::HiRes=time -e '
  my ($runs, $raven, $in) = @ARGV; my @t;
  for (1..$runs) {
    my $s = time; system("$raven < $in") == 0 or die "raven failed\n";
    push @t, (time - $s) * 1000;
  }
  @t = sort { $a <=> $b } @t; my $sum = 0; $sum += $_ for @t;
  printf "runs=%d  mean=%.1f ms  p50=%.1f ms  p95=%.1f ms  max=%.1f ms\n",
    $runs, $sum / @t, $t[int(@t * .5)], $t[int(@t * .95)], $t[-1];
' "$runs" "$dir/raven" "$work/payload.json"
