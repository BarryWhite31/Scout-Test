// Lease Option Scout: find the house number of a listing from the EPC register
// Used by scout.js. Needs EPC_API_TOKEN in Vercel.

const EPC_BASE = "https://api.get-energy-performance-data.communities.gov.uk";
const MAX_CERT_FETCHES = 150;   // per search, to keep searches quick
const FALLBACK_MAX_CANDIDATES = 25;
const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

async function epcFetch(token, path, params) {
  const url = new URL(EPC_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000 * attempt);
    try {
      const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
      if (r.status === 404) return null; // no certificates
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) return null;
    } catch (e) { /* try again */ }
  }
  throw new Error("EPC register didn't answer");
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: e.message }; }
    }
  }));
  return out;
}

// What kind of home the listing says it is
function listingKind(type) {
  const t = String(type || "").toLowerCase();
  return {
    flat: /flat|apartment|maisonette|studio/.test(t),
    bungalow: /bungalow/.test(t),
    built: /semi/.test(t) ? "semi" : /terrace|town/.test(t) ? "terrace" : /detached/.test(t) ? "detached" : null,
  };
}
// What kind of home the EPC says it is
function epcKind(c) {
  const dt = String(c.dwelling_type || "").toLowerCase();
  const pt = c.property_type, bf = c.built_form;
  return {
    flat: /flat|maisonette/.test(dt) || pt === 2 || pt === 3,
    bungalow: /bungalow/.test(dt) || pt === 1,
    built: /semi/.test(dt) ? "semi" : /terrace/.test(dt) ? "terrace" : /detached/.test(dt) ? "detached"
      : bf === 1 ? "detached" : bf === 2 ? "semi" : [3, 4, 5, 6].includes(bf) ? "terrace" : null,
  };
}

// Rough floor area from the listing: a stated total, or the room sizes added up
function areaFromDescription(text) {
  const t = String(text || "");
  const ft = t.match(/([\d,]{3,6})\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i);
  if (ft) { const v = +ft[1].replace(/,/g, "") / 10.764; if (v > 25 && v < 1000) return { m2: Math.round(v), how: "stated" }; }
  const sm = t.match(/(\d{2,4}(?:\.\d+)?)\s*(?:sq\.?\s*m\b|m2\b|m²|square\s*met)/i);
  if (sm) { const v = +sm[1]; if (v > 25 && v < 1000) return { m2: Math.round(v), how: "stated" }; }
  const re = /(\d{1,2}(?:\.\d{1,2})?)\s*m\s*[x×]\s*(\d{1,2}(?:\.\d{1,2})?)\s*m\b/gi;
  let m, sum = 0, n = 0;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 70), m.index).toLowerCase();
    const lastLabel = before.split(/\n|\*\*/).filter((s) => s.trim()).pop() || "";
    if (/garage|garden|outside|patio|store|outbuilding|carport|driveway|workshop|shed/.test(lastLabel)) continue;
    sum += +m[1] * +m[2]; n++;
  }
  return n >= 3 ? { m2: Math.round(sum), how: "rooms added up" } : null;
}

function streetOf(label) {
  const first = String(label || "").split(",")[0];
  return first.replace(/^\s*\d+[a-z]?\s+/i, "").trim();
}

function score(listing, c, fresh, est) {
  let s = 0; const why = [];
  if (fresh) { s += 35; why.push("new EPC " + String(c.registration_date || "").slice(0, 10)); }
  if (c.transaction_type === 1) { s += 15; why.push("EPC done for a sale"); }
  if (!listing.new_home && c.assessment_type === "SAP" && fresh) { s -= 10; why.push("EPC is for a newly built home"); }
  const lk = listingKind(listing.type), ek = epcKind(c);
  if (lk.flat !== ek.flat) { s -= 40; why.push("flat/house mismatch"); }
  else if (lk.built && ek.built) {
    if (lk.built === ek.built) { s += 20; why.push((c.dwelling_type || ek.built) + " matches"); }
    else { s -= 25; why.push("type differs (" + (c.dwelling_type || ek.built) + ")"); }
  }
  if (lk.bungalow !== ek.bungalow && lk.built) { s -= 10; }
  const hab = c.habitable_room_count, beds = listing.beds;
  if (hab != null && beds != null) {
    const d = hab - beds;
    if (d >= 1 && d <= 3) { s += 15; why.push(hab + " rooms fits " + beds + " beds"); }
    else if (d === 0 || d === 4) { s += 3; }
    else { s -= 15; why.push(hab + " rooms vs " + beds + " beds"); }
  }
  if (est && c.total_floor_area) {
    const ratio = est.m2 / c.total_floor_area;
    if (ratio >= 0.78 && ratio <= 1.06) { s += 20; why.push(c.total_floor_area + " m² fits listing (~" + est.m2 + " m²)"); }
    else if (ratio >= 0.68 && ratio <= 1.18) { s += 8; }
    else { s -= 15; why.push(c.total_floor_area + " m² vs listing ~" + est.m2 + " m²"); }
  }
  return { s, why };
}

