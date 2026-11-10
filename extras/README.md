# extras/ — side tools that run beside the live bot

Nothing in this folder changes the live bot. The bot does not load these files,
and they do not edit the bot's files. They read `screens/` and write their own
output here. No restart is needed to add, change or delete them.

| Tool | What it answers | Costs |
|---|---|---|
| `lookback.js` | If I had bought 0.05 ETH when the bot finished screening a token, what would selling return at +1 h, +6 h, +24 h and now? Also the best and worst moment, and pools that were emptied. | RPC reads only, no Tenderly |
| `gate6-recheck.js` | A second opinion on Gate 6 for tokens the bot left "PASSED GATES 0-5", with the rug check pinned to the screen's own block. It also applies the v3 rule. | About 3 to 6 Tenderly simulations and 1 explorer lookup per token |

Run both from `/home/botuser/bot-v3` as botuser:

    cd /home/botuser/bot-v3
    sudo -u botuser node extras/test-lookback.js | tail -1          # offline tests
    sudo -u botuser node extras/test-gate6-recheck.js | tail -1

    sudo -u botuser node extras/lookback.js --probe                  # does the RPC keep old state?
    sudo -u botuser node extras/lookback.js --dates 2026-10-19 --limit 3   # small trial
    sudo -u botuser node extras/lookback.js                          # every token that reached Gate 2+, all days
    sudo -u botuser node extras/lookback.js --set 1b --sample 40     # 40 random Gate 1b rejections

    sudo -u botuser node extras/gate6-recheck.js --max 2             # the first 2 inconclusive tokens
    sudo -u botuser node extras/gate6-recheck.js                     # the rest (10 per run)
    sudo -u botuser node extras/gate6-recheck.js --set snip --max 3  # control: should agree with the bot

The chain's public RPC keeps no old state (probe, 20 Oct), so the scorecard runs
in two parts:

- Past tokens: `lookback.js` measures what each token is worth NOW, starting
  from the amount Gate 3 bought (status "ok (now only)"). It needs no history.
- From now on: `lookback.js --live`, every 15 minutes from cron, records +1 h,
  +6 h and +24 h as they arrive, plus the best and worst moment it saw. Output:
  `extras/live/lookback-live.csv` (the "late_min" columns say how many minutes
  after the checkpoint the run landed).

Install the 15-minute job (once):

    mkdir -p /home/botuser/bot-v3/extras/live && chown -R botuser:botuser /home/botuser/bot-v3/extras
    (crontab -u botuser -l 2>/dev/null; echo "*/15 * * * * cd /home/botuser/bot-v3 && flock -n extras/live/.lock $(which node) extras/lookback.js --live >> extras/live/live.log 2>&1") | crontab -u botuser -
    crontab -u botuser -l          # check it is there
    tail -3 extras/live/live.log   # after 15 minutes: one line per run

Remove it: `crontab -u botuser -l | grep -v 'lookback.js --live' | crontab -u botuser -`

Early checkpoints (+2m, +5m, +10m): a second job, `--live --early`, runs every
minute. It looks only at screen files written in the last ~18 minutes and
quotes only tokens younger than 13 minutes, so a minute with no new token costs
one block read and writes nothing to the log. Both jobs share `state.json`, so
both wait for the same lock (`flock -w`) instead of skipping (`flock -n`).
Install both lines (this replaces the old 15-minute line):

    cd /home/botuser/bot-v3
    crontab -u botuser -l | grep -v 'lookback.js --live' > /tmp/ct.botuser
    echo "*/15 * * * * cd /home/botuser/bot-v3 && flock -w 120 extras/live/.lock $(which node) extras/lookback.js --live >> extras/live/live.log 2>&1" >> /tmp/ct.botuser
    echo "* * * * * cd /home/botuser/bot-v3 && flock -w 50 extras/live/.lock $(which node) extras/lookback.js --live --early >> extras/live/live.log 2>&1" >> /tmp/ct.botuser
    crontab -u botuser /tmp/ct.botuser && rm /tmp/ct.botuser
    crontab -u botuser -l          # two lookback lines

The CSV gains `ret_2m`, `ret_5m`, `ret_10m` (with `late_min_` columns) before
`ret_1h`. A token first seen after an early checkpoint has passed leaves it
blank; one seen in time but not re-quoted within 3 minutes is marked missed.
Tokens already being watched when this is installed show their early points as
missed (blank). `first_pct` now comes from about 1 minute in, not about 8.

