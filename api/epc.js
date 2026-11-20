// Lease Option Scout: EPC register test connector (runs on Vercel, keeps the EPC token private)
// Settings needed in Vercel: EPC_API_TOKEN and SCOUT_TEST_PASSWORD

const BASE = "https://api.get-energy-performance-data.communities.gov.uk";
const ALLOWED = /^\/api\/[a-z0-9\/_-]+$/i; // only the EPC API's own paths

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use the test page to send requests." });

  const token = process.env.EPC_API_TOKEN, pw = process.env.SCOUT_TEST_PASSWORD;
  if (!token || !pw) return res.status(500).json({ error: "EPC_API_TOKEN or SCOUT_TEST_PASSWORD is missing in Vercel's Environment Variables. Add it, then redeploy." });

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.password !== pw) return res.status(401).json({ error: "Wrong test password." });

  const path = String(b.path || "");
  if (!ALLOWED.test(path)) return res.status(400).json({ error: "That path isn't allowed. It must look like /api/domestic/search" });

  const url = new URL(BASE + path);
  const params = b.params && typeof b.params === "object" ? b.params : {};
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }

  try {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text.slice(0, 5000); }
    return res.status(200).json({ status: r.status, sent: { path: url.pathname + url.search }, data });
  } catch (err) {
    return res.status(200).json({ status: 0, error: "Couldn't reach the EPC register: " + err.message });
  }
};
