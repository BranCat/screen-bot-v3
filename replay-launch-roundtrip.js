// replay-launch-roundtrip.js — re-run Gate 4's round trip on a past launch, with every
// bundle pinned to one historical block (2026-10-18). Read-only: Tenderly simulations
// from fresh random addresses (no key exists for them); nothing is signed or sent.
//
// Why: on 15 Oct several Pons launches failed Gate 4 because their 100% sell reverted
// and unsold tokens were counted as cost. The cause found in the code: the probe and
// the measurement ran on different blocks while the price was moving. This replays
// those launches on ONE block, the way wallet-round-trip.js now runs, to show what
// they really cost at launch.
//
//   node replay-launch-roundtrip.js                  the 7 Pons launches of 15 Oct
//   node replay-launch-roundtrip.js 0xTOKEN BLOCK    one token at one block
//   [--offset 250]   blocks after the launch block to simulate at (10 blocks = ~1 s)
//
// Uses 4 Tenderly simulations per token (2 wallets x probe + sell).
require('dotenv').config();
const ethers = require('ethers');
const { walletRoundTrip } = require('./wallet-round-trip');
const path = require('path');
const { discoverPool, poolHintsFromLaunches } = require('./screen-token');
const config = require('./config');

const CASES = [ // symbol, token, launch block, Gate 4 at launch (15 Oct)
  ['IRIDIUS', '0x28E3c0C404088f1a5d739221072DdF6AB4431022', 89210729, '6.53% (0.65% unsold)'],
  ['NOUS', '0xD99baB75a7755a868257787c459d834ee500f883', 89246758, '9.16% (3.59% unsold)'],
  ['ROBBIN', '0x2EEA8ce5c31e7Ffd42F0c2e4da33f5BC7A7bFfD7', 89374838, '20.70% (all sold)'],
  ['KEPT', '0x50d26490F7915983beDBA927361Fb0142EFA1214', 89379934, '8.78% (1.07% unsold)'],
  ['ATLAS', '0xfec62b03A3F7366508Aa200C500e6B76fac99a61', 89479665, '7.93% (2.12% unsold)'],
  ['PRISM', '0x143185685456e50b88412D6cFC3a6f8D4Fd18afa', 89573959, '9.65% (4.00% unsold)'],
  ['HRX', '0xFCc86D9c23FfB9f27258534eA316C096F1Af51b9', 89761730, '5.90% (all sold) - SNIP'],
];

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const offset = Number(flag('--offset', 250));
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const cases = pos.length >= 2 ? [['token', pos[0], Number(pos[1]), 'n/a']] : CASES;

// config.RPC_URL (Robinhood Chain), like the bot itself. NOT process.env.RPC_URL:
// on the server .env that is an Ethereum-mainnet endpoint.
const rpc = new ethers.providers.JsonRpcProvider(config.RPC_URL);
const pct = (x) => (x == null ? 'n/a' : `${x.toFixed(2)}%`);

(async () => {
  console.log(`replay-launch-roundtrip — ${new Date().toISOString()} — launch block + ${offset}\n`);
  for (const [sym, token, launchBlock, before] of cases) {
    const at = launchBlock + offset;
    // Same provider as usual, except that "the current block" is the historical one,
    // so wallet-round-trip.js pins every bundle there.
    const prov = Object.create(rpc);
    prov.getBlockNumber = async () => at;
    let p;
    // These pools are days old: the normal lookup only scans recent blocks, so give
    // it the pool from the launch records, as rescreen-published.js does.
    const hints = [...poolHintsFromLaunches(token, path.join(__dirname, 'launches-snap-1016.jsonl')),
      ...poolHintsFromLaunches(token)];
    try { p = await discoverPool(token, { prov: rpc, hints }); } catch (e) { p = null; }
    if (!p) { console.log(`${sym.padEnd(8)} pool not found (${hints.length} hint(s) from the launch records) — skipped\n`); continue; }
    const lines = [];
    for (const tag of ['sim1', 'sim2']) {
      const wallet = ethers.Wallet.createRandom().address;
      let r;
      try { r = await walletRoundTrip(token, { wallet, amountEth: 0.05, prov, discover: async () => p }); }
      catch (e) { r = { ok: false, reason: e.message }; }
      if (!r.ok) { lines.push(`  ${tag}: could not complete — ${r.reason}`); continue; }
      const left = r.tokensLeftWei && r.tokensBoughtInBundleWei
        ? (100 * Number(r.tokensLeftWei) / Number(r.tokensBoughtInBundleWei)) : null;
      lines.push(`  ${tag}: cost ${pct(-r.netPct)} · sold rung ${r.soldBps / 100}% · ${r.fullExit ? 'full exit' : `left ${pct(left)}`}`
        + ` · ladder ${r.attempts.map((a) => `${a.bps / 100}%${a.reverted ? ' reverted' : ' ok'}`).join(', ')}`
        + ` · block ${r.pinnedBlock ?? 'LATEST'}${r.pinFallback ? ` (FALLBACK: ${r.pinFallback})` : ''}`);
    }
    console.log(`${sym.padEnd(8)} at launch: ${before}`);
    lines.forEach((l) => console.log(l));
    console.log('');
  }
})().catch((e) => { console.log(`replay error: ${e.message}`); process.exit(1); });
