// Lease Option Scout: student preview search
// Settings needed in Vercel:
//   STUDENT_PASSWORD      the password you give your students (different from your own test password)
//   PATMA_API_KEY         already set
// Optional settings:
//   STUDENT_END           last moment the preview works, default 2026-11-29T23:59:59Z (midnight UK time, Sunday 29 November)
//   STUDENT_DAILY_LIMIT   searches allowed per day for everyone together, default 25
// For an exact daily limit, connect a free Redis database (Vercel > Storage > Upstash) to this project.
// Without one, the limit is counted in memory, which is a rough guard rather than an exact count.

const { runSearch, readSearch, readBody } = require("./scout.js");

const DEFAULT_END = "2026-11-29T23:59:59Z";
const DEFAULT_LIMIT = 25;
const RADII = [0.5, 1];   // keep searches small: 1 or 2 PaTMa credits each
const MAX_PAGES = 2;
const MEMORY = {};   // used when no Redis database is connected

// Find the Redis connection Vercel added, whatever prefix it used
function redisConfig() {
  const env = process.env;
  const pick = (re) => { const k = Object.keys(env).find((n) => re.test(n) && env[n]); return k ? env[k] : null; };
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || pick(/(_REST_API_URL|REDIS_REST_URL)$/);
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || pick(/(_REST_API_TOKEN|REDIS_REST_TOKEN)$/);
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}
async function redis(cfg, parts) {
  const r = await fetch(cfg.url + "/" + parts.map(encodeURIComponent).join("/"), { headers: { Authorization: "Bearer " + cfg.token } });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Today's date in UK time, so the limit resets at midnight UK time
function ukDay(now) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("/").reverse().join("-");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use the student page to run a search." });

  const pw = process.env.STUDENT_PASSWORD;
  if (!pw) return res.status(503).json({ error: "The student preview isn't switched on yet." });
  const end = new Date(process.env.STUDENT_END || DEFAULT_END);
  const now = new Date();
  if (!isNaN(end) && now > end) return res.status(403).json({ error: "The student preview has now closed. Thanks for trying it. Barry will be in touch about founding member places." });

  const b = readBody(req);
  if (String(b.password || "").trim() !== pw) return res.status(401).json({ error: "That password isn't right. Check the one Barry sent you." });
  const q = readSearch(b, RADII);
  if (q.error) return res.status(400).json({ error: q.error });

  // Count today's searches: in the Redis database if one is connected, otherwise in memory (a rough guard)
  const cfg = redisConfig();
  const limit = Math.max(1, parseInt(process.env.STUDENT_DAILY_LIMIT, 10) || DEFAULT_LIMIT);
  const dayKey = "students:" + ukDay(now);
  const counter = {
    incr: async () => { if (cfg) { const n = await redis(cfg, ["incr", dayKey]); if (n === 1) await redis(cfg, ["expire", dayKey, "172800"]); return n; }
      MEMORY[dayKey] = (MEMORY[dayKey] || 0) + 1; return MEMORY[dayKey]; },
    decr: async () => { if (cfg) return redis(cfg, ["decr", dayKey]); MEMORY[dayKey] = Math.max(0, (MEMORY[dayKey] || 1) - 1); },
  };
  let used;
  try { used = await counter.incr(); }
  catch (e) { return res.status(503).json({ error: "The search counter didn't answer. Try again in a minute." }); }
  if (used > limit) {
    try { await counter.decr(); } catch (e) { /* not important */ }
    return res.status(429).json({ error: "Today's " + limit + " searches have all been used. Try again tomorrow." });
  }

  const out = await runSearch(Object.assign({}, q, { maxPages: MAX_PAGES }));
  const j = out.body || {};
  if (j.error) {
    // A failed search shouldn't count against the day
    try { await counter.decr(); } catch (e) { /* not important */ }
    return res.status(200).json({ error: "The search didn't work this time. Try again in a minute, or try another postcode." });
  }

  // Send students only what the page shows
  const homes = (j.homes || []).map((h) => ({
    address: h.address || null, place: h.street_label || null, postcode: h.postcode, url: h.url,
    type: h.type, beds: h.beds, tenure: h.tenure, asking: h.asking,
    days_on_market: h.days_on_market, price_cuts: h.price_cuts, relisted: h.relisted,
    signal: h.signal, agents: (h.listings || []).map((x) => ({ agent: x.agent, asking: x.asking })),
    from_epc: !!h.address_from_epc, from_title: !!h.address_from_title,
    possible: h.possible_addresses ? h.possible_addresses.map((p) => p.address) : null,
    status: h.status, non_standard_sale: !!h.non_standard_sale,
    last_sale: h.last_sale ? { price: h.last_sale.price, date: h.last_sale.date } : null,
    estimate: h.estimate ? {
      rating: h.estimate.rating, label: h.estimate.label, equity: h.estimate.equity, equity_pct: h.estimate.equity_pct,
      payment_now: h.estimate.payment_now, payment_next_fix: h.estimate.payment_next_fix,
    } : null,
  }));
  return res.status(200).json({
    search: j.search, counts: {
      homes: j.counts.homes, found: j.counts.found, rated: j.counts.rated,
      hot: j.counts.hot, warm: j.counts.warm, cold: j.counts.cold,
    },
    note: j.paging_note || null, land_registry_error: j.land_registry_error || null,
    searches_left_today: Math.max(0, limit - used), open_until: isNaN(end) ? null : end.toISOString(),
    homes,
  });
};

module.exports._test = { redisConfig, ukDay };
