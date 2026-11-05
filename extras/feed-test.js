// extras/feed-test.js — READ-ONLY test, 2026-11-03.
// Question: can the bot read a "recently verified contracts" feed from the explorer,
// so it can watch for published sources instead of re-asking about each token?
// Uses exactly the bot's own explorer route (source-gate.js): the Blockscout Pro API
// when BLOCKSCOUT_API_KEY is set, otherwise the explorer website via curl.
// Never prints the key. Changes nothing.
//
// Run on the server as the bot's user:
//   cd /home/botuser/bot-v3 && sudo -u botuser node extras/feed-test.js

process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config({ quiet: true });
const sg = require('./../source-gate');

const now = Math.floor(Date.now() / 1000);
const ago = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${Math.round((Date.now() - t) / 60000)} min ago` : '?';
};

async function get(url) {
  const H = sg.explorerHttp();
  const r = await H(url, { userAgent: sg.explorerUA(), attempts: 2 });
  if (r.json === undefined && r.body !== undefined) {
    // curl route returns the raw body; parse it like the bot does
    try { r.json = JSON.parse(r.body); } catch (_) { r.json = null; }
  }
  return r;
}

(async () => {
  console.log(`key in .env: ${process.env.BLOCKSCOUT_API_KEY ? 'yes' : 'NO'}`);
  console.log(`route: ${sg.usingProApi() ? 'Blockscout Pro API (api.blockscout.com)' : 'explorer website via curl'}`);
  console.log(`time now: ${new Date().toISOString()}\n`);

  // A. v2 list of verified contracts (the list the explorer's "Verified contracts" page shows)
  {
    const url = sg.explorerUrl('/smart-contracts');
    const r = await get(url);
    console.log(`A. v2 /smart-contracts -> HTTP ${r.status}${r.error ? ` (${sg.redact(r.error)})` : ''}`);
    const items = (r.json && r.json.items) || [];
    if (items.length) {
      items.slice(0, 10).forEach((i) => {
        const a = (i.address && i.address.hash) || i.address_hash || i.address;
        const n = (i.address && i.address.name) || i.name || '';
        console.log(`   ${i.verified_at || '(no verified_at)'}  ${ago(i.verified_at)}  ${a}  ${n}`);
      });
      const ts = items.map((i) => Date.parse(i.verified_at)).filter(Number.isFinite);
      const newestFirst = ts.every((t, k) => k === 0 || t <= ts[k - 1]);
      console.log(`   ${items.length} items; newest first: ${newestFirst ? 'YES' : 'no'}; next page: ${JSON.stringify(r.json.next_page_params)}`);
    } else if (r.json) {
      console.log(`   no items; keys: ${Object.keys(r.json).join(', ')}`);
    }
  }

  // B. old-style API: verified contracts in the last hour, filtered by verification time
  {
    const base = sg.explorerBase().replace(/\/v2\/?$/, '');
    let url = `${base}?module=contract&action=listcontracts&filter=verified&verified_at_start_timestamp=${now - 3600}&verified_at_end_timestamp=${now}&offset=100&page=1`;
    if (sg.usingProApi()) url += `&apikey=${encodeURIComponent(process.env.BLOCKSCOUT_API_KEY.trim())}`;
    const r = await get(url);
    console.log(`\nB. listcontracts (verified, last hour) -> HTTP ${r.status}${r.error ? ` (${sg.redact(r.error)})` : ''}`);
    const res = r.json && r.json.result;
    if (Array.isArray(res)) {
      console.log(`   ${res.length} contracts verified in the last hour; status ${r.json.status} ${r.json.message || ''}`);
      if (res[0]) console.log(`   fields: ${Object.keys(res[0]).join(', ')}`);
      res.slice(0, 5).forEach((x) => console.log(`   ${x.Address || x.address || ''}  ${x.ContractName || x.contract_name || ''}`));
    } else if (r.json) {
      console.log(`   answer: ${sg.redact(JSON.stringify(r.json).slice(0, 200))}`);
    }
  }

  const st = sg.explorerStats || {};
  console.log(`\nexplorer requests used: ${st.calls != null ? st.calls : '?'}`);
})().catch((e) => { console.error(sg.redact(String(e && e.stack || e))); process.exit(1); });
