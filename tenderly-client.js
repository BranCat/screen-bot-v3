// tenderly-client.js — thin wrapper around Tenderly's Simulation API
// (simulate-bundle endpoint), plus small ethers/AMM helpers used by
// tenderly-bundle-v4.js.
//
// RESPONSE-SHAPE NOTE (2026-09 — partly resolved):
// This file was originally written from Tenderly's public docs plus a working
// single-simulate example, without ever having seen a live simulate-BUNDLE
// response. That gap is now closed for the SUCCESS path: a real 7-step v4
// bundle was captured in tenderly-last-response.json and confirms
//
//   res.data.simulation_results[i].transaction.status                    boolean
//   res.data.simulation_results[i].transaction.transaction_info
//                                      .call_trace.output                hex return data
//
// which are exactly the first two paths normalizeResult() already tried. No
// change was needed there.
//
// STILL UNCONFIRMED: what a FAILED step looks like — every step in the
// captured response succeeded, so the revert encoding has never been seen.
// normalizeResult() therefore no longer infers success from the absence of a
// failure signal; see its comment for the tri-state it returns instead.
//
// Keep running with TENDERLY_DEBUG=1 until a bundle containing a genuine
// revert has been captured, then confirm the failure path the same way.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const config = require('./config');

const MAX_UINT256 = ethers.constants.MaxUint256;
const MAX_UINT160 = ethers.BigNumber.from(2).pow(160).sub(1);

