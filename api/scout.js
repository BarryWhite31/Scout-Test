// Lease Option Scout: live search (PaTMa listings + Land Registry price paid + equity rating)
// Settings needed in Vercel: PATMA_API_KEY and SCOUT_TEST_PASSWORD

const PATMA = "https://app.patma.co.uk/api/prospector/v1/property-listing/";
const LR_SPARQL = "https://landregistry.data.gov.uk/landregistry/query";

// Typical 2-year fixed rate at ~90% loan to value, by year bought (same as the Lead Checker)
const RATE_BY_YEAR = { 2015: 3.3, 2016: 2.9, 2017: 2.5, 2018: 2.4, 2019: 2.4, 2020: 2.9, 2021: 2.6, 2022: 3.6, 2023: 5.8, 2024: 5.3, 2025: 4.9, 2026: 5.0 };
const RATE_DEFAULT = 5.0; // used for years not in the table
const RATE_NOW = 5.9;     // Moneyfacts average new mortgage rate, Nov 2026
const TERM_YEARS = 25;
const SELL_COSTS = 2;     // % of sale price

const PC_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/;

// ---------- small helpers ----------
const ABBR = { RD: "ROAD", AVE: "AVENUE", AV: "AVENUE", CL: "CLOSE", DR: "DRIVE", LN: "LANE", CRES: "CRESCENT", GDNS: "GARDENS", PL: "PLACE", SQ: "SQUARE", TER: "TERRACE", TERR: "TERRACE", CT: "COURT", GR: "GROVE", PDE: "PARADE" };
function norm(s) {
  return String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/[^A-Z0-9]+/g, " ").trim()
    .split(" ").map((w) => ABBR[w] || w).join(" ");
}
function monthsBetween(isoDate, now) {
  const d = new Date(isoDate);
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}
function payment(P, ratePct, months) { const r = ratePct / 100 / 12; return r === 0 ? P / months : P * r / (1 - Math.pow(1 + r, -months)); }
function balance(P, ratePct, termMonths, elapsed) {
  const r = ratePct / 100 / 12, pmt = payment(P, ratePct, termMonths);
  if (r === 0) return P - pmt * elapsed;
  return P * Math.pow(1 + r, elapsed) - pmt * (Math.pow(1 + r, elapsed) - 1) / r;
}
function rating(eqPct) {
  if (eqPct <= 0) return { cls: "hot", label: "Negative equity" };
  if (eqPct < 5) return { cls: "hot", label: "Close to negative equity" };
  if (eqPct < 15) return { cls: "warm", label: "Thin equity" };
  return { cls: "cold", label: "Healthy equity" };
}

// Equity estimate: deposit % of price paid, 25-year repayment from the purchase date, at that year's typical rate
function equity(asking, paid, saleDate, depositPct, now) {
  const year = new Date(saleDate).getFullYear();
  const rate = RATE_BY_YEAR[year] != null ? RATE_BY_YEAR[year] : RATE_DEFAULT;
  const termM = TERM_YEARS * 12;
  const elapsed = Math.max(0, Math.min(monthsBetween(saleDate, now), termM));
  const borrowed = paid * (1 - depositPct / 100);
  const owed = Math.max(0, balance(borrowed, rate, termM, elapsed));
  const net = asking * (1 - SELL_COSTS / 100);
  const eq = net - owed, eqIO = net - borrowed;
  const oldPmt = payment(borrowed, rate, termM);
  const newPmt = owed > 0 ? payment(owed, RATE_NOW, Math.max(12, termM - elapsed)) : 0;
  const r = rating(eq / asking * 100);
  return {
    rating: r.cls, label: r.label, rate_used: rate, rate_estimated: RATE_BY_YEAR[year] == null,
    borrowed: Math.round(borrowed), owed: Math.round(owed),
    equity: Math.round(eq), equity_pct: +(eq / asking * 100).toFixed(1),
    equity_interest_only: Math.round(eqIO), equity_interest_only_pct: +(eqIO / asking * 100).toFixed(1),
    payment_now: Math.round(oldPmt), payment_next_fix: Math.round(newPmt), months_owned: monthsBetween(saleDate, now)
  };
}

