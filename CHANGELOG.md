# Screen Bot v3: changelog

Each version that runs on the server gets a git tag. To go back to one:
`git checkout <tag> -- <file>`, upload the file, restart the bot.

## 2026-10-23-baseline

The bot as it ran on the Toronto droplet on 23 Oct 2026 (session summary of 23 Oct).

- Gates 0-6 as described in README.md; Gate 6 simulations not pinned to the screen block.
- Tracker (extras/lookback.js): minute job for the first hour (+2m, +5m, +10m, +30m),
  15-minute job, 7-day follow for SNIPs, PASSED GATES 0-5 and Gate 6 holds; raw prices in extras/live/samples.csv.
- extras/export-day.js: one day's tokens, SNIPs first.
- extras/gate6-recheck.js: Gate 6 second opinion on the screen's own block.
- Crontab (botuser):
  `*/15 * * * * ... lookback.js --live` and `* * * * * ... lookback.js --live --early`, both with flock -w.
