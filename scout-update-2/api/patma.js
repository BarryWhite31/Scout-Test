// Lease Option Scout: PaTMa test connector (runs on Vercel, keeps the API key private)
// Settings needed in Vercel: PATMA_API_KEY and SCOUT_TEST_PASSWORD

const BASE = "https://app.patma.co.uk";
// Only PaTMa's property endpoints can be called through this page
const ALLOWED = /^\/api\/prospector\/v[0-9]+\/[a-z0-9-]+\/$/;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use the test page to send requests." });
  }

  const key = process.env.PATMA_API_KEY;
  const pw = process.env.SCOUT_TEST_PASSWORD;
  if (!key || !pw) {
    return res.status(500).json({ error: "PATMA_API_KEY or SCOUT_TEST_PASSWORD is missing in Vercel's Environment Variables. Add both, then redeploy." });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};

  if (b.password !== pw) {
    return res.status(401).json({ error: "Wrong test password." });
  }

  const path = String(b.path || "");
  if (!ALLOWED.test(path)) {
    return res.status(400).json({ error: "That path isn't allowed. It must look like /api/prospector/v1/property-listing/" });
  }

  const method = b.method === "POST" ? "POST" : "GET";
  const params = b.params && typeof b.params === "object" ? b.params : {};
  const url = new URL(BASE + path);
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v === "" || v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }
  }

  // PaTMa's docs show two header styles, so try "Token <key>" first, then the bare key
  const tries = [["Token prefix", "Token " + key], ["Bare key", key]];
  let result = null;
  for (const [label, auth] of tries) {
    try {
      const r = await fetch(url, {
        method,
        headers: Object.assign(
          { Authorization: auth, Accept: "application/json" },
          method === "POST" ? { "Content-Type": "application/json" } : {}
        ),
        body: method === "POST" ? JSON.stringify(params) : undefined,
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = text.slice(0, 5000); }
      result = { status: r.status, authFormat: label, sent: { method, path: url.pathname + url.search }, data };
      if (r.status !== 401 && r.status !== 403) break;
    } catch (err) {
      result = { status: 0, authFormat: label, error: "Couldn't reach PaTMa: " + err.message };
    }
  }
  return res.status(200).json(result);
};
