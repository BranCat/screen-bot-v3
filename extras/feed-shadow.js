// extras/feed-shadow.js — SHADOW TEST, READ-ONLY. Added 2026-11-03.
//
// Question: if the bot read the explorer's "recently verified contracts" feed every
// 60 s, would it learn about a published source sooner than its own re-checks do?
//
// This script only WATCHES the feed and writes down what it sees. It does not screen,
// does not touch the bot's files or settings, and does not change any verdict. The bot
// keeps running exactly as before. Afterwards, the log is compared with the bot's own
// launches.jsonl to see, token by token, how much earlier the feed knew.
//
// Uses the bot's own explorer route (source-gate.js: Blockscout Pro API with the key in
// .env). Its requests are NOT included in the bot's hourly "[explorer]" log line — they
// are counted in shadow/feed-shadow.log instead (about 60 an hour).
//
// Run on the server, as the bot's user, in the background:
//   cd /home/botuser/bot-v3
//   sudo -u botuser nohup node extras/feed-shadow.js > shadow-run.out 2>&1 &
// Options: --every 60 (seconds between reads)  --hours 24 (stops by itself)  --max-pages 6
// Stop early:  pkill -f feed-shadow.js
//
// Output (folder shadow/, created if missing):
//   feed-shadow.jsonl  one line per newly seen verified contract:
//                      seen_at (our clock), verified_at (explorer), address, name,
//                      proxy_type, implementations, page, cycle
//   feed-shadow.log    one line per read: time, pages, new entries, HTTP status, gap warnings

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : def;
};

function addrOf(i) {
  return (i && i.address && i.address.hash) || i.address_hash || (typeof i.address === 'string' ? i.address : null);
}
function nameOf(i) {
  return (i && i.address && i.address.name) || i.name || null;
}
// One verified contract = one address + its verification time.
const keyOf = (i) => `${String(addrOf(i) || '').toLowerCase()}|${i.verified_at || ''}`;

// Core of one read, kept free of I/O so it can be tested.
//   get(params) -> { status, json, error }   (params = next_page_params or null)
//   seen        Set of keys already written
//   returns { fresh: [ {item, page} ], pages, status, error, reachedSeen }
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
      fresh.push({ item, page: pages });
    }
    // Stop when this page reached something already known (the gap is closed),
    // on the first run (only the newest page is wanted as a starting point),
    // or when there is no further page.
    if (reachedSeen || firstRun || !r.json.next_page_params) break;
    params = r.json.next_page_params;
  }
  return { fresh, pages, status, error, reachedSeen };
}

function makeGetter() {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
  const sg = require(path.join(ROOT, 'source-gate'));
  const H = sg.explorerHttp();
  const get = (params) => {
    let p = '/smart-contracts';
    if (params) p += '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return H(sg.explorerUrl(p), { userAgent: sg.explorerUA(), attempts: 2 });
  };
  return { get, sg };
}

async function main() {
  const every = Math.max(15, arg('--every', 60));
  const hours = arg('--hours', 24);
  const maxPages = Math.max(1, arg('--max-pages', 6));
  const dir = path.join(ROOT, 'shadow');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'feed-shadow.jsonl');
  const logFile = path.join(dir, 'feed-shadow.log');
  const { get, sg } = makeGetter();
  const redact = (t) => sg.redact(String(t));
  const log = (s) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`);

  // Pick up where a previous run stopped (so a restart doesn't re-write old entries).
  const seen = new Set();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
      try { const o = JSON.parse(line); seen.add(`${String(o.address).toLowerCase()}|${o.verified_at || ''}`); } catch (_) { /* skip */ }
    }
  }
  const stopAt = Date.now() + hours * 3600e3;
  log(`start: every ${every}s for ${hours}h, max ${maxPages} pages per read, route ${sg.usingProApi() ? 'Pro API' : 'website/curl'}, ${seen.size} entries from before`);
  console.log(`feed shadow running: every ${every}s for ${hours}h. Log: shadow/feed-shadow.log`);

  let cycle = 0;
  let requests = 0;
  let pauseUntil = 0;
  let firstRun = seen.size === 0;
  const tick = async () => {
    if (Date.now() >= stopAt) { log(`stop: ${hours}h reached, ${cycle} reads, ${requests} requests, ${seen.size} entries`); process.exit(0); }
    if (Date.now() < pauseUntil) return;
    cycle += 1;
    const seenAt = new Date().toISOString();
    let res;
    try {
      res = await readNew(get, seen, { maxPages, firstRun });
    } catch (e) {
      log(`read ${cycle}: error ${redact(e.message || e)}`);
      return;
    }
    requests += res.pages;
    // Oldest first, so the file reads in time order.
    for (const { item, page } of res.fresh.reverse()) {
      seen.add(keyOf(item));
      const a = item.address || {};
      fs.appendFileSync(outFile, JSON.stringify({
        seen_at: seenAt,
        verified_at: item.verified_at || null,
        address: addrOf(item),
        name: nameOf(item),
        proxy_type: item.proxy_type || a.proxy_type || null,
        implementations: item.implementations || a.implementations || null,
        page,
        cycle,
      }) + '\n');
    }
    const gap = !firstRun && !res.reachedSeen && !res.error ? ' GAP: did not reach the last seen entry, raise --max-pages' : '';
    log(`read ${cycle}: HTTP ${res.status} pages ${res.pages} new ${res.fresh.length}${res.error ? ` ERROR ${redact(res.error)}` : ''}${gap}`);
    if (res.status === 402) { pauseUntil = Date.now() + 3600e3; log('HTTP 402: credits used up, pausing the shadow test for 1 h (the bot is not affected by this pause)'); }
    if (!res.error) firstRun = false;
  };
  await tick();
  let busy = false; // never two reads at once, even if one is slow
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch((e) => log(`tick error ${redact(e.message || e)}`)).finally(() => { busy = false; });
  }, every * 1000);
}

module.exports = { readNew, keyOf, addrOf };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
