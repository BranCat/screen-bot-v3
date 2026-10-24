// Offline tests for tenderly-client.js's override hoisting (2026-10-12).
//
//   node test-tenderly-client.js
//
// Passkeys' Gate 5b failed with "returned 6 result(s) for 11 step(s) … have 0
// want 0.05 ETH": the buy-leg bundle has five balance reads, THEN the buy that
// carries the wallet's ETH override, and Tenderly ignored the override on step
// 6. The fix copies every pure balance override onto step 1 as well. These
// checks prove what is actually POSTed, with axios stubbed — no network.

const axios = require('axios');
const { ethers } = require('ethers');

let SENT = null;
axios.post = async (url, body) => {
  SENT = body;
  return { data: { simulation_results: body.simulations.map(() => ({ transaction: { status: true, transaction_info: { call_trace: { output: '0x' } } } })) } };
};
process.env.TENDERLY_ACCESS_KEY = process.env.TENDERLY_ACCESS_KEY || 'test';
process.env.TENDERLY_ACCOUNT_SLUG = process.env.TENDERLY_ACCOUNT_SLUG || 'test';
process.env.TENDERLY_PROJECT_SLUG = process.env.TENDERLY_PROJECT_SLUG || 'test';

const c = require('./tenderly-client');

let failures = 0;
let passes = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passes += 1; } else { console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); failures += 1; }
};

const W = '0xf9608da73665f4884d7e85f0fd634ed06694c11b';
const TOKEN = '0x8b835b7e4fb7dca4abceeab613d39d0a392ef2dd';
const read = () => c.buildStep({ from: W, to: TOKEN, data: '0x70a08231' });
const buy = () => c.buildStep({ from: W, to: '0x8876789976decbfcbbbe364623c63652db8c0904', data: '0x3593564c', value: ethers.utils.parseEther('0.05'), stateObjects: c.ethBalanceOverride(W, ethers.utils.parseEther('0.055')) });

(async () => {
  console.log('\n1. the Passkeys buy-leg shape: 5 reads, buy with override, 5 reads');
  {
    const steps = [read(), read(), read(), read(), read(), buy(), read(), read(), read(), read(), read()];
    await c.simulateBundle(steps);
    const s = SENT.simulations;
    check('11 steps sent', s.length === 11);
    check('step 1 now funds the wallet', s[0].state_objects && s[0].state_objects[W] && s[0].state_objects[W].balance === ethers.utils.parseEther('0.055').toHexString(), JSON.stringify(s[0].state_objects));
    check('the buy keeps its own override', s[5].state_objects && s[5].state_objects[W].balance === ethers.utils.parseEther('0.055').toHexString());
    check('other steps untouched', !s[1].state_objects && !s[6].state_objects);
    check('the caller\'s step objects were not mutated', !steps[0].state_objects);
  }

  console.log('\n2. nothing to hoist');
  {
    const steps = [buy(), read(), read()];
    const out = c.hoistBalanceOverrides(steps);
    check('override already on step 1: same array back', out === steps);
    const plain = [read(), read()];
    check('no overrides at all: same array back', c.hoistBalanceOverrides(plain) === plain);
  }

  console.log('\n3. only balances move; step 1 wins conflicts; earliest later override wins');
  {
    const other = '0x00000000000000000000000000000000000000aa';
    const s0 = c.buildStep({ from: W, to: TOKEN, data: '0x', stateObjects: c.ethBalanceOverride(W, 7) });
    const s1 = c.buildStep({ from: W, to: TOKEN, data: '0x', stateObjects: c.mergeStateObjects(c.ethBalanceOverride(W, 99), c.ethBalanceOverride(other, 5), c.storageOverride(TOKEN, '0x01', '0x02')) });
    const s2 = c.buildStep({ from: W, to: TOKEN, data: '0x', stateObjects: c.ethBalanceOverride(other, 6) });
    const out = c.hoistBalanceOverrides([s0, s1, s2]);
    check('step 1\'s own balance wins', out[0].state_objects[W].balance === ethers.BigNumber.from(7).toHexString());
    check('another wallet\'s balance hoisted (earliest)', out[0].state_objects[other].balance === ethers.BigNumber.from(5).toHexString());
    check('storage override not hoisted', !out[0].state_objects[TOKEN]);
  }

  console.log(failures ? `\n${failures} check(s) FAILED (${passes} ok)` : `\nall checks passed (${passes})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
