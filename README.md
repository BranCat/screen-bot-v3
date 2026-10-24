# screen-bot-v3

Simulation-first token screening for Robinhood Chain (4663), covering **Uniswap v3 and v4**.

Everything here answers a question with a Tenderly simulation rather than a heuristic about
the contract's source. Nothing counts as evidence unless Tenderly actually executed it.

---

## Install

Drop these files next to the three from the existing project that they depend on:

    config.js              network + contract addresses
    tenderly-client.js     bundle plumbing (buildStep, simulateBundle, …)
    tenderly-bundle-v4.js  the v4 round trip

Then:

    npm i ethers@5 axios dotenv

`.env` needs your Tenderly credentials:

    TENDERLY_ACCESS_KEY=...
    TENDERLY_ACCOUNT_SLUG=...
    TENDERLY_PROJECT_SLUG=...
    MY_WALLET_ADDRESS=0x...        # optional; the --wallet default

**Never put a private key or seed phrase in `.env`, in a script, or in a chat.**
Nothing here needs one. Tenderly spoofs the sender; nothing is ever signed.

### One-line change worth making

`rug-check.js` keeps a fallback copy of the v4 swap encoder because the real one isn't
exported. To remove the duplicate, change the last line of `tenderly-bundle-v4.js` to:

```js
module.exports = { simulateUniV4Txn, runOneV4RoundTrip: runOneRoundTrip, encodeV4SwapExecute };
```

`test-rug-check.js` diffs the two byte-for-byte, so they can't silently drift apart.

---

## Run the tests first

    node test-swap-legs.js
    node test-bundle-v3.js
    node test-rug-check.js
    node test-wallet-round-trip.js
    node test-transfer-audit.js

244 checks, fully offline — no RPC, no Tenderly, no API key. They cost nothing and they
prove the calldata encoding before you spend a single simulation.

Each case builds a fake token with one *known* hidden behaviour and asserts the tool
reports that number exactly, so a 5% skim has to read as `5.00%`.

---

## The scripts

### `transfer-audit.js` — are there hidden fees?

    node transfer-audit.js 0xTOKEN --wallet 0xYou [--amount 0.05]

A swap is a chain of movements:

    PoolManager/pool  --(a)-->  router  --(b)-->  your wallet

The AMM decides how much leaves the pool, and **that figure already contains the pool fee
and the price impact** — so the pool's own balance, before minus after, is the honest
"in theory" number, measured rather than predicted. Anything that goes missing after that
point is the token's doing. Price impact cannot explain it.

Measures both ends of every leg, plus the two transfer paths side by side:

    transfer()      wallet -> a fresh address       the plain path
    transferFrom()  a spender moves your tokens     the path every DEX sell uses

A token taxing one and not the other was written to be checked carelessly. Also catches
`approve()` storing something other than what it was given, and an exact allowance being
rejected where an unlimited one is accepted.

### `wallet-round-trip.js` — what does the trade actually cost?

    node wallet-round-trip.js 0xTOKEN --wallet 0xYou [--amount 0.05]

0.05 ETH in, sell everything, how much ETH lands back. Answers in ETH, not ratios.

Sells **100%** first, not 90% — that headroom is where a "you can sell most of it, never
all of it" token hides — and walks 100 → 99 → 95 → 50 if it reverts, so you learn which
rung held. Counts gas as measured units × the live gas price. Splits the shortfall into
pool fee, measured token tax, and price impact.

### `rug-check.js` — can the money be taken away after I buy?

Gate 6. Three probes:

- **census** — rebuilds every liquidity position from the pool's event log and resolves
  who is behind each one (both position managers are ERC721s, and in v4 the position
  `salt` is the tokenId, so `ownerOf(salt)` turns "a contract holds it" into "this EOA").
- **removal** — spoofs that owner and actually pulls the liquidity, then measures what a
  victim recovers.
- **whale dump** — the top holder sells its entire real balance, then the victim tries to
  get out. This is the one that matters for Bags graduates, whose LP genuinely is locked
  but whose deployer holds 170M of 1B supply.

There is deliberately **no `LOCK_PROVEN` verdict.** A reverted removal is more often our
calldata being wrong than a real lock, so every attempt runs twice — once as the owner,
once as a stranger who owns nothing — and only a *difference* counts as evidence.

**Changes on 10 October 2026:**

- The removal probe only spoofs an **EOA** owner. A simulated call "from" a contract runs
  none of that contract's code, so spoofing a locker always "succeeds" (this is why CRTN
  and Passkeys showed REMOVABLE). If the owner is a contract, the probe does not simulate
  anything. It reports `LOCKED_PER_CONTROLLER` when Gate 1b said LOCKED (a reviewed
  locker), otherwise `CONTRACT_OWNER`, which is inconclusive. A burn-address owner is
  `LOCKED_BURNED`.
- The whale dump's top-holder lookup goes through curl with the short browser identity,
  the same route as Gate 0, because Node's fetch got HTTP 403. The pool hook and the Pons
  locker are not counted as whales.
