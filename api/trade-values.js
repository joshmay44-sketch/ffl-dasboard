// Proxies FantasyCalc's public trade-value market (api.fantasycalc.com), keyed by
// Sleeper player ID. Runs server-side so the frontend never talks to a third-party
// host directly (avoids CORS, keeps this swappable if FantasyCalc's shape changes).
module.exports = async (req, res) => {
  const isDynasty = req.query.isDynasty === "true" ? "true" : "false";
  const numQbs = /^[12]$/.test(req.query.numQbs) ? req.query.numQbs : "1";
  const numTeams = /^\d{1,2}$/.test(req.query.numTeams) ? req.query.numTeams : "12";
  const ppr = /^(0|0\.5|1)$/.test(req.query.ppr) ? req.query.ppr : "1";

  // FantasyCalc's own current API docs (fantasycalc.com/api-docs) confirm the
  // required parameter is spelled "numQbs" (lowercase b) — this was
  // previously sent as "numQBs", which FantasyCalc's server apparently
  // treats as the required param being absent entirely, manifesting as a
  // 404 rather than a more conventional 400 on a missing required field.
  const url = `https://api.fantasycalc.com/values/current?isDynasty=${isDynasty}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let r;
    try {
      // Some public APIs quietly reject requests with no/generic User-Agent as
      // likely bot traffic — a serverless function's default fetch() UA looks
      // exactly like that. A normal browser-shaped UA plus Accept avoids that
      // without changing anything about what's actually being requested.
      r = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`FantasyCalc responded ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error("unexpected response shape from FantasyCalc");

    const values = {};
    for (const entry of data) {
      const sid = entry && entry.player && entry.player.sleeperId;
      if (!sid) continue;
      values[sid] = {
        name: entry.player.name,
        position: entry.player.position,
        value: entry.value,
        trend30Day: typeof entry.trend30Day === "number" ? entry.trend30Day : null,
      };
    }
    // Only a genuine success gets cached at the edge — this header was
    // previously set unconditionally at the top of the function, which meant
    // a single failed lookup could get cached for up to 30 minutes and keep
    // being served back even after the underlying bug was fixed and
    // redeployed, since the request URL (and so the cache key) never changed.
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ values, count: Object.keys(values).length });
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "trade-values lookup failed", detail: String((err && err.message) || err) });
  }
};
