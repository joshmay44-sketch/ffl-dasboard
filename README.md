# Fantasy Football Dashboard

Mobile-friendly dashboard for Sleeper league `1328109892581462016`. Pure static site
(no build step, no framework) — fetches live from the public Sleeper API directly in
the browser and auto-refreshes every 60 seconds.

Six tabs, each its own screen (no more everything stacked on one page):

- **Matchups** — current week head-to-head scores, plus a win % for each side —
  computed by converting the projected point gap into a probability using the
  normal distribution and your league's own real week-to-week scoring volatility
  (falls back to a labeled typical-volatility default only before enough weeks
  exist to measure it). Capped to 1–99%; it never claims certainty.
- **Power Rankings** — every team ranked by total projected starter points (same
  engine as Start/Sit), independent of actual win-loss record — a strength ranking,
  not the standings.
- **Standings** — full league standings (record, points for/against)
- **My Team** — your starters + bench + IR, with injury badges (Q/D/O/IR/etc.)
- **Start/Sit** — flags a bench player as a likely upgrade using each player's own
  scoring history (this season's games once they exist, otherwise that exact
  player's own last-season average — not a generic position average, which would
  blend in every backup who saw the field and understate real starters), blended
  with a defense-vs-position projection built from real box scores. Only a true
  rookie with zero track record anywhere falls back to the generic position
  average, since that's the only signal available for them. Every historical
  average is computed by taking each player's raw box-score stats (yards,
  receptions, TDs, sacks, points allowed, etc.) and running them through this
  league's *actual* `scoring_settings` — not Sleeper's generic `pts_ppr`/`pts_std`
  preset, which uses its own default bonus/bracket values and won't reflect any
  custom scoring (TE premium, yardage bonuses, custom points-allowed/FG-distance
  brackets, etc.) your league has configured. The Start/Sit status line reports
  how much of the available stat data actually matched your league's scoring keys
  (e.g. "offense custom-scoring matched 340/360"), so the coverage is verifiable
  rather than just asserted. Every projection also factors in that week's real
  matchup (opponent defense-vs-position, above) and Sleeper's own injury
  designation for the player: Questionable/Doubtful applies a genuine risk
  discount (15%/50%) to their own number rather than an automatic bench swap —
  so a still-elite Questionable starter isn't reflexively pulled for a much
  weaker healthy option — while Out/IR/Suspended/PUP zeroes the projection
  outright, since Sleeper itself expects zero snaps.
- **Waivers** — Sleeper's trending adds (last 24h), filtered to players not already
  on any roster in your league. A player is surfaced if they fill a thin roster
  spot **or** project (via the same engine above) to outscore your current
  weakest rostered player at that position — a real upgrade check, not just a
  numeric slot count — with the reason spelled out on each card. Also includes a
  **Defense & Kicker Streamers** section: every available DEF/K ranked purely by
  this week's matchup (not roster need), for weekly streaming, using the same
  league-accurate custom scoring. Informational only — Sleeper's API is read-only,
  so there's no in-app "add" button.
- **Trade Check** — pick players on each side of a proposed trade and compare total
  market value, pulled from **FantasyCalc** (a community trade-value tool keyed
  directly off Sleeper player IDs) — a genuinely different data source than Sleeper.

An injury alert banner (Q/D/O/IR starters) shows above the tabs on every screen.
First launch asks you to pick which team is yours from the league member list;
saved on your device (`localStorage`), no login needed.

## Serverless functions (`/api`)

Two small Vercel serverless functions back the non-Sleeper data. Both run
server-side (avoids CORS, keeps any future API key out of client code) and degrade
gracefully — the frontend shows "unavailable" for that one section rather than
breaking if either fails:

- **`/api/trade-values`** — proxies FantasyCalc's public values endpoint. Documented
  enough to be reasonably reliable.
- **`/api/matchup-difficulty`** — proxies ESPN's *undocumented* public scoreboard
  endpoint for each team's weekly opponent + that opponent's record. This is the
  one integration built against an API with no official contract — it's wrapped
  defensively, but if ESPN changes its response shape, this is the function to
  check first. It does **not** provide true defense-vs-position strength; that
  data isn't freely available anywhere reliable that a static/serverless app can
  reach without a paid subscription.

## Deploy to your Vercel account

This is a zero-config static site — Vercel needs no build command, just serve the
3 files as-is.

### Option A — GitHub + Vercel dashboard (recommended)

```bash
cd ffl-dashboard
git init -b main   # skip if already a git repo
git add index.html style.css app.js README.md
git commit -m "Fantasy football dashboard"
git remote add origin https://github.com/<your-username>/ffl-dashboard.git
git push -u origin main
```

1. Create the empty repo first at https://github.com/new (no README/license), then
   run the commands above with that repo's URL.
2. Go to https://vercel.com/new, import the repo. Framework preset: **Other**.
   Leave build command / output directory blank. Click **Deploy**.
3. Vercel gives you a `https://<project>.vercel.app` URL — bookmark it on your phone.

### Option B — Vercel CLI (no GitHub needed)

```bash
cd ffl-dashboard
npx vercel login
npx vercel --prod
```

Follow the prompts (link to your account, accept defaults). It prints the live URL
when done.

## Notes

- All Sleeper endpoints used are public and require no auth.
- The full player database (`/v1/players/nfl`) is ~5MB, so it's cached in
  `localStorage` for 12 hours instead of being refetched every cycle — per
  Sleeper's own API guidance not to hit that endpoint often. Matchups, rosters,
  and standings still refresh every 60 seconds.
- To change your team selection later, tap the gear icon in the top bar.