- The baseline sells 100% of the Gate 3 position, stepping down to 99/95/90% only if the
  sell reverts, and every ratio is scaled to the share sold. It used to sell a flat 90%
  and divide by the whole buy, which read as a ~15% loss on a ~5% round trip.
- Backups: `rug-check.before-gate6fix.js`, `screen-token.before-gate6fix.js`.

**Explorer lookups (Gate 0 and the whale dump), from 10 October 2026:** put a free key from
dev.blockscout.com in `.env` as `BLOCKSCOUT_API_KEY=...`. Lookups then go to Blockscout's
official API (`https://api.blockscout.com/4663/api/v2/...`) as plain Node requests, with no
curl and no browser identity. The key is masked as `apikey=***` in every message. Without a key,
the old route is used (the robinhoodchain.blockscout.com website through curl), which stopped
working from Frank's PC on 10 October with ERR_CONNECTION_RESET.

### `screen-token.js` — the full gate chain

    node screen-token.js 0xTOKEN [--amount 0.05] [--min-liq 1] [--json]

    0   source published         Sourcify, then the block explorer
    1   find the pool            every pool ranked: live > launchpad hook > fee <= 10% > deepest;
                                 other pools reported, trap fees (> 10%) flagged
    1b  who controls liquidity   CREATOR_CAN_PULL / DRAINED = DO NOT SNIP
    2   liquidity minimum        (v3)
    3   round trip #1            wallet-round-trip.js, fresh random wallet, sell 100%
    4   round trip #2 + judge    second fresh wallet; hidden token tax <= 0.5%,
                                 total cost <= 6%, the two wallets agree within 1.5%
    5   full exit                100% sells (99% allowed as rounding)
    5b  transfer audit           hidden buy/sell/transfer/transferFrom tax, approve traps
    5c  allowance backdoor       stranger/deployer transferFrom without approval,
                                 balance vs Transfer events (ghost transfers), source scan
    6   rug check
                                 UNPROVEN / UNKNOWN is never a pass

Until 2026-10-08 Gates 3-5 never simulated anything on v4 pools: the bundle
module needed pool reserves it was never given, returned "unsupported", and
that read as "buy ok, sell ok". Fixed at both ends.

### `watch-launches.js` — screen every new launch automatically

    node watch-launches.js                     watch live from now on
    node watch-launches.js --since 3h --once   replay the last 3 hours, screen them, exit
    [--amount 0.05] [--min-eth 1] [--min-usdg 1000] [--poll 10] [--out launches.jsonl]

v1's detection (pool created, then liquidity added) feeding `screen-token.js`.
Polls with getLogs instead of a WebSocket. "*** NEW TOKEN" prints the moment a
launch is seen; screening runs one token at a time behind it. Every screened
token gets one line in `launches.jsonl`, and a token already in that file is
never screened again. Hidden source = marked and skipped. A wallet that could
pull an earlier launch's liquidity is flagged when it appears again.

### Gate 1b in `screen-token.js` — who controls the liquidity

