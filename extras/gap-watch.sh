#!/usr/bin/env bash
# extras/gap-watch.sh — read only. Runs restart-gap-check.js by itself after any bot restart.
#
# Added 2026-11-15. The bot keeps pools that are still waiting for liquidity only in
# memory, so after any restart (a reboot, or a restart you do yourself) it can miss a
# launch for up to 24 h. This script, run once a day from cron, notices a new bot start
# time, waits until that start's 24 h window is over, then runs restart-gap-check.js
# once for it and writes the result to extras/restart-gap/gap-watch.log.
#
# Nothing here touches the bot. Cron line (botuser), daily at 03:07 UTC:
#   7 3 * * * /home/botuser/bot-v3/extras/gap-watch.sh
# Read the result:  tail -3 /home/botuser/bot-v3/extras/restart-gap/gap-watch.log

set -u
BOT=${BOT_DIR:-/home/botuser/bot-v3}
DIR="$BOT/extras/restart-gap"
STATE="$DIR/checked-starts.txt"   # start times (epoch seconds) already checked, one per line
LOG="$DIR/gap-watch.log"
mkdir -p "$DIR"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

start=$(systemctl show token-screener-v3 -p ActiveEnterTimestamp --value 2>/dev/null)
if [ -z "$start" ]; then echo "$(stamp) bot start time unknown (service not running?)" >> "$LOG"; exit 0; fi
sec=$(date -u -d "$start" +%s 2>/dev/null) || { echo "$(stamp) could not read start time '$start'" >> "$LOG"; exit 0; }
iso=$(date -u -d "@$sec" +%Y-%m-%dT%H:%M:%SZ)

if grep -qx "$sec" "$STATE" 2>/dev/null; then
  echo "$(stamp) no new restart (bot started $iso, already checked)" >> "$LOG"; exit 0
fi
now=$(date -u +%s)
if [ $((now - sec)) -lt $((25 * 3600)) ]; then
  echo "$(stamp) NEW RESTART at $iso; its 24 h window is still open, check runs tomorrow" >> "$LOG"; exit 0
fi

echo "$(stamp) checking restart at $iso" >> "$LOG"
cd "$BOT" || exit 1
out=$(node extras/restart-gap-check.js --restart "$iso" 2>&1 | grep -v "injected env")

echo "$out" | grep -E "dropped|MISSED|ERROR|restart-gap-check:" | sed "s/^/$(stamp)   /" >> "$LOG"
if echo "$out" | grep -q "MISSED: [0-9]"; then
  echo "$sec" >> "$STATE"
  echo "$out" | grep -q "MISSED: 0\." || echo "$(stamp) *** A TOKEN WAS MISSED: see the lines above and extras/restart-gap/ ***" >> "$LOG"
else
  echo "$(stamp) check did not finish; it will run again tomorrow" >> "$LOG"
fi
