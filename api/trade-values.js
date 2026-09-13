// Proxies FantasyCalc's public trade-value market (api.fantasycalc.com), keyed by
// Sleeper player ID. Runs server-side so the frontend never talks to a third-party
// host directly (avoids CORS, keeps this swappable if FantasyCalc's shape changes).
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

  const isDynasty = req.query.isDynasty === "true" ? "true" : "false";
  const numQbs = /^[12]$/.test(req.query.numQbs) ? req.query.numQbs : "1";
  const numTeams = /^\d{1,2}$/.test(req.query.numTeams) ? req.query.numTeams : "12";
  const ppr = /^(0|0\.5|1)$/.test(req.query.ppr) ? req.query.ppr : "1";

  const url = `https://api.fantasycalc.com/values/current?isDynasty=${isDynasty}&numQBs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}`;

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FantasyCalc responded ${r.status}`);
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
    res.status(200).json({ values, count: Object.keys(values).length });
  } catch (err) {
    res.status(502).json({ error: "trade-values lookup failed", detail: String((err && err.message) || err) });
  }
};