// ---------- Land Registry ----------
async function landRegistry(postcodes) {
  const out = {};
  for (let i = 0; i < postcodes.length; i += 40) {
    const chunk = postcodes.slice(i, i + 40);
    const values = chunk.map((p) => '"' + p + '"^^xsd:string').join(" ");
    const q = `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?postcode ?paon ?saon ?street ?amount ?date ?ptype ?estate ?newBuild ?category
WHERE {
  VALUES ?postcode { ${values} }
  ?addr lrcommon:postcode ?postcode .
  ?transx lrppi:propertyAddress ?addr ;
          lrppi:pricePaid ?amount ;
          lrppi:transactionDate ?date .
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
  OPTIONAL { ?transx lrppi:propertyType/skos:prefLabel ?ptype }
  OPTIONAL { ?transx lrppi:estateType/skos:prefLabel ?estate }
  OPTIONAL { ?transx lrppi:newBuild ?newBuild }
  OPTIONAL { ?transx lrppi:transactionCategory/skos:prefLabel ?category }
}`;
    const r = await fetch(LR_SPARQL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
      body: "query=" + encodeURIComponent(q),
    });
    if (!r.ok) throw new Error("Land Registry replied " + r.status);
    const j = await r.json();
    for (const b of j.results.bindings) {
      const v = (k) => (b[k] ? b[k].value : null);
      const pc = v("postcode");
      (out[pc] = out[pc] || []).push({
        paon: v("paon"), saon: v("saon"), street: v("street"), price: Math.round(+v("amount")), date: (v("date") || "").slice(0, 10),
        type: v("ptype"), estate: v("estate"), new_build: v("newBuild") === "true", category: v("category"),
      });
    }
  }
  return out;
}

// Find this listing's sales: exact address first, then same number in the same postcode if only one street matches
function matchSales(listing, sales) {
  if (!listing.address || !sales || !sales.length) return { sales: [], how: null };
  let line = listing.address;
  if (listing.postcode) line = line.replace(new RegExp(listing.postcode.replace(" ", "\\s*") + "\\s*$", "i"), "");
  const a = norm(line);
  const exact = sales.filter((s) => {
    const k1 = norm([s.saon, s.paon, s.street].filter(Boolean).join(" "));
    const k2 = s.saon ? null : norm([s.paon, s.street].filter(Boolean).join(" "));
    return [k1, k2].some((k) => k && (a === k || a.startsWith(k + " ")));
  });
  if (exact.length) return { sales: exact, how: "address" };
  const first = a.split(" ")[0];
  if (/^\d+[A-Z]?$/.test(first)) {
    const byNum = sales.filter((s) => !s.saon && norm(s.paon) === first);
    const streets = new Set(byNum.map((s) => norm(s.street)));
    if (byNum.length && streets.size === 1) return { sales: byNum, how: "number and postcode" };
  }
  return { sales: [], how: null };
}

