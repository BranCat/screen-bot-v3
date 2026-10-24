# Screen Bot v3: changelog

Each version that runs on the server gets a git tag. To go back to one:
`git checkout <tag> -- <file>`, upload the file, restart the bot.

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
