// source-feed.js — the explorer's "recently verified contracts" list, read on a clock.
// Added 2026-11-05 (version 2026-11-05-source-feed).
//
// Why: a token that launches with its source hidden waits on the watcher's re-check
// list. Until now it was looked up again only at fixed times after launch, so a source
// published just after one look was found only at the next (up to 30 min later), and
// after 1 hour the token was given up for good. Source verification happens off-chain
// on the explorer: there is no chain event and no push alert. The fastest workable
// signal is Blockscout API v2 /smart-contracts, newest first: one request covers every
// waiting token, however many there are.
//
// Tested before use: extras/feed-shadow.js read this list every 60 s for 24 h beside
// the bot (3-4 Nov): 1,440 reads, all HTTP 200, no gaps, each new verification seen a
// median 31 s (max 86 s) after verified_at. The read logic below is the same as there.
//
// This module only says "these addresses were just verified". It never decides that a
// source is published: the watcher then runs the full source gate (source-gate.js,
// proxy-aware) on any waiting token that was named. A proxy whose implementation is
// still hidden therefore keeps waiting (e.g. PONS, 3 Nov: proxy verified, implementation
// never).
//
// Requests go through source-gate.js's explorer route, so they are counted in the
// watcher's hourly "[explorer]" line like every other explorer request.

const addrOf = (i) => (i && i.address && i.address.hash) || (i && i.address_hash)
  || (i && typeof i.address === 'string' ? i.address : null);
// One verified contract = one address + its verification time.
const keyOf = (i) => `${String(addrOf(i) || '').toLowerCase()}|${(i && i.verified_at) || ''}`;
const lc = (s) => String(s || '').toLowerCase();

// One read: page back from the newest entry until something already seen is reached.
// Pure apart from get(), so it can be tested offline. Same logic as feed-shadow.js.
//   get(params) -> { status, json, error }   (params = next_page_params, or null)
async function readNew(get, seen, { maxPages = 6, firstRun = false } = {}) {
  const fresh = [];
  let params = null;
  let pages = 0;
  let status = null;
  let error = null;
  let reachedSeen = false;
  while (pages < maxPages) {
    const r = await get(params);
    pages += 1;
    status = r.status;
    if (r.error || !r.json || !Array.isArray(r.json.items)) { error = r.error || `HTTP ${r.status}, no items`; break; }
    for (const item of r.json.items) {
      if (!addrOf(item)) continue;
      if (seen.has(keyOf(item))) { reachedSeen = true; continue; }
      fresh.push(item);
    }
    if (reachedSeen || firstRun || !r.json.next_page_params) break;
    params = r.json.next_page_params;
  }
  return { fresh, pages, status, error, reachedSeen };
}

// Every address an entry names: the contract itself and, for a proxy, its implementations.
function addressesOf(item) {
  const out = [];
  const a = addrOf(item);
  if (a) out.push(lc(a));
  const impls = item.implementations || (item.address && item.address.implementations) || [];
  for (const i of Array.isArray(impls) ? impls : []) {
    const x = typeof i === 'string' ? i : (i && (i.address_hash || i.address || i.hash));
    if (x) out.push(lc(x));
  }
  return out;
}

// makeFeed({ get, maxPages }) -> { poll, reset }
//   poll() -> { ok: true, hits: Set<address>, fresh, requests, gap }
//          or { ok: false, status, error, requests }
//   reset() forgets what was seen: the next poll reads only the newest page. The watcher
//          calls it when nothing is waiting, so no credits are spent on an empty list.
// The first poll after start or reset only marks the newest page as seen (its entries
// are not hits): anything verified before a token joined the list was already covered
// by that token's own source check.
function makeFeed({ get, maxPages = 6, maxSeen = 20000 } = {}) {
  let seen = new Set();
  let first = true;
  async function poll() {
    const res = await readNew(get, seen, { maxPages, firstRun: first });
    if (res.error) return { ok: false, status: res.status, error: res.error, requests: res.pages };
    const hits = new Set();
    for (const item of res.fresh) {
      seen.add(keyOf(item));
      if (!first) for (const a of addressesOf(item)) hits.add(a);
    }
    const gap = !first && !res.reachedSeen;
    first = false;
    if (seen.size > maxSeen) seen = new Set([...seen].slice(-Math.floor(maxSeen / 2))); // a Set keeps insertion order
    return { ok: true, hits, fresh: res.fresh.length, requests: res.pages, gap };
  }
  function reset() { seen = new Set(); first = true; }
  return { poll, reset };
}

// The real request function: Blockscout API v2 /smart-contracts through source-gate.js.
function explorerGetter() {
  const sg = require('./source-gate');
  const H = sg.explorerHttp();
  return (params) => {
    let p = '/smart-contracts';
    if (params) p += '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return H(sg.explorerUrl(p), { userAgent: sg.explorerUA(), attempts: 2 });
  };
}

module.exports = { makeFeed, readNew, addressesOf, keyOf, addrOf, explorerGetter };