// ---------- the search ----------
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use the test page to run a search." });
  const key = process.env.PATMA_API_KEY, pw = process.env.SCOUT_TEST_PASSWORD;
  if (!key || !pw) return res.status(500).json({ error: "PATMA_API_KEY or SCOUT_TEST_PASSWORD is missing in Vercel." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.password !== pw) return res.status(401).json({ error: "Wrong test password." });

  const postcode = String(b.postcode || "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!PC_RE.test(postcode)) return res.status(400).json({ error: "That doesn't look like a full UK postcode." });
  const radius = [0.25, 0.5, 1, 2, 3, 5].includes(+b.radius) ? +b.radius : 1;
  const deposit = [5, 10, 15, 25].includes(+b.deposit) ? +b.deposit : 10;
  const now = new Date();

  // 1. PaTMa: homes for sale (1 credit)
  const url = new URL(PATMA);
  Object.entries({ postcode, radius, include_auction: false, include_retirement: false, include_shared_ownership: false })
    .forEach(([k, v]) => url.searchParams.set(k, String(v)));
  let listings, pages, total;
  try {
    const r = await fetch(url, { headers: { Authorization: "Token " + key, Accept: "application/json" } });
    const j = await r.json();
    if (j.status !== "success") return res.status(200).json({ error: "PaTMa didn't return listings.", patma: j });
    listings = j.data.available_results || [];
    pages = j.data.number_of_pages; total = j.data.total_results_count;
  } catch (e) {
    return res.status(200).json({ error: "Couldn't reach PaTMa: " + e.message });
  }

  // 2. Land Registry: every sale in every postcode we found (free)
  const pcs = [...new Set(listings.map((l) => (l.postcode || "").toUpperCase()).filter((p) => PC_RE.test(p) && p.includes(" ")))];
  let lr = {}, lrError = null;
  try { lr = await landRegistry(pcs); } catch (e) { lrError = e.message; }

  // 3. Match and rate
  const homes = listings.map((l) => {
    const h = (l.price_history || []).slice().sort((x, y) => (x.date_created < y.date_created ? -1 : 1));
    const first = h.find((x) => x.new_asking_price != null);
    const cuts = h.filter((x) => x.old_asking_price != null && x.new_asking_price != null && x.new_asking_price < x.old_asking_price).length;
    const relisted = h.some((x) => x.old_available === false && x.new_available === true);
    const home = {
      address: l.address || null, street_label: l.label, postcode: l.postcode, uprn: l.uprn || null, url: l.url,
      type: l.property_type, beds: l.bedrooms, tenure: l.tenure, agent: l.agent_name, asking: l.asking_price,
      first_listed: first ? first.date_created : null, first_price: first ? first.new_asking_price : null,
      days_on_market: first ? Math.round((now - new Date(first.date_created)) / 86400000) : null,
      price_cuts: cuts, relisted, status: null, last_sale: null, earlier_sales: [], matched_by: null, estimate: null,
    };
    if (!l.address) { home.status = "no_house_number"; return home; }
    if (lrError) { home.status = "land_registry_unavailable"; return home; }
    const m = matchSales(l, lr[(l.postcode || "").toUpperCase()]);
    if (!m.sales.length) { home.status = "no_sale_found"; return home; }
    const sorted = m.sales.sort((x, y) => (x.date < y.date ? 1 : -1));
    home.last_sale = sorted[0];
    home.earlier_sales = sorted.slice(1).map((s) => ({ price: s.price, date: s.date }));
    home.matched_by = m.how;
    if (!l.asking_price) { home.status = "no_asking_price"; return home; }
    home.estimate = equity(l.asking_price, sorted[0].price, sorted[0].date, deposit, now);
    home.status = "rated";
    return home;
  });

  const order = { hot: 0, warm: 1, cold: 2 };
  homes.sort((x, y) => {
    if (x.estimate && y.estimate) return order[x.estimate.rating] - order[y.estimate.rating] || x.estimate.equity_pct - y.estimate.equity_pct;
    if (x.estimate) return -1; if (y.estimate) return 1; return 0;
  });
  const count = (f) => homes.filter(f).length;
  return res.status(200).json({
    search: { postcode, radius, deposit, run_at: now.toISOString() },
    counts: {
      found: total, returned: homes.length, more_pages: pages > 1,
      rated: count((h) => h.estimate), hot: count((h) => h.estimate && h.estimate.rating === "hot"),
      warm: count((h) => h.estimate && h.estimate.rating === "warm"), cold: count((h) => h.estimate && h.estimate.rating === "cold"),
      no_house_number: count((h) => h.status === "no_house_number"), no_sale_found: count((h) => h.status === "no_sale_found"),
    },
    land_registry_error: lrError,
    homes,
  });
};

module.exports._test = { norm, matchSales, equity, rating };
