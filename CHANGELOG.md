# Screen Bot v3: changelog

Each version that runs on the server gets a git tag. To go back to one:
`git checkout <tag> -- <file>`, upload the file, restart the bot.

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
