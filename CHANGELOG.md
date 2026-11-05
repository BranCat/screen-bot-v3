# Screen Bot v3: changelog

Each version that runs on the server gets a git tag. To go back to one:
`git checkout <tag> -- <file>`, upload the file, restart the bot.

## 2026-11-05-source-feed

**Source feed**: a token that launches with its source hidden is now noticed within about a minute of the
source being published, and is watched for 24 hours instead of 1. Same gates and verdict rules.

Why: 1 in 3 SNIPs launch before their source is published. They were found only at the next re-check
(median 16 min after launch, up to 30 min late), and anything published after 1 h was given up for good.
The 24 h shadow test (extras/feed-shadow.js, 3-4 Nov) read the explorer's "recently verified contracts" list
every 60 s: 1,440 reads, all HTTP 200, no gaps, new verifications seen a median 31 s after verified_at. It
saw the 3 late tokens the bot found 1-17 min sooner, and 5 tokens the bot had given up on; one of those,
MONKEYBOX, screens SNIP today.

- New source-feed.js: reads Blockscout API v2 /smart-contracts (newest first) through source-gate.js's route,
  pages back to the last entry seen, returns the addresses just verified (a proxy entry also names its
  implementations). It never decides anything.
- watch-launches.js:
  - `--source-feed 60` (default; `0` or `--no-source-feed` = off): while tokens wait for their source, the
    list is read every 60 s. A waiting token named there (its own address, or the implementation of a proxy
    token) is looked up at once with the full source gate. A proxy whose implementation is still hidden keeps
    waiting (the PONS case). No reads while nothing waits.
  - New default schedule `--source-recheck 30,300,1800,7200,86400`: backup lookups at 30 s, 5 min, 30 min,
    2 h, then given up at 24 h (was 30,60,120,300,600,900,1800,3600 on the server). A feed lookup is not a
    schedule slot.
  - A failed feed read is logged ("[feed] read failed", first and every 10th) and changes nothing; the backups
    keep working. HTTP 402 goes to the existing quota alarm and pauses the feed for --hold-retry seconds.
  - Records: `sourceRecheck.foundBy` = "feed" or "schedule", `sourceRecheck.feed` = { everySec, lookups };
    detections.jsonl source_found carries foundBy. Hourly "[explorer]" line adds feed reads, requests,
    failures, hits and the number waiting. Summary on exit adds "found by the feed".
  - source-wait.json from the old version is re-counted against the new schedule on load (from each entry's
    last lookup time), so no entry is stuck or skips a backup.
- Cost: about 1,440 feed requests a day while anything waits (counted in the [explorer] line); lookups per
  waiting token about the same as before. The key's daily credit limit is to be confirmed at dev.blockscout.com.
- Watch for: screens of late tokens happen hours after launch, on the token's state at that time (a pool
  drained meanwhile fails Gate 1b). Price tracking starts at that screen.
- Files: source-feed.js (new), test-source-feed.js (new, 9 checks), watch-launches.js, test-watch-launches.js
  (+13 checks, 63 in all), token-screener-v3.service (adds --source-recheck and --source-feed). Old copies kept as
  watch-launches.before-sourcefeed.js, test-watch-launches.before-sourcefeed.js. No package, .env or cron changes.

## 2026-10-24-change-check

New **change check, RECORD ONLY**: can the token be changed after release? It never changes a verdict;
the three export groups stay as they are. Plan: collect about a week of findings, then decide whether
to make it a hard rule (its own tagged version).

- New change-check.js. For every token that reaches Gate 2 (i.e. could become a SNIP) it records:
  proxy and who can upgrade it (EIP-1967 admin / ProxyAdmin owner, beacon owner, UUPS owner; minimal clones
  are not upgradeable); owner() / getOwner() renounced or live, pendingOwner; AccessControl role holders
  (RoleGranted events confirmed with hasRole); owner-, role- or special-address-only switches in the
  published source (fees/tax, limits, blacklist, trading/pause, mint; selfdestruct/delegatecall noted);
  the v4 hook (proxy? owner?). Template-matched tokens are scanned with the template's source.
  Only the token's own contract and the contracts it inherits from are scanned (the explorer's contract
  name): a verified Pons token can carry the whole launchpad's source (hook, factory, locker), whose
  admin functions are not the token's. If the token's contract cannot be identified, the result is
  UNKNOWN, never DO NOT SNIP.
- `wouldBe` = what the planned rule would say: DO NOT SNIP / UNKNOWN / PASS (NOT CHECKED on an error).
  The hook is reported only and does not affect it yet.
- screen-token.js: runs it after Gate 1b, before Gate 2; result in the screen file (`detail.changeCheck`)
  and on the verdict (`change`); one log line "Change check (record only, does not decide)". An error is
  recorded as NOT CHECKED and the screen goes on.
- extras/export-day.js: two new CSV columns at the end, `change_check` and `change_notes`. The on-screen
  list is unchanged. Tokens screened before this version leave them blank.
- CLI for a one-off look: `node change-check.js 0xTOKEN [--json]` (read-only; uses config.RPC_URL like the bot, never RPC_URL from .env).
- Cost: one explorer source lookup per new bytecode (cached while the bot runs), a few RPC reads per token.
- Files: change-check.js (new), test-change-check.js (new, 50 checks), screen-token.js, test-screen-token.js
  (+5 checks), extras/export-day.js. No cron, package or .env changes.

## 2026-10-24-gate6-pin

Gate 6 fix. Same checks and same verdict rules; the three export groups are unchanged.

- Gate 6 simulations and chain reads now use the screen's own block (Gate 3's pinnedBlock),
  like Gates 3-5b. Fixes false alarms such as ORBIX (sell sized on one block, run on a newer one).
- The top holder's balance is read on-chain at that block instead of trusting the explorer's current figure.
- Whale dump retried in pieces (1, then 4, then 10 sales) when one sale of the whole balance reverts;
  `sellCapSuspected` is recorded when only smaller sales go through.
- For a contract holder whose approval fails, one more try simulates it as a plain wallet
  (`whaleCodeCleared`, stated in the reason). Can only make Gate 6 stricter.
- Every whale attempt is saved in the screen file (`whaleDump.attempts`): failing step, decoded revert
  reason, deepest failing call, gas used vs limit.
- extras/gate6-recheck.js passes the block to rug-check.js.
- Files: rug-check.js, screen-token.js, extras/gate6-recheck.js, test-rug-check.js (+33 checks),
  test-screen-token.js (+2 checks). No cron, package or .env changes.

## 2026-10-23-baseline

The bot as it ran on the Toronto droplet on 23 Oct 2026 (session summary of 23 Oct).

- Gates 0-6 as described in README.md; Gate 6 simulations not pinned to the screen block.
- Tracker (extras/lookback.js): minute job for the first hour (+2m, +5m, +10m, +30m),
  15-minute job, 7-day follow for SNIPs, PASSED GATES 0-5 and Gate 6 holds; raw prices in extras/live/samples.csv.
- extras/export-day.js: one day's tokens, SNIPs first.
- extras/gate6-recheck.js: Gate 6 second opinion on the screen's own block.
- Crontab (botuser):
  `*/15 * * * * ... lookback.js --live` and `* * * * * ... lookback.js --live --early`, both with flock -w.
