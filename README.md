# Fantasy Football Dashboard

Mobile-friendly dashboard for Sleeper league `1328109892581462016`. Pure static site
(no build step, no framework) — fetches live from the public Sleeper API directly in
the browser and auto-refreshes every 60 seconds.

- **Matchups** tab — current week head-to-head scores
- **Standings** tab — full league standings (record, points for/against)
- **My Team** tab — your starters + bench + IR, with injury badges (Q/D/O/IR/etc.)
- **Injury alert banner** — flags any starter who's Questionable/Doubtful/Out/IR, visible on every tab
- **Start/Sit suggestions** — flags a bench player as a likely upgrade over the
  corresponding starter, based on recent scoring (avg of the last 3 completed weeks)
  and injury status. Sleeper's public API doesn't expose opponent/matchup-difficulty
  data, so that's *not* a factor here — the section says so.
- **Waiver wire targets** — Sleeper's trending adds (last 24h), filtered to players
  not already on any roster in your league, prioritized toward your thin positions.
  Informational only — Sleeper's public API is read-only, so there's no in-app "add"
  button; you'd make the actual waiver claim in the Sleeper app.
- First launch asks you to pick which team is yours from the league member list;
  it's saved on your device (`localStorage`), no login needed.

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