Runs `controller-check.js` right after the pool is found, before any Tenderly
simulation. CREATOR_CAN_PULL or DRAINED = DO NOT SNIP. LOCKED = continue.
UNKNOWN = continue, shown as a FLAG on the final verdict. A USDG pool now gets
Gates 0-1b and then UNKNOWN (the simulations don't cover USDG yet).

### `swap-legs.js` — the shared v3/v4 leg builder

Not run directly. One place that knows how to buy and sell, so the others don't each grow
their own half-finished copy.

The protocols are not shaped the same:

|                     | v3                  | v4                        |
|---------------------|---------------------|---------------------------|
| pool tokens live at | the pool contract   | one shared PoolManager    |
| router              | SwapRouter02        | forked UniversalRouter    |
| token pulled via    | plain `approve()`   | Permit2                   |
| base currency       | always WETH         | WETH **or** native ETH    |

Because v3 pairs are always ERC20/ERC20, the "did all my ETH arrive" check is a *direct*
measurement on v3; on a native v4 pool it has to come out of a balance diff.

**Router shape is read, not guessed.** Two incompatible `exactInputSingle` structs exist —
SwapRouter02 dropped the `deadline` field v1 had — and they have different selectors
(`0x04e45aaf` vs `0x414bf389`). `swap-legs.js` reads the router's deployed bytecode once
and looks for one. If neither appears (a proxy, say) it says so; force it with:

    V3_ROUTER_STYLE=SwapRouter

### `tenderly-bundle-v3.js`

The v3 counterpart to `tenderly-bundle-v4.js`, same export contract, so `screen-token.js`
Gates 3–5 work on v3 with no changes on the calling side.

### `source-gate.js`

Gate 0: is the contract's source published (proxy-aware). Asks Sourcify first, then the
chain's own block explorer (robinhoodchain.blockscout.com). Either one = PASS. Neither = SKIP.
A contract the explorer only matches to a *similar* verified contract is still SKIP (the twin
is recorded). If a lookup fails and nothing says PASS, the answer is ERROR, never SKIP.
`SOURCE_GATE_NO_EXPLORER=1` turns the explorer step off (Sourcify only, as before).

### `recheck-source.js` — re-run Gate 0 on everything it skipped

    node recheck-source.js            [--screen] [--limit N]

Reads `launches.jsonl` (never changes it), re-checks every Gate 0 skip, writes
`recheck-source.jsonl` and `logs/recheck-<time>.txt`, and prints how many are public
now, by launch path. `--screen` also runs the full screener on any that now pass.

---

## What none of this proves

One block, one wallet, one size. A token that turns hostile on the second sell, after a
timer, or above a threshold passes all of it. The ladder covers size; Gate 6 covers
liquidity removal; repeat runs cover time. Nothing here is a guarantee about the next trade.

**And there is still no ground truth.** The 244 checks prove these scripts report the
numbers they are given correctly. They do not prove the numbers are right about a real
token on chain 4663. That needs two or three addresses with known outcomes — at least one
that rugged and one that is fine — run through the whole chain.

`token-ground-truth-labels.xlsx` has 115 candidate rows and zero filled-in labels.
That is the next thing worth doing.

**Gate 5b, transfer audit (10 October 2026):** after Gates 3-5, `screen-token.js` runs
`transfer-audit.js` on the same pool from a fresh wallet. It checks the buy leg (pool paid out
vs wallet received), the sell leg (tokens and ETH), `transfer()` vs `transferFrom()` of the same
amount, and approve/allowance behaviour. A high finding (hidden tax, reverting path,
transfer/transferFrom asymmetry, broken approve) is DO NOT SNIP. A medium (unexplained) finding,
or an audit that cannot finish, is UNKNOWN. An info finding (a pool hook's visible fee, e.g.
Pons ~2.5%) is noted and the screen continues to Gate 6. `launches.jsonl` records now carry
`audit` and a short `rug` summary.

**Gate 5c, allowance backdoor and ghost transfers (12 October 2026):** after Gate 5b,
`screen-token.js` runs `allowance-probe.js`. Prompted by the Moo Daeng token
(`fixtures/moo-daeng.sol`), where anyone could send a holder's tokens to 0xdead without
approval, the deployer could move anyone's tokens anywhere, and moves to 0xdead emitted no
Transfer event, so Etherscan kept showing 100 while `balanceOf()` said 30. In one Tenderly
bundle it buys into a fresh wallet, then has a **stranger** call `transferFrom(victim, 0xdead)`
and `transferFrom(victim, stranger)` with no approval, has every **privileged** address it can
find (`owner()`, the creator from Blockscout, addresses hard-coded in the source) try to take
tokens, and makes two of the wallet's own transfers as a control. Every balance change is
compared with the Transfer events of that step (a mismatch is a "ghost transfer"). The verified
source is also scanned for an allowance check or Transfer event that only happens under a
condition (the normal `!= type(uint256).max` shortcut and `if (fee > 0) emit` are ignored).
Stranger or privileged-wallet theft is DO NOT SNIP. A privileged unknown contract, a ghost
transfer, a suspicious source pattern, or a part not measured is UNKNOWN. Known launchpad
infrastructure (Pons factory/locker/hook, Permit2, routers) with that power is noted only.
Records carry an `allowance` summary. Standalone: `node allowance-probe.js 0xTOKEN`.
Tests: `node test-allowance-probe.js` (42 checks, includes a model of Moo Daeng).

**Tenderly "have 0 / truncated bundle" fixed (12 October 2026):** not a random glitch. Tenderly
sometimes ignores an ETH-balance override that is not on the bundle's first step. The Gate 5b
buy-leg bundle puts five balance reads before the funded buy, so it failed there (Passkeys: 6
results for 11 steps, three times). `tenderly-client.js` now also applies every ETH-balance
override on step 1 (`hoistBalanceOverrides`); storage/code overrides are untouched. Test:
`node test-tenderly-client.js`. Backup: `tenderly-client.before-hoist.js`.

**Full data saving (13 October 2026):** `watch-launches.js` now also writes
`detections.jsonl` (every pool event seen: `pool_created` — including extra pools for an
already-launched token, `knownToken: true` — each `liquidity` add with its running total,
`launched`, and `expired` when a pool never reaches the minimum within ~24h; replays after a
restart are not written twice) and `screens/<date>/<time>_<SYMBOL>_<token>.json` (the record plus
every gate's complete result, `r.detail`, as plain JSON via `safe-json.js`: BigNumbers as exact
decimal strings, raw Tenderly payloads dropped). `launches.jsonl` is unchanged. Options:
`--detections FILE`, `--screens DIR`. Tests: `test-watch-launches.js` (33), `test-screen-token.js`
(68), `test-safe-json.js` (9). Backups: `*.before-fulldata.js`.
