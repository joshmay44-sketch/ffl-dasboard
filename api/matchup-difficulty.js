// Best-effort opponent lookup via ESPN's public (undocumented) scoreboard endpoint.
// This is the one integration in this project that isn't a documented, stable API —
// ESPN can change its response shape without notice. Every field access below is
// defensive; a shape mismatch degrades to an empty result instead of a 500, and the
// frontend treats an empty/error result as "not available" rather than failing.
//
// This does NOT provide true defense-vs-position strength — that data isn't freely
// available anywhere reliable. It reports each team's week opponent and that
// opponent's overall win-loss record as a simple, honest difficulty proxy.
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

  const week = parseInt(req.query.week, 10);
  const season = parseInt(req.query.season, 10);
  if (!week || !season) {
    res.status(400).json({ error: "week and season query params are required" });
    return;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&year=${season}`;

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
    const data = await r.json();

    const teams = {};
    for (const event of data.events || []) {
      try {
        const comp = event.competitions && event.competitions[0];
        const competitors = comp && comp.competitors;
        if (!competitors || competitors.length !== 2) continue;
        const [a, b] = competitors;
        const abbrA = a.team && a.team.abbreviation;
        const abbrB = b.team && b.team.abbreviation;
        if (!abbrA || !abbrB) continue;
        const recordOf = (side) => {
          const rec = side.records && (side.records.find((x) => x.type === "total") || side.records[0]);
          return rec ? rec.summary : null;
        };
        teams[abbrA] = { opponent: abbrB, opponentRecord: recordOf(b) };
        teams[abbrB] = { opponent: abbrA, opponentRecord: recordOf(a) };
      } catch (innerErr) { /* one malformed event shouldn't break the rest */ }
    }
    res.status(200).json({ teams, count: Object.keys(teams).length });
  } catch (err) {
    res.status(502).json({ error: "matchup-difficulty lookup failed", detail: String((err && err.message) || err) });
  }
};