// homes: Scout's merged homes. Fills address/uprn on strong matches and possible_addresses on close calls.
async function matchByEpc(homes, token, now) {
  const need = homes.filter((h) => !h.address && /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(h.postcode || ""));
  const stats = { tried: need.length, matched: 0, possible: 0, cert_lookups: 0, error: null };
  if (!need.length) return stats;

  // 1. Every EPC in each postcode (one free request per postcode)
  const pcs = [...new Set(need.map((h) => h.postcode))];
  const searched = await pool(pcs, 6, (pc) => epcFetch(token, "/api/domestic/search", { postcode: pc, page_size: 5000 }));
  const byPc = {};
  pcs.forEach((pc, i) => {
    const r = searched[i];
    if (r && r.error) stats.error = r.error;
    byPc[pc] = (r && Array.isArray(r.data)) ? r.data : [];
  });

  // 2. Pick candidate certificates for each listing
  const certCache = {}, plans = [];
  for (const h of need) {
    const rows = byPc[h.postcode] || [];
    const street = normText(streetOf(h.street_label));
    let onStreet = rows.filter((r) => street && normText((r.addressLine1 || "") + " " + (r.addressLine2 || "")).includes(street));
    if (!onStreet.length) onStreet = rows;
    const listed = h.first_listed ? new Date(h.first_listed) : null;
    const from = listed ? listed.getTime() - 180 * DAY : 0, to = listed ? Math.min(now.getTime(), listed.getTime() + 90 * DAY) : 0;
    const latest = {}, freshRows = {};
    for (const r of onStreet) {
      const key = r.uprn || normText(r.addressLine1);
      const t = new Date(r.registrationDate).getTime();
      if (!latest[key] || t > new Date(latest[key].registrationDate).getTime()) latest[key] = r;
      if (listed && t >= from && t <= to && (!freshRows[key] || t > new Date(freshRows[key].registrationDate).getTime())) freshRows[key] = r;
    }
    const fresh = Object.values(freshRows).slice(0, 10).map((r) => ({ r, fresh: true }));
    let list = fresh;
    if (!fresh.length) {
      const all = Object.values(latest);
      list = all.length <= FALLBACK_MAX_CANDIDATES ? all.map((r) => ({ r, fresh: false })) : [];
    }
    plans.push({ h, list });
  }

  // 3. Open the full certificates we need (cached, capped)
  const wanted = [...new Set(plans.flatMap((p) => p.list.map((x) => x.r.certificateNumber)))].slice(0, MAX_CERT_FETCHES);
  const certs = await pool(wanted, 8, (num) => epcFetch(token, "/api/certificate", { certificate_number: num }));
  wanted.forEach((num, i) => { const c = certs[i]; if (c && c.data) certCache[num] = c.data; });
  stats.cert_lookups = wanted.length;

  // 4. Score and decide
  for (const { h, list } of plans) {
    const est = areaFromDescription(h.raw && h.raw.description_text);
    const listing = { type: h.type, beds: h.beds, new_home: h.raw && h.raw.new_home };
    const scored = list.map(({ r, fresh }) => {
      const c = certCache[r.certificateNumber];
      if (!c) return null;
      const { s, why } = score(listing, c, fresh, est);
      return { address: (c.address_line_1 || r.addressLine1 || "").replace(/,\s*$/, "").replace(/^(\d+[A-Z]?),\s*/i, "$1 "), uprn: String(c.uprn || r.uprn || ""), score: s, reasons: why, certificate: r.certificateNumber, floor_area: c.total_floor_area, rooms: c.habitable_room_count, type: c.dwelling_type };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    const top = scored[0], second = scored[1];
    if (top && top.score >= 60 && (!second || top.score - second.score >= 20)) {
      h.address = top.address + ", " + h.postcode;
      h.uprn = h.uprn || top.uprn;
      h.address_from_epc = true;
      h.epc_match = top;
      stats.matched++;
    } else {
      const poss = scored.filter((x) => x.score >= 30).slice(0, 3);
      if (poss.length) { h.possible_addresses = poss; stats.possible++; }
    }
  }
  return stats;
}

module.exports = { matchByEpc, _test: { areaFromDescription, listingKind, epcKind, score, streetOf } };
