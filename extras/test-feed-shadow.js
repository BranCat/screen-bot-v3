// extras/test-feed-shadow.js — offline tests for feed-shadow.js (no network).
//   node extras/test-feed-shadow.js
const assert = require('assert');
const { readNew, keyOf } = require('./feed-shadow');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const it = (a, t) => ({ address: { hash: a, name: 'T' }, verified_at: t });

// A fake feed: 120 contracts, newest first, 50 per page.
const all = Array.from({ length: 120 }, (_, k) => it(`0x${String(120 - k).padStart(40, '0')}`, `2026-11-03T00:${String(59 - (k % 60)).padStart(2, '0')}:00Z`));
const feed = (list) => {
  let calls = 0;
  const get = async (params) => {
    calls += 1;
    const start = params ? params.start : 0;
    const items = list.slice(start, start + 50);
    return { status: 200, json: { items, next_page_params: start + 50 < list.length ? { start: start + 50 } : null }, error: null };
  };
  get.calls = () => calls;
  return get;
};

(async () => {
  // 1. First run reads only the newest page.
  {
    const g = feed(all); const seen = new Set();
    const r = await readNew(g, seen, { firstRun: true });
    ok(r.pages === 1 && r.fresh.length === 50, 'first run: one page, 50 entries');
  }
  // 2. Nothing new: stops on page 1, nothing fresh.
  {
    const g = feed(all); const seen = new Set(all.map(keyOf));
    const r = await readNew(g, seen, {});
    ok(r.pages === 1 && r.fresh.length === 0 && r.reachedSeen, 'no new: one page, nothing fresh');
  }
  // 3. 3 new on top: one page, exactly those 3.
  {
    const g = feed(all); const seen = new Set(all.slice(3).map(keyOf));
    const r = await readNew(g, seen, {});
    ok(r.pages === 1 && r.fresh.length === 3, '3 new: one page');
    ok(r.fresh[0].item === all[0], 'newest first in result');
  }
  // 4. 70 new (gap longer than a page): pages back until it meets a seen entry.
  {
    const g = feed(all); const seen = new Set(all.slice(70).map(keyOf));
    const r = await readNew(g, seen, {});
    ok(r.pages === 2 && r.fresh.length === 70 && r.reachedSeen, '70 new: two pages, gap closed');
  }
  // 5. Gap longer than max-pages: stops at the cap and says it did not reach seen.
  {
    const g = feed(all); const seen = new Set();
    const r = await readNew(g, seen, { maxPages: 2 });
    ok(r.pages === 2 && r.fresh.length === 100 && !r.reachedSeen, 'cap: stops at max pages, gap reported');
  }
  // 6. Error / Cloudflare page: no items, error reported, nothing fresh.
  {
    const g = async () => ({ status: 403, json: null, error: null });
    const r = await readNew(g, new Set(), {});
    ok(r.error && r.fresh.length === 0 && r.status === 403, 'HTTP 403: error, nothing fresh');
  }
  // 7. Same address verified again later counts as a new entry (new verified_at).
  {
    const twice = [it('0x' + 'a'.repeat(40), '2026-11-03T01:00:00Z'), it('0x' + 'a'.repeat(40), '2026-11-03T00:00:00Z')];
    const g = feed(twice); const seen = new Set([keyOf(twice[1])]);
    const r = await readNew(g, seen, {});
    ok(r.fresh.length === 1 && r.fresh[0].item.verified_at === '2026-11-03T01:00:00Z', 're-verification seen as new');
  }
  // 8. Address case does not matter for "seen".
  {
    const a = it('0xABCDEF' + '0'.repeat(34), 'x'); const b = it('0xabcdef' + '0'.repeat(34), 'x');
    ok(keyOf(a) === keyOf(b), 'key ignores address case');
  }
  console.log(`test-feed-shadow: ${n} checks passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