Since 23 Oct the minute job keeps quoting each token every minute for its first
hour (`--early-window 1h`, checkpoints +2m/+5m/+10m/+30m), and SNIPs, PASSED
GATES 0-5 and Gate 6 holds are followed for 7 days: every 15 minutes for the
first day, then hourly, with `ret_3d` and `ret_7d` columns. Other tokens stop at
24 h. Every quote is appended to `extras/live/samples.csv` (time, token, age in
minutes, return): the minute-by-minute path for testing trading rules.

Daily list of one day's tokens, SNIPs first, with the tracker's prices:

    sudo -u botuser node extras/export-day.js --date 2026-10-22     # default: yesterday, Calgary time


Outputs:

- `extras/lookback.csv` and `extras/lookback.jsonl`: one row per token. A rerun
  skips tokens already done, and retries rows that failed for a passing reason.
  `--fresh` starts over.
- `extras/gate6/gate6.csv` and `gate6.jsonl`: one row per token, with the bot's
  verdict, the second opinion and whether they agree.

Reading the numbers:

- `ret_0` is an instant buy-and-sell at the screen block. It should be close to
  Gate 4's cost (about -5.9% for the 2.99% Pons fee tier). If it is not, the row
  notes it.
- Returns are after both hook fees and before gas. -100 means nothing could be
  sold: an emptied pool or a blocked sell.
- "WOULD SNIP" means the second opinion passed Gate 6 on the screen's block.
  "PASS, LIQUIDITY CONTROL UNKNOWN" is a pass on a pool whose liquidity
  controller is not LOCKED (every v3 pool today), and is never a SNIP.

## ready-times.js (added 2026-11-09)

Read-only. For every SNIP and every Gate 6 rejection (passed Gates 0-5), records the
moment the token could first be traded: the later of the launch block and the time its
source was published (explorer verified_at). Next to it, when the bot actually marked it,
and the gap (bot_lag_s). Labels each token "code first" or "trades first".

    node extras/ready-times.js            backfill, all dates (one explorer request per token)
    node extras/ready-times.js --live     new screens only (cron, every 15 min)

Output: extras/ready/ready-times.jsonl and .csv. Tests: node extras/test-ready-times.js

    node extras/ready-times.js --show 2026-11-09   readable list from that date, Edmonton time

2026-11-10: the explorer's verified_at can be earlier than the moment the source could
really be read (LGND, AGENTDOM: the bot asked after that time and got "not published").
The code time is now checked against the bot's own checks in the screen file:
code_absent_utc (last "not published" check, or the feed's previous read when the feed
found it) and code_seen_utc (the check that found it). The explorer time is used if it
lies between the two; if earlier, code_absent_utc is used and explorer_early_s says by
how much; if later (Sourcify, twin), code_seen_utc. code_explorer_utc keeps the
explorer's own value. Rows already recorded are not recalculated: after installing
this version, rebuild once into a side file (--out extras/ready/ready-times-new),
compare, then move it over ready-times.jsonl/.csv.

## verify-ready.js (added 2026-11-09, updated 2026-11-10)

Read-only check of ready-times.js against the chain: pool created, first liquidity,
pool live (launch block), first trade, first trade after the code. The code time is the
explorer's (asked again) held against the bot's checks, like ready-times.js, so for
trades-first tokens it is a consistency check, not an independent one.

    node extras/verify-ready.js --sample 20          20 random tokens
    node extras/verify-ready.js --since 2026-11-09   every token from that date
    node extras/verify-ready.js --days 2             the last 2 days (daily cron)

Results: AGREES / CHECK / INCOMPLETE. An early explorer time is AGREES with a note. A
trade before the launch block is CHECK only if the code was already published then
(LIT); liquidity before the launch block is a note. Output: extras/ready/verify.csv
(this run) and extras/ready/verify-all.csv / .jsonl (every token ever checked, newest
check kept: the record of first liquidity and first trade).
Tests: node extras/test-verify-ready.js

Daily cron (botuser), 02:37 UTC:

    37 2 * * * cd /home/botuser/bot-v3 && /usr/bin/node extras/verify-ready.js --days 2 >> extras/ready/verify.log 2>&1