const erc20Iface = new ethers.utils.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const wethIface = new ethers.utils.Interface([
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const DEFAULT_GAS = 1_000_000;

// A wallet with no real funds/private-key relevance — Tenderly simulations
// don't require a valid signature for the `from` address, they just execute
// as if that address sent it (this is what makes "impersonation" free).
function freshWallet() {
  return ethers.Wallet.createRandom();
}

// Returns a state_objects fragment overriding an address's native balance.
// Tenderly's state_objects shape (per docs.tenderly.co/simulations/bundled-simulations)
// is `{ "<address>": { "storage": {...}, "balance": "0x..." } }` — balance as
// a hex wei string.
function ethBalanceOverride(address, weiAmount) {
  return {
    [address.toLowerCase()]: {
      balance: ethers.BigNumber.from(weiAmount).toHexString(),
    },
  };
}

// Returns a state_objects fragment overriding a single storage slot on a
// contract. Used for the balance-mapping slot finder in
// transferfrom-backdoor-check.js — same state_objects.storage shape as
// ethBalanceOverride uses for .balance, per Tenderly's docs.
function storageOverride(contractAddress, slotHex, valueHex) {
  return {
    [contractAddress.toLowerCase()]: {
      storage: { [slotHex]: ethers.utils.hexZeroPad(valueHex, 32) },
    },
  };
}

// Merges multiple state_objects fragments (from ethBalanceOverride/
// storageOverride/etc, possibly touching different addresses, or the same
// address's balance and storage separately) into one. Not currently needed
// by tenderly-bundle-v3/v4.js (each only ever applies one override at a
// time), but the backdoor check needs to layer a storage override onto an
// otherwise-plain step, so this is here for that and any future case.
function mergeStateObjects(...fragments) {
  const merged = {};
  for (const frag of fragments) {
    if (!frag) continue;
    for (const [addr, obj] of Object.entries(frag)) {
      const a = addr.toLowerCase();
      merged[a] = merged[a] || {};
      if (obj.balance !== undefined) merged[a].balance = obj.balance;
      if (obj.storage) merged[a].storage = { ...(merged[a].storage || {}), ...obj.storage };
      if (obj.code !== undefined) merged[a].code = obj.code;
    }
  }
  return merged;
}

// Standard Solidity storage slot derivation for `mapping(address => T)`
// declared at storage slot `baseSlot`: the value for key `address` lives at
// keccak256(abi.encode(address, uint256(baseSlot))). This is the layout
// solc has used for mappings since storage layout was first documented and
// is not expected to change (it's load-bearing for basically every existing
// contract) — see the Solidity docs' "Layout of State Variables in Storage"
// section. Used to brute-force which slot a token's `_balances` mapping is
// at, since that varies per contract (declaration order-dependent) — see
// transferfrom-backdoor-check.js.
function mappingSlot(key, baseSlot) {
  const paddedKey = ethers.utils.hexZeroPad(ethers.utils.getAddress(key), 32);
  const paddedSlot = ethers.utils.hexZeroPad(ethers.BigNumber.from(baseSlot).toHexString(), 32);
  return ethers.utils.keccak256(ethers.utils.concat([paddedKey, paddedSlot]));
}

// Builds one entry of the `simulations` array for a bundle call.
function buildStep({ from, to, data, value, gas, stateObjects, networkId }) {
  const step = {
    network_id: networkId || process.env.TENDERLY_NETWORK_ID || config.CHAIN_ID_STR,
    from,
    to,
    input: data || '0x',
    gas: gas || DEFAULT_GAS,
    gas_price: '0',
    value: value ? ethers.BigNumber.from(value).toString() : '0',
    save: true,
    save_if_fails: true,
    simulation_type: 'full',
  };
  if (stateObjects && Object.keys(stateObjects).length > 0) {
    step.state_objects = stateObjects;
  }
  return step;
}

// POSTs the whole bundle in one call so state carries between steps
// (sequential execution against consistent forked state — see the header
// comment in tenderly-bundle-v4.js for why this matters for buy+sell).
// A state override applied to EVERY step of every bundle, on top of any the
// step carries itself. Off unless something sets it. It exists for
// plant-trap-test.js, which swaps a real token's code for a trapped copy
// inside the simulation so the detectors can be proved against a token whose
// misbehaviour is known in advance. Nothing here ever touches the real chain.
let GLOBAL_STATE_OBJECTS = null;
function setGlobalStateObjects(obj) { GLOBAL_STATE_OBJECTS = obj && Object.keys(obj).length ? obj : null; }
function getGlobalStateObjects() { return GLOBAL_STATE_OBJECTS; }
function withGlobalState(steps) {
  if (!GLOBAL_STATE_OBJECTS) return steps;
  // The step's own override wins where both touch the same field.
  return steps.map((st) => ({ ...st, state_objects: mergeStateObjects(GLOBAL_STATE_OBJECTS, st.state_objects) }));
}

// Tenderly occasionally answers a bundle with fewer results than steps: the
// last one has `transaction: null` and an internal error such as "agent call:
// insufficient funds … invalid transaction simulation", even when the step
// carried a balance override that works on every other run. Seen during the
// planted-trap test on 2026-09-29, on an 11-step bundle identical in shape to
// ones that had just succeeded. It is infrastructure, not a result, so the
// whole bundle is retried; if it keeps happening the error says what Tenderly
// actually reported instead of only "cannot align".
const BUNDLE_ATTEMPTS = 3;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulateBundle(steps) {
  let lastErr;
  for (let attempt = 1; attempt <= BUNDLE_ATTEMPTS; attempt += 1) {
    try {
      return await simulateBundleOnce(steps);
    } catch (e) {
      lastErr = e;
      if (!e.truncated || attempt === BUNDLE_ATTEMPTS) break;
      if (process.env.TENDERLY_DEBUG) console.error(`[tenderly] truncated bundle, retrying (${attempt}/${BUNDLE_ATTEMPTS - 1}): ${e.tenderlyError || ''}`);
      await sleepMs(1500 * attempt);
    }
  }
  throw lastErr;
}

// 2026-10-12: the "truncated bundle / insufficient funds … have 0" failures are
// not random. Tenderly sometimes ignores a balance override that sits on a
// step OTHER than the first. transfer-audit.js's buy-leg bundle puts five
// balance reads before the buy, so the wallet's ETH override is on step 6 —
// and on Passkeys (12 Oct) Tenderly returned exactly 6 results for 11 steps,
// failing that step with "have 0" three times in a row. Every bundle whose
// override is on step 1 had never failed this way. So: every pure ETH-balance
// override is ALSO applied on step 1 (the step's own copy stays where it was).
// A bundle always starts from fresh forked state, so funding a wallet a few
// steps early changes nothing except that the override is honoured. Storage
// and code overrides are never moved.
function hoistBalanceOverrides(steps) {
  if (!Array.isArray(steps) || steps.length < 2) return steps;
  const early = {};
  for (const st of steps.slice(1)) {
    for (const [addr, obj] of Object.entries(st.state_objects || {})) {
      const a = addr.toLowerCase();
      if (!obj || obj.balance === undefined || early[a]) continue; // earliest wins
      early[a] = { balance: obj.balance };
    }
  }
  if (!Object.keys(early).length) return steps;
  const first = steps[0];
  // step 1's own overrides win where both touch the same field
  const merged = mergeStateObjects(early, first.state_objects);
  return [{ ...first, state_objects: merged }, ...steps.slice(1)];
}

async function simulateBundleOnce(steps) {
  steps = hoistBalanceOverrides(withGlobalState(steps));
  // _SLUG naming matches the convention already used elsewhere in this
  // project (see the header comment in token-screener-v3.js) — these are
  // your Tenderly project's account/project URL slugs, not display names.
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG } = process.env;
  if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT_SLUG || !TENDERLY_PROJECT_SLUG) {
    throw new Error('Missing TENDERLY_ACCESS_KEY / TENDERLY_ACCOUNT_SLUG / TENDERLY_PROJECT_SLUG — check your .env');
  }

  const url = `https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT_SLUG}/project/${TENDERLY_PROJECT_SLUG}/simulate-bundle`;

  let res;
  try {
    res = await axios.post(
      url,
      { simulations: steps },
      { headers: { 'X-Access-Key': TENDERLY_ACCESS_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    const body = e.response?.data;
    const err = new Error(
      `Tenderly simulate-bundle HTTP ${e.response?.status ?? '(no response)'}: ${JSON.stringify(body ?? e.message)}`
    );
    err.raw = body;
    throw err;
  }

  if (process.env.TENDERLY_DEBUG) {
    try {
      fs.writeFileSync(path.join(__dirname, 'tenderly-last-response.json'), JSON.stringify(res.data, null, 2));
    } catch (_) { /* best-effort debug dump, never fail the run over it */ }
  }

  const rawResults = res.data.simulation_results || res.data.simulations || null;
  // 2026-09: this used to fall back to [] and merely warn under TENDERLY_DEBUG.
  // An empty array then flowed downstream as "every step is missing", which
  // various callers read as a revert or as a clean pass depending on where it
  // landed. An unrecognisable response is not a result — throw, so the caller
  // records it as an error (which the screener files under unknowns, not as a
  // finding about the token).
  if (!Array.isArray(rawResults)) {
    throw new Error(
      `Tenderly simulate-bundle response had no recognisable results array (top-level keys: ${Object.keys(res.data || {}).join(', ') || 'none'}). ` +
      'Re-run with TENDERLY_DEBUG=1 and inspect tenderly-last-response.json.'
    );
  }
  if (rawResults.length < steps.length) {
    const broken = rawResults.find((r) => r && !r.transaction && r.simulation && r.simulation.error_message);
    const tenderlyError = broken ? broken.simulation.error_message : null;
    const err = new Error(
      `Tenderly simulate-bundle returned ${rawResults.length} result(s) for ${steps.length} step(s) — cannot align results to steps` +
      (tenderlyError ? `. Tenderly said: ${tenderlyError}` : '') + ` (after ${BUNDLE_ATTEMPTS} attempts)`
    );
    err.truncated = true;
    err.tenderlyError = tenderlyError;
    throw err;
  }
  return rawResults.map(normalizeResult);
}

// True when any step's status could not be determined. Callers should treat
// this as "we do not know", never as a pass or a revert — see normalizeResult.
function anyIndeterminate(results) {
  return Array.isArray(results) && results.some((r) => r && r.indeterminate);
}

// Normalises one bundle-step result.
//
// 2026-09: the success paths are now CONFIRMED against a real live response
// (a 7-step v4 bundle captured in tenderly-last-response.json):
//   res.data.simulation_results[i].transaction.status              -> boolean
//   res.data.simulation_results[i].transaction.transaction_info
//                                    .call_trace.output            -> return data
// Both of the paths this function already tried first were the right ones, so
// the guesses held. The fallbacks below are kept for other response variants.
//
// What is still NOT confirmed is the shape of a FAILED step — every step in
// the captured response succeeded. That matters, because the old expression
//
//     const reverted = statusRaw === false || statusRaw === 0 || Boolean(err);
//
// failed OPEN: if `status` were missing or some other truthy encoding, the
// step silently read as a SUCCESS. For a screening tool that is the worst
// direction to be wrong in — an unparsed honeypot would come back clean.
// Success is now asserted positively (status === true / 1 / 'success'), a
// revert is asserted positively, and anything else is `indeterminate`:
// neither. Callers must surface indeterminate as "check did not run" rather
// than guessing — see anyIndeterminate() above and its use in
// tenderly-bundle-v3.js / v4.js.
function normalizeResult(r) {
  const txn = (r && (r.transaction || r.simulation)) || r || {};
  const statusRaw = txn.status !== undefined ? txn.status : r?.status;
  const explicitError =
    txn.error_message || r?.error_message || txn.revert_reason || r?.revert_reason ||
    txn.transaction_info?.error_message || null;

  // An explicit error message overrides a positive status — the original code
  // treated it as a revert and that behaviour is preserved deliberately: if
  // Tenderly bothers to name an error, believe the error, not the flag.
  const statusOk = statusRaw === true || statusRaw === 1 || statusRaw === 'success';
  const succeeded = statusOk && !explicitError;
  const failed = statusRaw === false || statusRaw === 0 || statusRaw === 'fail' || Boolean(explicitError);
  const indeterminate = !succeeded && !failed;

  const returnData =
    txn.transaction_info?.call_trace?.output ||
    r?.transaction_info?.call_trace?.output ||
    txn.call_trace?.output ||
    r?.call_trace?.output ||
    txn.output ||
    r?.output ||
    '0x';

  return {
    // `reverted` keeps its original meaning for existing call sites: "did not
    // succeed". Indeterminate counts as not-succeeded so nothing downstream
    // can mistake an unparsed step for a passing one — but `indeterminate`
    // rides alongside so callers can tell the two apart and report honestly.
    reverted: !succeeded,
    indeterminate,
    returnData,
    errorMessage: explicitError || (indeterminate
      ? `indeterminate step: no recognisable status in the Tenderly response (saw status=${JSON.stringify(statusRaw)})`
      : null),
    raw: r,
  };
}

// Native-ETH balance change for `address` caused by one bundle step.
//
// 2026-09-07: this is what makes a native-ETH round trip measurable. The v4
// module previously reported ratio: null / nativeProceedsUnmeasured: true for
// native-ETH pools because Tenderly's asset-change schema had never been seen
// — so a token could return 40% of your money and still print "OK".
//
// Verified against a real captured bundle: each step's
// transaction_info.balance_diff carries { address, original, dirty } and
// (dirty - original) is that STEP's own delta, not a running total — the buy
// step read exactly -0.05 ETH for a 0.05 ETH tx value, and the sell step
// +0.024705013 ETH. Note `original` is anchored to the pre-bundle balance
// rather than the running one, so only the difference is meaningful.
//
// Gas does not distort this: buildStep() sets gas_price '0'.
// Returns null when the address wasn't touched or the shape is missing, so
// the caller can fall back to reporting the proceeds as unmeasured.
function nativeBalanceDelta(result, address) {
  try {
    const raw = result?.raw;
    const txn = raw?.transaction || raw?.simulation || raw;
    const diffs = txn?.transaction_info?.balance_diff;
    if (!Array.isArray(diffs) || !address) return null;
    const want = address.toLowerCase();
    const entry = diffs.find((b) => b && !b.is_miner && String(b.address).toLowerCase() === want);
    if (!entry || entry.original == null || entry.dirty == null) return null;
    return ethers.BigNumber.from(String(entry.dirty)).sub(ethers.BigNumber.from(String(entry.original)));
  } catch (_) {
    return null;
  }
}

function formatStepError(result) {
  if (!result) return null;
  if (result.errorMessage) return result.errorMessage;
  if (result.raw) return JSON.stringify(result.raw).slice(0, 400);
  return 'unknown revert (no error detail in response)';
}

// Converts a human-decimal-scaled JS number (e.g. 2.9999999999999973 ETH,
// 690420689.9999999 tokens — exactly what measureBothSidesLiquidity() in
// token-screener-v3.js produces via formatUnits/division) back into a raw
// base-unit BigNumber, so it can be mixed with amountInWei (always raw wei)
// in integer xy=k math below. FIX (found via a live screening run whose
// JSONL showed roundTripChecked:true but every variant unsupported with
// "pool reserves unavailable" even though baseLiquidity/tokenLiquidity were
// right there and non-null): this function used to do
// `ethers.BigNumber.from(baseLiquidity.toString())` directly, which throws
// on any non-integer decimal string (near-guaranteed for ETH-denominated
// reserves) and was silently caught, always returning null. toFixed() caps
// fractional digits to what parseUnits(decimals) accepts — some sub-unit
// precision is lost in that round-trip, which is fine given this whole
// function is already a deliberately conservative estimate, not a precise
// quote (see safetyFraction below).
function toRawUnits(humanAmount, decimals) {
  if (!Number.isFinite(humanAmount)) throw new Error(`non-finite amount: ${humanAmount}`);
  // toFixed() falls back to exponential notation above ~1e21, which
  // parseUnits can't parse — real pool reserves never get remotely this
  // large, but guard explicitly rather than let parseUnits throw an opaque
  // "invalid decimal value" error instead.
  if (Math.abs(humanAmount) >= 1e21) throw new Error(`amount too large for fixed-point conversion: ${humanAmount}`);
  return ethers.utils.parseUnits(humanAmount.toFixed(decimals), decimals);
}

// Uniswap V4's dynamic-fee sentinel: the hook decides the real fee at swap
// time, so no static number is knowable here. See the fix note inside
// estimateConservativeSellAmount for what happened when this flowed through
// the fee arithmetic as if it were a fee.
const DYNAMIC_FEE_FLAG = 8388608; // 0x800000
const DYNAMIC_FEE_ASSUMED_PPM = 10000; // assume 1% for sizing — pessimistic on purpose

// Rough constant-product (x*y=k) estimate of what a sell would return, used
// ONLY to size a conservative (safetyFraction of that) sell amount that's
// safely within the wallet's real post-buy balance — NOT a precise quote.
// Uniswap v4 concentrated-liquidity pools don't literally behave like a
// simple xy=k pair across arbitrary size, which is exactly why this is
// deliberately conservative (safetyFraction default 0.5) rather than
// precise — see SELL_SAFETY_FRACTION in tenderly-bundle-v4.js.
// baseDecimals defaults to 18 (WETH/native ETH) — pass 6 explicitly for a
// USDG-based pool (see baseDecimals.USDG in token-screener-v3.js).
function estimateConservativeSellAmount({ baseLiquidity, tokenLiquidity, tokenDecimals, baseDecimals, amountInWei, feePpm, safetyFraction }) {
  if (baseLiquidity == null || tokenLiquidity == null || tokenDecimals == null) return null;
  try {
    const x = toRawUnits(baseLiquidity, baseDecimals ?? 18);
    const y = toRawUnits(tokenLiquidity, tokenDecimals);
    const dx = ethers.BigNumber.from(amountInWei.toString());
    if (x == null || y == null) return null;
    if (x.lte(0) || y.lte(0) || dx.lte(0)) return null;

    // Uniswap fee units: fee/1e6 = fraction (e.g. 3000 -> 0.3%).
    //
    // 2026-09-07 FIX (found on live data, token 0xd810D815E5…, a v4 pool with
    // fee 8388608): 8388608 (0x800000) is Uniswap V4's DYNAMIC-FEE FLAG, not a
    // fee. Fed through this arithmetic it gives feeFraction = 8.388,
    // feeMultiplierBps = -73886, a NEGATIVE dxAfterFee, and therefore a
    // negative sell amount — which ethers then rejected while encoding the
    // swap ("value out-of-bounds (argument=amountIn, value=-0x01ea40…)").
    // The screener reported that as `buy reverted`.
    //
    // The hook sets the real fee at swap time, so it cannot be known here.
    // Assume a pessimistic 1%: over-assuming the fee only makes the sell
    // smaller, which is the safe direction. Anything outside [0, 1e6) is
    // rejected outright rather than trusted.
    const rawFee = feePpm == null ? 0 : Number(feePpm);
    const effectiveFeePpm = rawFee === DYNAMIC_FEE_FLAG ? DYNAMIC_FEE_ASSUMED_PPM : rawFee;
    if (!Number.isFinite(effectiveFeePpm) || effectiveFeePpm < 0 || effectiveFeePpm >= 1e6) return null;
    const feeMultiplierBps = Math.round((1 - effectiveFeePpm / 1e6) * 10000);
    const dxAfterFee = dx.mul(feeMultiplierBps).div(10000);
    if (dxAfterFee.lte(0)) return null;

    const dy = y.mul(dxAfterFee).div(x.add(dxAfterFee)); // dy = y * dx' / (x + dx')
    if (dy.lte(0)) return null;

    const fraction = safetyFraction ?? 0.5;
    const safetyBps = Math.round(fraction * 10000);
    return dy.mul(safetyBps).div(10000);
  } catch (_) {
    return null;
  }
}

module.exports = {
  freshWallet,
  ethBalanceOverride,
  storageOverride,
  mergeStateObjects,
  setGlobalStateObjects,
  getGlobalStateObjects,
  withGlobalState,
  mappingSlot,
  buildStep,
  simulateBundle,
  simulateBundleOnce,
  erc20Iface,
  wethIface,
  MAX_UINT256,
  MAX_UINT160,
  estimateConservativeSellAmount,
  formatStepError,
  // 2026-09-07: was defined but NOT exported, so tenderly-bundle-v3/v4.js and
  // transferfrom-backdoor-check.js each destructured `undefined` and threw
  // "anyIndeterminate is not a function" on the first real bundle. The throw
  // was caught by the variant onError handler and reported as `buy reverted`,
  // which is a SEVERE concern — so it also wrote bad entries into
  // flagged-bytecode-templates.json. Missing exports fail at CALL time, not
  // require time, so a module-load smoke test cannot catch this; only a live
  // run does.
  anyIndeterminate,
  hoistBalanceOverrides,
  nativeBalanceDelta,
};
