(() => {
  "use strict";

  const LEAGUE_ID = "1328109892581462016";
  const BASE = "https://api.sleeper.app/v1";
  const REFRESH_MS = 60000;
  const PLAYERS_CACHE_KEY = "ffl_players_cache_v1";
  const PLAYERS_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12h — Sleeper asks not to hammer /players/nfl
  const MY_USER_KEY = "ffl_my_user_id";

  const INJURY_CODES = {
    Questionable: "Q",
    Doubtful: "D",
    Out: "O",
    IR: "IR",
    PUP: "PUP",
    Suspended: "SUS",
    Sus: "SUS",
    NA: "NA",
    "COVID-19": "Q",
  };

  const HIST_CACHE_PREFIX = "ffl_hist_week_";
  const RECENT_WEEKS_BACK = 3;
  const START_SIT_MARGIN = 2; // points of edge before flagging a bench upgrade
  const INJURY_FLAGS = ["Questionable", "Doubtful", "Out", "IR", "Suspended", "Sus", "PUP"];

  const DATA = {
    league: null,
    users: [],
    rosters: [],
    matchups: [],
    players: {},
    week: 1,
    myUserId: localStorage.getItem(MY_USER_KEY) || null,
    trending: [],
    recentPerf: {},
    matchupDiff: {},
    matchupDiffFailed: false,
    tradeValues: {},
    tradeValuesLoaded: false,
    tradeValuesFailed: false,
    trade: { give: [], get: [] },
    tradePickerTarget: null,
    dvp: {},
    dvpSource: null,
    dvpFailed: false,
    scoreStdDev: null,
    scoreStdDevSource: null,
  };
  const DEFAULT_SCORE_STDDEV = 22; // points — typical weekly fantasy lineup volatility, used only until real season data exists

  const MATCHUP_DIFF_CACHE_PREFIX = "ffl_matchupdiff_v1_";
  const TRADE_VALUES_CACHE_KEY = "ffl_trade_values_v1";
  const TRADE_VALUES_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const DVP_CACHE_PREFIX = "ffl_dvp_v2_";
  const DVP_MAX_AGE_MS = 20 * 60 * 60 * 1000; // recompute roughly once a day
  const DVP_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
  // Streaming-relevant positions: for these, Sleeper's precomputed point fields
  // use its own standard scoring for points-allowed/FG-distance brackets, which
  // may not exactly match a league's custom bracket values — lower confidence
  // than the skill-position numbers above.
  const STREAM_POSITIONS = ["DEF", "K"];
  const PROJECTION_BLEND = 0.6; // weight on a player's own recent scoring vs. opponent DVP baseline

  const el = (id) => document.getElementById(id);
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sleeper API ${res.status} on ${url.replace(BASE, "")}`);
    return res.json();
  }

  async function ensurePlayers() {
    try {
      const raw = localStorage.getItem(PLAYERS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < PLAYERS_MAX_AGE_MS && parsed.data) {
          DATA.players = parsed.data;
          return;
        }
      }
    } catch (e) { /* corrupt cache, refetch */ }

    const full = await fetchJSON(`${BASE}/players/nfl`);
    const trimmed = {};
    for (const id in full) {
      const p = full[id];
      if (!p) continue;
      trimmed[id] = {
        n: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim() || id,
        p: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || "",
        t: p.team || "FA",
        i: p.injury_status || null,
      };
    }
    DATA.players = trimmed;
    try {
      localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: trimmed }));
    } catch (e) { /* storage quota — fine, stays in memory for this session */ }
  }

  function histCacheKey(week) {
    return `${HIST_CACHE_PREFIX}${LEAGUE_ID}_${week}`;
  }

  // Completed weeks never change, so they're cached indefinitely once fetched;
  // only the current (in-progress) week is fetched fresh every cycle.
  async function getWeekMatchups(week, cacheable) {
    if (cacheable) {
      try {
        const raw = localStorage.getItem(histCacheKey(week));
        if (raw) return JSON.parse(raw);
      } catch (e) { /* corrupt cache, refetch */ }
    }
    const data = await fetchJSON(`${BASE}/league/${LEAGUE_ID}/matchups/${week}`);
    if (cacheable) {
      try { localStorage.setItem(histCacheKey(week), JSON.stringify(data)); } catch (e) { /* quota — fine */ }
    }
    return data;
  }

  // Average fantasy points per player over the last few completed weeks, league-wide
  // (every roster's players_points for that week, not just one roster) — so Power
  // Rankings and any cross-team comparison get real recent-form data for every
  // player, not just the ones on your own roster.
  async function computeRecentPerformance(currentWeek) {
    const perPlayer = {};
    for (let w = currentWeek - 1; w >= Math.max(1, currentWeek - RECENT_WEEKS_BACK); w--) {
      try {
        const wk = await getWeekMatchups(w, true);
        wk.forEach((entry) => {
          if (!entry.players_points) return;
          for (const pid in entry.players_points) {
            const pts = entry.players_points[pid];
            if (pts === null || pts === undefined) continue;
            if (!perPlayer[pid]) perPlayer[pid] = { sum: 0, n: 0 };
            perPlayer[pid].sum += pts;
            perPlayer[pid].n += 1;
          }
        });
      } catch (e) { /* week not available — skip it */ }
    }
    return perPlayer;
  }
  function avgPts(perPlayerMap, pid) {
    const e = perPlayerMap[pid];
    if (!e || !e.n) return null;
    return e.sum / e.n;
  }

  // Real week-to-week volatility of each team's actual scores this season, pooled
  // across rosters (more stable early in the season than any single team's own
  // sample). Falls back to a labeled default only when there isn't enough season
  // data yet to measure it — never silently substitutes a guess for a real number.
  async function computeScoreStdDev(currentWeek) {
    const perRoster = {}; // roster_id -> [scores]
    for (let w = 1; w < currentWeek; w++) {
      try {
        const wk = await getWeekMatchups(w, true);
        wk.forEach((entry) => {
          if (typeof entry.points !== "number") return;
          if (!perRoster[entry.roster_id]) perRoster[entry.roster_id] = [];
          perRoster[entry.roster_id].push(entry.points);
        });
      } catch (e) { /* week not available — skip it */ }
    }
    const variances = [];
    Object.values(perRoster).forEach((scores) => {
      if (scores.length < 2) return;
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length - 1);
      variances.push(variance);
    });
    if (!variances.length) return { stdDev: DEFAULT_SCORE_STDDEV, source: "a typical-volatility default (not enough completed weeks yet to measure your league's actual variance)" };
    const pooled = variances.reduce((a, b) => a + b, 0) / variances.length;
    return { stdDev: Math.sqrt(pooled), source: `your league's actual week-to-week scoring variance through week ${currentWeek - 1}` };
  }

  // Standard normal CDF (Abramowitz & Stegun approximation, ~7.5e-8 max error) —
  // converts a projected point gap into a win probability. No external library,
  // no borrowed opinion — just the standard statistical conversion.
  function normalCDF(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    if (z > 0) prob = 1 - prob;
    return prob;
  }

  function winProbability(projA, projB) {
    const sigma = DATA.scoreStdDev || DEFAULT_SCORE_STDDEV;
    const spread = Math.sqrt(2) * sigma; // assumes similar volatility for both teams
    const z = (projB - projA) / spread;
    const prob = normalCDF(-z); // P(A's score > B's score)
    // Never claim certainty — real games have upset potential beyond what score
    // variance alone captures (injuries mid-game, model error, etc).
    return Math.min(0.99, Math.max(0.01, prob));
  }

  function teamProjectedTotal(roster) {
    return (roster.starters || [])
      .filter((pid) => pid && pid !== "0")
      .reduce((sum, pid) => sum + (projectPoints(pid) || 0), 0);
  }

  function flexEligibility(slotLabel) {
    const s = (slotLabel || "").toUpperCase();
    if (s.includes("SUPER_FLEX") || s === "SUPERFLEX") return ["QB", "RB", "WR", "TE"];
    if (s.includes("FLEX")) return ["RB", "WR", "TE"];
    if (s === "QB" || s === "RB" || s === "WR" || s === "TE" || s === "K" || s === "DEF") return [s];
    return s ? [s] : [];
  }

  // Best-effort opponent-strength lookup (see api/matchup-difficulty.js for caveats).
  // Cached per week since it doesn't change once the week's schedule is set.
  async function loadMatchupDiff(week, season) {
    const cacheKey = `${MATCHUP_DIFF_CACHE_PREFIX}${season}_${week}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        DATA.matchupDiff = JSON.parse(raw);
        DATA.matchupDiffFailed = false;
        return;
      }
    } catch (e) { /* corrupt cache, refetch */ }
    try {
      const res = await fetch(`/api/matchup-difficulty?week=${week}&season=${season}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      DATA.matchupDiff = json.teams || {};
      DATA.matchupDiffFailed = false;
      try { localStorage.setItem(cacheKey, JSON.stringify(DATA.matchupDiff)); } catch (e) { /* quota — fine */ }
    } catch (e) {
      DATA.matchupDiff = {};
      DATA.matchupDiffFailed = true;
    }
  }

  function opponentInfoFor(playerId) {
    const p = DATA.players[playerId];
    if (!p || !p.t || !DATA.matchupDiff[p.t]) return null;
    return DATA.matchupDiff[p.t];
  }

  // Which of Sleeper's precomputed point fields matches this league's scoring.
  function scoringField() {
    const rec = (DATA.league && DATA.league.scoring_settings && DATA.league.scoring_settings.rec) || 0;
    if (rec >= 1) return "pts_ppr";
    if (rec >= 0.5) return "pts_half_ppr";
    return "pts_std";
  }
  function pointsFromStatLine(line, field) {
    if (!line) return null;
    const v = line[field] ?? line.pts_ppr ?? line.pts_half_ppr ?? line.pts_std;
    return typeof v === "number" ? v : null;
  }

  // Real box-score stats for every NFL player in a given week (not just this league's rosters).
  async function fetchWeekStats(season, week) {
    try {
      return await fetchJSON(`${BASE}/stats/nfl/regular/${season}/${week}`);
    } catch (e) {
      return null;
    }
  }
  // Reuses the same opponent-lookup endpoint built for Start/Sit, for an arbitrary past week.
  async function fetchWeekSchedule(season, week) {
    try {
      const res = await fetch(`/api/matchup-difficulty?week=${week}&season=${season}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.teams || null;
    } catch (e) {
      return null;
    }
  }

  // Defense-vs-position: for each real game in the given weeks, attributes the
  // fantasy points a player scored to their opponent's defense at that position.
  // Built entirely from real results — no rankings or opinions borrowed from anyone.
  async function computeDVPForRange(season, weeks) {
    const field = scoringField();
    const table = {}; // opponent team -> position -> { sum, n }
    const weekResults = await Promise.all(
      weeks.map((w) => Promise.all([fetchWeekStats(season, w), fetchWeekSchedule(season, w)]))
    );
    for (const [stats, schedule] of weekResults) {
      if (!stats || !schedule) continue;
      for (const pid in stats) {
        const p = DATA.players[pid];
        if (!p || !p.t || !DVP_POSITIONS.includes(p.p)) continue;
        const oppInfo = schedule[p.t];
        if (!oppInfo) continue;
        const pts = pointsFromStatLine(stats[pid], field);
        if (pts === null) continue;
        const opp = oppInfo.opponent;
        if (!table[opp]) table[opp] = {};
        if (!table[opp][p.p]) table[opp][p.p] = { sum: 0, n: 0 };
        table[opp][p.p].sum += pts;
        table[opp][p.p].n += 1;
      }
    }
    const avg = {};
    for (const team in table) {
      avg[team] = {};
      for (const pos in table[team]) avg[team][pos] = table[team][pos].sum / table[team][pos].n;
    }
    return avg;
  }

  async function ensureDVP() {
    const week = DATA.week;
    const season = DATA.league.season;
    const usePrevious = week <= 1;
    const cacheKey = usePrevious ? `${DVP_CACHE_PREFIX}prev_${season}` : `${DVP_CACHE_PREFIX}${season}_${week}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < DVP_MAX_AGE_MS) {
          DATA.dvp = parsed.data;
          DATA.dvpSource = parsed.source;
          DATA.dvpFailed = false;
          return;
        }
      }
    } catch (e) { /* corrupt cache, recompute */ }

    try {
      let table, source;
      if (usePrevious) {
        const prevSeason = String(Number(season) - 1);
        table = await computeDVPForRange(prevSeason, Array.from({ length: 18 }, (_, i) => i + 1));
        source = `${prevSeason} season (no completed ${season} weeks yet)`;
      } else {
        table = await computeDVPForRange(season, Array.from({ length: week - 1 }, (_, i) => i + 1));
        source = `${season}, weeks 1–${week - 1}`;
      }
      if (!Object.keys(table).length) throw new Error("empty DVP table");
      DATA.dvp = table;
      DATA.dvpSource = source;
      DATA.dvpFailed = false;
      try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: table, source })); } catch (e) { /* quota — fine */ }
    } catch (e) {
      DATA.dvp = {};
      DATA.dvpSource = null;
      DATA.dvpFailed = true;
    }
  }

  // Blends a player's own recent scoring with their opponent's defense-vs-position
  // baseline. A player with no personal history (rookie, new pickup) falls back
  // entirely to the DVP number, so there's still a real, data-grounded estimate.
  function projectPoints(playerId) {
    const p = DATA.players[playerId];
    if (!p) return null;
    const recentAvg = avgPts(DATA.recentPerf, playerId);
    const oppInfo = opponentInfoFor(playerId);
    const dvpAvg = oppInfo && DATA.dvp[oppInfo.opponent] ? DATA.dvp[oppInfo.opponent][p.p] : undefined;
    if (recentAvg !== null && dvpAvg !== undefined) return recentAvg * PROJECTION_BLEND + dvpAvg * (1 - PROJECTION_BLEND);
    if (recentAvg !== null) return recentAvg;
    if (dvpAvg !== undefined) return dvpAvg;
    return null;
  }

  function leagueTradeParams() {
    const rec = (DATA.league && DATA.league.scoring_settings && DATA.league.scoring_settings.rec) || 0;
    const ppr = rec >= 1 ? "1" : rec >= 0.5 ? "0.5" : "0";
    const numTeams = String(DATA.rosters.length || 12);
    const slots = (DATA.league && DATA.league.roster_positions) || [];
    const numQbs = slots.includes("SUPER_FLEX") ? "2" : "1";
    const isDynasty = DATA.league && DATA.league.settings && DATA.league.settings.type === 2 ? "true" : "false";
    return { ppr, numTeams, numQbs, isDynasty };
  }

  async function loadTradeValues() {
    const statusEl = el("trade-status");
    try {
      const raw = localStorage.getItem(TRADE_VALUES_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < TRADE_VALUES_MAX_AGE_MS && parsed.data) {
          DATA.tradeValues = parsed.data;
          DATA.tradeValuesLoaded = true;
          renderTradeCheck();
          return;
        }
      }
    } catch (e) { /* corrupt cache, refetch */ }

    statusEl.hidden = false;
    statusEl.textContent = "Loading trade values…";
    try {
      const { ppr, numTeams, numQbs, isDynasty } = leagueTradeParams();
      const res = await fetch(`/api/trade-values?ppr=${ppr}&numTeams=${numTeams}&numQbs=${numQbs}&isDynasty=${isDynasty}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = await res.json();
      DATA.tradeValues = json.values || {};
      DATA.tradeValuesLoaded = true;
      DATA.tradeValuesFailed = false;
      try { localStorage.setItem(TRADE_VALUES_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: DATA.tradeValues })); } catch (e) { /* quota — fine */ }
      statusEl.hidden = true;
    } catch (e) {
      DATA.tradeValuesFailed = true;
      DATA.tradeValuesLoaded = true;
      statusEl.hidden = false;
      statusEl.textContent = "Trade values are unavailable right now (FantasyCalc lookup failed). Try again later.";
    }
    renderTradeCheck();
  }

  function userFor(userId) {
    return DATA.users.find((u) => u.user_id === userId) || null;
  }
  function teamNameFor(userId) {
    const u = userFor(userId);
    if (!u) return "Unknown Team";
    return (u.metadata && u.metadata.team_name) || u.display_name || "Unnamed Team";
  }
  function avatarUrl(avatarId) {
    return avatarId ? `https://sleepercdn.com/avatars/thumbs/${avatarId}` : "";
  }
  function rosterForUser(userId) {
    return DATA.rosters.find((r) => r.owner_id === userId || (r.co_owners || []).includes(userId)) || null;
  }
  function matchupFor(rosterId) {
    return DATA.matchups.find((m) => m.roster_id === rosterId) || null;
  }
  function ptsFor(matchup, playerId, idx) {
    if (!matchup) return null;
    if (matchup.players_points && playerId in matchup.players_points) return matchup.players_points[playerId];
    if (matchup.starters_points && typeof idx === "number") return matchup.starters_points[idx];
    return null;
  }
  function fmtPts(n) {
    return n === null || n === undefined ? "-" : Number(n).toFixed(1);
  }
  function injuryBadge(status) {
    if (!status) return "";
    const code = INJURY_CODES[status] || status.slice(0, 3).toUpperCase();
    return `<span class="badge badge-${code}">${code}</span>`;
  }

  function playerCardHtml(playerId, slotLabel, matchup, idx) {
    if (!playerId || playerId === "0") {
      return `<div class="player-card">
        <div class="player-slot">${escapeHtml(slotLabel || "")}</div>
        <div class="player-info"><div class="player-name" style="color:var(--text-dim)">Empty</div></div>
      </div>`;
    }
    const p = DATA.players[playerId] || { n: playerId, p: "", t: "", i: null };
    const pts = ptsFor(matchup, playerId, idx);
    const img =
      p.p === "DEF"
        ? ""
        : `<img class="player-avatar" alt="" loading="lazy" src="https://sleepercdn.com/content/nfl/players/thumb/${playerId}.jpg" onerror="this.style.visibility='hidden'" />`;
    return `<div class="player-card">
      <div class="player-slot">${escapeHtml(slotLabel || p.p || "")}</div>
      ${img || `<div class="player-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml(p.t || "")}</div>`}
      <div class="player-info">
        <div class="player-name-row">
          <span class="player-name">${escapeHtml(p.n)}</span>
          ${injuryBadge(p.i)}
        </div>
        <div class="player-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}</div>
      </div>
      <div class="player-points">${fmtPts(pts)}</div>
    </div>`;
  }

  function renderTopbar() {
    const lg = DATA.league;
    if (!lg) return;
    el("league-name").textContent = lg.name || "League";
    el("league-sub").textContent = `Week ${DATA.week} · ${lg.season || ""}`;
    const avEl = el("league-avatar");
    const url = avatarUrl(lg.avatar);
    if (url) {
      avEl.src = url;
      avEl.hidden = false;
    } else {
      avEl.hidden = true;
    }
  }

  function renderMatchups() {
    const stdDevStatus = el("stddev-status");
    if (stdDevStatus) {
      if (DATA.scoreStdDevSource) {
        stdDevStatus.hidden = false;
        stdDevStatus.textContent = `Win % is based on ${DATA.scoreStdDevSource}.`;
      } else {
        stdDevStatus.hidden = true;
      }
    }
    const groups = new Map();
    for (const m of DATA.matchups) {
      const key = m.matchup_id ?? `solo-${m.roster_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const myRoster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    const entries = [...groups.values()];
    entries.sort((a, b) => {
      const aMine = myRoster && a.some((m) => m.roster_id === myRoster.roster_id) ? 0 : 1;
      const bMine = myRoster && b.some((m) => m.roster_id === myRoster.roster_id) ? 0 : 1;
      return aMine - bMine;
    });

    if (!entries.length) {
      el("matchups-list").innerHTML = `<div class="empty-state">No matchups found for week ${DATA.week} yet.</div>`;
      return;
    }

    el("matchups-list").innerHTML = entries
      .map((group) => {
        if (group.length < 2) {
          const m = group[0];
          const roster = DATA.rosters.find((r) => r.roster_id === m.roster_id);
          const name = roster ? teamNameFor(roster.owner_id) : "Team";
          return `<div class="matchup-card"><div class="matchup-bye">${escapeHtml(name)} — Bye this week</div></div>`;
        }
        const [a, b] = group;
        const rosterA = DATA.rosters.find((r) => r.roster_id === a.roster_id);
        const rosterB = DATA.rosters.find((r) => r.roster_id === b.roster_id);
        const projA = rosterA ? teamProjectedTotal(rosterA) : null;
        const projB = rosterB ? teamProjectedTotal(rosterB) : null;
        const probA = projA !== null && projB !== null ? winProbability(projA, projB) : null;

        const rows = [a, b].map((m) => {
          const roster = DATA.rosters.find((r) => r.roster_id === m.roster_id);
          const isMe = myRoster && roster && roster.roster_id === myRoster.roster_id;
          const user = roster ? userFor(roster.owner_id) : null;
          const name = roster ? teamNameFor(roster.owner_id) : "Team";
          const other = group.find((x) => x !== m);
          const winning = (m.points || 0) > (other.points || 0) && (m.points || 0) > 0;
          const av = user ? avatarUrl(user.avatar) : "";
          const prob = probA === null ? null : m === a ? probA : 1 - probA;
          return `<div class="matchup-row">
            ${av ? `<img class="matchup-avatar" alt="" src="${av}" />` : `<div class="matchup-avatar"></div>`}
            <div class="matchup-team">
              <div class="matchup-team-name">${escapeHtml(name)}${isMe ? " (You)" : ""}</div>
              <div class="matchup-team-meta">${roster ? `${roster.settings.wins}-${roster.settings.losses}${roster.settings.ties ? "-" + roster.settings.ties : ""}` : ""}${prob !== null ? ` · ${Math.round(prob * 100)}% to win` : ""}</div>
            </div>
            <div class="matchup-score${winning ? " winning" : ""}">${(m.points || 0).toFixed(2)}</div>
          </div>`;
        });
        return `<div class="matchup-card">${rows[0]}<div class="matchup-divider"></div>${rows[1]}</div>`;
      })
      .join("");
  }

  function renderStandings() {
    const sorted = [...DATA.rosters].sort((a, b) => {
      const aw = a.settings.wins || 0, bw = b.settings.wins || 0;
      if (bw !== aw) return bw - aw;
      const apf = (a.settings.fpts || 0) + (a.settings.fpts_decimal || 0) / 100;
      const bpf = (b.settings.fpts || 0) + (b.settings.fpts_decimal || 0) / 100;
      return bpf - apf;
    });
    const myRoster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;

    el("standings-body").innerHTML = sorted
      .map((r, i) => {
        const user = userFor(r.owner_id);
        const name = teamNameFor(r.owner_id);
        const isMe = myRoster && r.roster_id === myRoster.roster_id;
        const av = user ? avatarUrl(user.avatar) : "";
        const pf = ((r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100).toFixed(2);
        const pa = ((r.settings.fpts_against || 0) + (r.settings.fpts_against_decimal || 0) / 100).toFixed(2);
        return `<tr>
          <td class="rank-col">${i + 1}</td>
          <td><div class="standings-team">
            ${av ? `<img class="standings-avatar" alt="" src="${av}" />` : `<div class="standings-avatar"></div>`}
            <span class="standings-name${isMe ? " me" : ""}">${escapeHtml(name)}</span>
          </div></td>
          <td>${r.settings.wins || 0}-${r.settings.losses || 0}${r.settings.ties ? "-" + r.settings.ties : ""}</td>
          <td>${pf}</td>
          <td>${pa}</td>
        </tr>`;
      })
      .join("");
  }

  function renderPowerRankings() {
    const body = el("power-body");
    if (!body) return;
    const myRoster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;

    const scored = DATA.rosters.map((r) => ({ roster: r, total: teamProjectedTotal(r) }));
    scored.sort((a, b) => b.total - a.total);

    body.innerHTML = scored
      .map((s, i) => {
        const r = s.roster;
        const user = userFor(r.owner_id);
        const name = teamNameFor(r.owner_id);
        const isMe = myRoster && r.roster_id === myRoster.roster_id;
        const av = user ? avatarUrl(user.avatar) : "";
        return `<tr>
          <td class="rank-col">${i + 1}</td>
          <td><div class="standings-team">
            ${av ? `<img class="standings-avatar" alt="" src="${av}" />` : `<div class="standings-avatar"></div>`}
            <span class="standings-name${isMe ? " me" : ""}">${escapeHtml(name)}</span>
          </div></td>
          <td>${r.settings.wins || 0}-${r.settings.losses || 0}${r.settings.ties ? "-" + r.settings.ties : ""}</td>
          <td>${fmtPts(s.total)}</td>
        </tr>`;
      })
      .join("");
  }

  function renderMyTeam() {
    const roster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!roster) {
      el("myteam-header").innerHTML = "";
      el("starters-list").innerHTML = "";
      el("bench-list").innerHTML = "";
      el("ir-wrap").hidden = true;
      el("myteam-header").innerHTML = `<div class="empty-state" style="width:100%">
        Pick your team from the settings (⚙) button up top to see your roster.
      </div>`;
      return;
    }
    const user = userFor(roster.owner_id);
    const name = teamNameFor(roster.owner_id);
    const av = user ? avatarUrl(user.avatar) : "";
    el("myteam-header").innerHTML = `
      ${av ? `<img alt="" src="${av}" />` : ""}
      <div>
        <div class="myteam-title">${escapeHtml(name)}</div>
        <div class="myteam-record">${roster.settings.wins || 0}-${roster.settings.losses || 0}${roster.settings.ties ? "-" + roster.settings.ties : ""}</div>
      </div>`;

    const matchup = matchupFor(roster.roster_id);
    const slotOrder = (DATA.league.roster_positions || []).filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
    const starters = roster.starters || [];
    el("starters-list").innerHTML =
      starters.map((pid, idx) => playerCardHtml(pid, slotOrder[idx] || "", matchup, idx)).join("") ||
      `<div class="empty-state">No starters set.</div>`;

    const reserveSet = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
    const starterSet = new Set(starters);
    const bench = (roster.players || []).filter((pid) => !starterSet.has(pid) && !reserveSet.has(pid));
    el("bench-list").innerHTML =
      bench.map((pid) => playerCardHtml(pid, "BN", matchup)).join("") || `<div class="empty-state">No bench players.</div>`;

    if (reserveSet.size) {
      el("ir-wrap").hidden = false;
      el("ir-list").innerHTML = [...reserveSet].map((pid) => playerCardHtml(pid, "IR", matchup)).join("");
    } else {
      el("ir-wrap").hidden = true;
    }
  }

  function renderInjuryBanner() {
    const banner = el("injury-banner");
    const roster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!roster) {
      banner.hidden = true;
      return;
    }
    const flagged = (roster.starters || [])
      .filter((pid) => pid && pid !== "0")
      .map((pid) => DATA.players[pid])
      .filter((p) => p && INJURY_FLAGS.includes(p.i));

    if (!flagged.length) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.innerHTML =
      `<span class="injury-banner-label">⚠ ${flagged.length} starter${flagged.length > 1 ? "s" : ""} flagged</span>` +
      flagged.map((p) => `<button class="injury-chip">${escapeHtml(p.n)} ${injuryBadge(p.i)}</button>`).join("");
    banner.querySelectorAll(".injury-chip").forEach((btn) => {
      btn.addEventListener("click", () => document.querySelector('.tab-chip[data-view="myteam"]').click());
    });
  }

  function renderStartSit() {
    const wrap = el("startsit-list");
    const statusEl = el("matchup-diff-status");
    if (DATA.matchupDiffFailed && DATA.dvpFailed) {
      statusEl.hidden = false;
      statusEl.textContent = "Opponent and defense-vs-position data are both unavailable right now — suggestions below use recent scoring + health only.";
    } else if (DATA.dvpFailed) {
      statusEl.hidden = false;
      statusEl.textContent = "Defense-vs-position data is unavailable right now — projections use recent scoring only, with no matchup adjustment.";
    } else if (DATA.dvpSource) {
      statusEl.hidden = false;
      statusEl.textContent = `Projections blend recent scoring with defense-vs-position data from ${DATA.dvpSource}.`;
    } else {
      statusEl.hidden = true;
    }
    const roster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!roster) {
      wrap.innerHTML = "";
      return;
    }
    const slotOrder = (DATA.league.roster_positions || []).filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
    const starters = roster.starters || [];
    const reserveSet = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
    const starterSet = new Set(starters);
    const bench = (roster.players || []).filter((pid) => !starterSet.has(pid) && !reserveSet.has(pid));
    const suggestions = [];
    const usedBench = new Set();

    // Build one slot descriptor per starter up front so injury-driven swaps (more
    // urgent) can claim the best bench candidate before performance-driven ones do —
    // a single bench player should never be suggested into two starter slots at once.
    const slots = starters
      .map((pid, idx) => ({ pid, idx, slot: slotOrder[idx] || "", info: DATA.players[pid] }))
      .filter((s) => s.pid && s.pid !== "0" && s.info);

    function bestCandidate(pool) {
      let best = null;
      let bestProj = -Infinity;
      pool.forEach((bpid) => {
        const p = projectPoints(bpid);
        if (p !== null && p > bestProj) {
          bestProj = p;
          best = bpid;
        }
      });
      return best === null ? { best: null, bestProj: null } : { best, bestProj };
    }

    const passes = [
      slots.filter((s) => INJURY_FLAGS.includes(s.info.i)),
      slots.filter((s) => !INJURY_FLAGS.includes(s.info.i)),
    ];

    passes[0].forEach((s) => {
      const eligible = flexEligibility(s.slot);
      if (!eligible.length) return;
      const candidates = bench.filter((bpid) => {
        const bp = DATA.players[bpid];
        return bp && eligible.includes(bp.p) && !usedBench.has(bpid);
      });
      if (!candidates.length) return;
      const healthy = candidates.filter((bpid) => !INJURY_FLAGS.includes((DATA.players[bpid] || {}).i));
      const pool = healthy.length ? healthy : candidates;
      const { best, bestProj } = bestCandidate(pool);
      const chosen = best !== null ? best : pool[0];
      const chosenProj = best !== null ? bestProj : projectPoints(pool[0]);
      usedBench.add(chosen);
      suggestions.push({ starterPid: s.pid, starterAvg: projectPoints(s.pid), benchPid: chosen, benchAvg: chosenProj, reason: "injury", slot: s.slot });
    });

    passes[1].forEach((s) => {
      const eligible = flexEligibility(s.slot);
      if (!eligible.length) return;
      const starterProj = projectPoints(s.pid);
      if (starterProj === null) return;
      const candidates = bench.filter((bpid) => {
        const bp = DATA.players[bpid];
        return bp && eligible.includes(bp.p) && !usedBench.has(bpid);
      });
      if (!candidates.length) return;
      const { best, bestProj } = bestCandidate(candidates);
      if (best !== null && bestProj - starterProj >= START_SIT_MARGIN) {
        usedBench.add(best);
        suggestions.push({ starterPid: s.pid, starterAvg: starterProj, benchPid: best, benchAvg: bestProj, reason: "performance", slot: s.slot });
      }
    });

    if (!suggestions.length) {
      wrap.innerHTML = `<div class="empty-state">No changes suggested — your lineup looks solid based on projected points and health.</div>`;
      return;
    }

    wrap.innerHTML = suggestions
      .map((s) => {
        const sp = DATA.players[s.starterPid] || { n: s.starterPid };
        const bp = DATA.players[s.benchPid] || { n: s.benchPid };
        let reasonText;
        if (s.reason === "injury") {
          const code = INJURY_CODES[sp.i] || sp.i;
          reasonText =
            s.benchAvg !== null
              ? `${sp.n} is ${code} — ${bp.n} projects for ${fmtPts(s.benchAvg)} pts`
              : `${sp.n} is ${code} — ${bp.n} may be the safer play`;
        } else {
          reasonText = `${bp.n} projects higher than ${sp.n} (${fmtPts(s.benchAvg)} vs ${fmtPts(s.starterAvg)})`;
        }
        const spOpp = opponentInfoFor(s.starterPid);
        const bpOpp = opponentInfoFor(s.benchPid);
        const oppLine = [
          spOpp ? `${sp.n} vs ${spOpp.opponent}${spOpp.opponentRecord ? ` (${spOpp.opponentRecord})` : ""}` : null,
          bpOpp ? `${bp.n} vs ${bpOpp.opponent}${bpOpp.opponentRecord ? ` (${bpOpp.opponentRecord})` : ""}` : null,
        ].filter(Boolean).join(" · ");
        return `<div class="suggestion-card">
          <div class="suggestion-slot">${escapeHtml(s.slot)}</div>
          <div class="suggestion-body">
            <div class="suggestion-swap"><span class="sit">${escapeHtml(sp.n)}</span><span class="arrow">→</span><span class="start">${escapeHtml(bp.n)}</span></div>
            <div class="suggestion-reason">${escapeHtml(reasonText)}</div>
            ${oppLine ? `<div class="suggestion-reason">${escapeHtml(oppLine)}</div>` : ""}
          </div>
        </div>`;
      })
      .join("");
  }

  function computeThinPositions(roster) {
    const counts = {};
    (roster.players || []).forEach((pid) => {
      const p = DATA.players[pid];
      if (p && p.p) counts[p.p] = (counts[p.p] || 0) + 1;
    });
    const required = {};
    (DATA.league.roster_positions || []).forEach((s) => {
      if (s === "BN" || s === "IR" || s === "TAXI") return;
      const elig = flexEligibility(s);
      if (elig.length === 1) required[elig[0]] = (required[elig[0]] || 0) + 1;
    });
    return Object.keys(required).filter((pos) => (counts[pos] || 0) <= required[pos]);
  }

  function renderWaiver() {
    const wrap = el("waiver-list");
    const roster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!roster) {
      wrap.innerHTML = "";
      return;
    }
    if (!DATA.trending.length) {
      wrap.innerHTML = `<div class="empty-state">No trending waiver data available right now.</div>`;
      return;
    }

    const takenIds = new Set();
    DATA.rosters.forEach((r) => (r.players || []).forEach((pid) => takenIds.add(pid)));
    const thinPositions = computeThinPositions(roster);
    const totalSlots = (DATA.league.roster_positions || []).filter((s) => s !== "IR" && s !== "TAXI").length;
    const rosterFull = (roster.players || []).length >= totalSlots;

    const available = DATA.trending
      .filter((t) => !takenIds.has(t.player_id))
      .map((t) => ({ ...t, info: DATA.players[t.player_id] }))
      .filter((t) => t.info);

    const withProjections = (list) =>
      list
        .map((t) => ({ ...t, proj: projectPoints(t.player_id) }))
        .sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));

    const relevant = withProjections(available.filter((t) => thinPositions.includes(t.info.p)));
    const shown = (relevant.length ? relevant : withProjections(available)).slice(0, 8);

    if (!shown.length) {
      wrap.innerHTML = `<div class="empty-state">No trending waiver targets available right now.</div>`;
      return;
    }

    const note = relevant.length
      ? `Matched to your thin position${thinPositions.length > 1 ? "s" : ""}: ${thinPositions.join(", ")} · ranked by projected points`
      : `No trending adds match your thin spots — showing top adds league-wide, ranked by projected points`;

    wrap.innerHTML =
      `<div class="waiver-note">${escapeHtml(note)}${rosterFull ? " · your roster is full, this would require a drop" : ""}</div>` +
      shown
        .map((t) => {
          const p = t.info;
          return `<div class="player-card">
            <div class="player-slot">${escapeHtml(p.p || "")}</div>
            <div class="player-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml(p.t || "")}</div>
            <div class="player-info">
              <div class="player-name-row"><span class="player-name">${escapeHtml(p.n)}</span>${injuryBadge(p.i)}</div>
              <div class="player-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""} · added in ${t.count} leagues today</div>
            </div>
            <div class="player-points">${t.proj !== null ? fmtPts(t.proj) : "—"}</div>
          </div>`;
        })
        .join("");
  }

  function renderStreamers() {
    const defWrap = el("streamer-def-list");
    const kWrap = el("streamer-k-list");
    if (!defWrap || !kWrap) return;

    const takenIds = new Set();
    DATA.rosters.forEach((r) => (r.players || []).forEach((pid) => takenIds.add(pid)));

    function topAvailable(position) {
      return Object.entries(DATA.players)
        .filter(([pid, p]) => p.p === position && !takenIds.has(pid))
        .map(([pid, p]) => ({ pid, info: p, proj: projectPoints(pid) }))
        .filter((x) => x.proj !== null)
        .sort((a, b) => b.proj - a.proj)
        .slice(0, 5);
    }

    function row(x) {
      const p = x.info;
      const opp = opponentInfoFor(x.pid);
      const oppText = opp ? `vs ${opp.opponent}${opp.opponentRecord ? ` (${opp.opponentRecord})` : ""}` : "opponent unknown";
      return `<div class="player-card">
        <div class="player-slot">${escapeHtml(p.p)}</div>
        <div class="player-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml(p.t || "")}</div>
        <div class="player-info">
          <div class="player-name-row"><span class="player-name">${escapeHtml(p.n)}</span>${injuryBadge(p.i)}</div>
          <div class="player-meta">${escapeHtml(oppText)}</div>
        </div>
        <div class="player-points">${fmtPts(x.proj)}</div>
      </div>`;
    }

    const defs = topAvailable("DEF");
    const ks = topAvailable("K");
    defWrap.innerHTML =
      `<div class="waiver-note">Top available defenses this week</div>` +
      (defs.length ? defs.map(row).join("") : `<div class="empty-state">No defense projections available right now.</div>`);
    kWrap.innerHTML =
      `<div class="waiver-note">Top available kickers this week</div>` +
      (ks.length ? ks.map(row).join("") : `<div class="empty-state">No kicker projections available right now.</div>`);
  }

  function tradePlayerRowHtml(playerId, side) {
    const p = DATA.players[playerId] || { n: playerId, p: "", t: "" };
    const v = DATA.tradeValues[playerId];
    const img =
      p.p === "DEF"
        ? ""
        : `<img class="player-avatar" alt="" loading="lazy" src="https://sleepercdn.com/content/nfl/players/thumb/${playerId}.jpg" onerror="this.style.visibility='hidden'" />`;
    return `<div class="player-card" data-trade-side="${side}" data-player-id="${escapeHtml(playerId)}">
      ${img || `<div class="player-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml(p.t || "")}</div>`}
      <div class="player-info">
        <div class="player-name-row"><span class="player-name">${escapeHtml(p.n)}</span></div>
        <div class="player-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}</div>
      </div>
      <div class="player-points">${v ? v.value : "—"}</div>
      <button class="trade-remove-btn" data-remove-side="${side}" data-remove-id="${escapeHtml(playerId)}" aria-label="Remove">✕</button>
    </div>`;
  }

  function tradeSideTotal(side) {
    return DATA.trade[side].reduce((sum, pid) => sum + ((DATA.tradeValues[pid] && DATA.tradeValues[pid].value) || 0), 0);
  }

  function renderTradeCheck() {
    if (!DATA.tradeValuesLoaded) return;

    el("trade-give-list").innerHTML =
      DATA.trade.give.map((pid) => tradePlayerRowHtml(pid, "give")).join("") ||
      `<div class="empty-state">No players added.</div>`;
    el("trade-get-list").innerHTML =
      DATA.trade.get.map((pid) => tradePlayerRowHtml(pid, "get")).join("") ||
      `<div class="empty-state">No players added.</div>`;

    document.querySelectorAll(".trade-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const side = btn.getAttribute("data-remove-side");
        const pid = btn.getAttribute("data-remove-id");
        DATA.trade[side] = DATA.trade[side].filter((p) => p !== pid);
        renderTradeCheck();
      });
    });

    const giveTotal = tradeSideTotal("give");
    const getTotal = tradeSideTotal("get");
    el("trade-give-total").textContent = `Total: ${giveTotal.toLocaleString()}`;
    el("trade-get-total").textContent = `Total: ${getTotal.toLocaleString()}`;

    const verdictEl = el("trade-verdict");
    if (!DATA.trade.give.length && !DATA.trade.get.length) {
      verdictEl.hidden = true;
      return;
    }
    verdictEl.hidden = false;
    const diff = getTotal - giveTotal;
    if (diff === 0) {
      verdictEl.className = "trade-verdict";
      verdictEl.textContent = "Dead even in market value.";
    } else if (diff > 0) {
      verdictEl.className = "trade-verdict favor";
      verdictEl.textContent = `This favors you by ${diff.toLocaleString()} in value.`;
    } else {
      verdictEl.className = "trade-verdict";
      verdictEl.textContent = `You're giving up ${Math.abs(diff).toLocaleString()} more in value than you get.`;
    }
  }

  function openPlayerPicker(side) {
    DATA.tradePickerTarget = side;
    el("player-picker-search").value = "";
    renderPlayerPickerResults("");
    el("player-picker-modal").showModal();
    el("player-picker-search").focus();
  }

  function renderPlayerPickerResults(query) {
    const wrap = el("player-picker-list");
    const q = query.trim().toLowerCase();
    if (!q) {
      wrap.innerHTML = `<div class="empty-state">Type a player's name to search.</div>`;
      return;
    }
    const matches = Object.entries(DATA.players)
      .filter(([, p]) => p.n && p.n.toLowerCase().includes(q))
      .slice(0, 30);
    if (!matches.length) {
      wrap.innerHTML = `<div class="empty-state">No players found.</div>`;
      return;
    }
    wrap.innerHTML = matches
      .map(([pid, p]) => {
        const v = DATA.tradeValues[pid];
        return `<div class="owner-option" data-pid="${escapeHtml(pid)}">
          <div>
            <div class="owner-option-name">${escapeHtml(p.n)}</div>
            <div class="owner-option-sub">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}${v ? ` · value ${v.value}` : ""}</div>
          </div>
        </div>`;
      })
      .join("");
    wrap.querySelectorAll(".owner-option").forEach((node) => {
      node.addEventListener("click", () => {
        const pid = node.getAttribute("data-pid");
        const side = DATA.tradePickerTarget;
        if (side && !DATA.trade[side].includes(pid)) DATA.trade[side].push(pid);
        el("player-picker-modal").close();
        renderTradeCheck();
      });
    });
  }

  function initTrade() {
    el("trade-add-give").addEventListener("click", () => openPlayerPicker("give"));
    el("trade-add-get").addEventListener("click", () => openPlayerPicker("get"));
    el("player-picker-close").addEventListener("click", () => el("player-picker-modal").close());
    el("player-picker-modal").addEventListener("click", (e) => {
      if (e.target === el("player-picker-modal")) el("player-picker-modal").close();
    });
    el("player-picker-search").addEventListener("input", (e) => renderPlayerPickerResults(e.target.value));
  }

  function renderAll() {
    renderTopbar();
    renderMatchups();
    renderStandings();
    renderPowerRankings();
    renderMyTeam();
    renderInjuryBanner();
    renderStartSit();
    renderWaiver();
    renderStreamers();
  }

  function renderOwnerPicker() {
    const wrap = el("owner-picker");
    if (!DATA.users.length) {
      wrap.innerHTML = `<div class="empty-state">No league members found.</div>`;
      return;
    }
    wrap.innerHTML = DATA.users
      .map((u) => {
        const selected = u.user_id === DATA.myUserId;
        const name = (u.metadata && u.metadata.team_name) || u.display_name;
        const av = avatarUrl(u.avatar);
        return `<div class="owner-option${selected ? " selected" : ""}" data-user-id="${escapeHtml(u.user_id)}">
          ${av ? `<img alt="" src="${av}" />` : `<div style="width:32px;height:32px;border-radius:50%;background:var(--surface)"></div>`}
          <div>
            <div class="owner-option-name">${escapeHtml(name)}</div>
            <div class="owner-option-sub">@${escapeHtml(u.display_name)}</div>
          </div>
        </div>`;
      })
      .join("");
    wrap.querySelectorAll(".owner-option").forEach((node) => {
      node.addEventListener("click", () => {
        DATA.myUserId = node.getAttribute("data-user-id");
        localStorage.setItem(MY_USER_KEY, DATA.myUserId);
        el("settings-modal").close();
        refreshCycle(); // re-render everything that depends on which roster is "mine"
      });
    });
  }

  function showError(msg) {
    const b = el("error-banner");
    b.textContent = msg;
    b.hidden = false;
  }
  function hideError() {
    el("error-banner").hidden = true;
  }
  function setLive(active) {
    el("refresh-dot").style.opacity = active ? "1" : "0.35";
  }
  function updateLastUpdated() {
    const now = new Date();
    el("last-updated").textContent = `Updated ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  let firstLoad = true;

  async function refreshCycle() {
    setLive(true);
    try {
      const [state, league, users, rosters, trending] = await Promise.all([
        fetchJSON(`${BASE}/state/nfl`),
        fetchJSON(`${BASE}/league/${LEAGUE_ID}`),
        fetchJSON(`${BASE}/league/${LEAGUE_ID}/users`),
        fetchJSON(`${BASE}/league/${LEAGUE_ID}/rosters`),
        fetchJSON(`${BASE}/players/nfl/trending/add?lookback_hours=24&limit=50`).catch(() => []),
      ]);
      const week = Math.max(1, Math.min(18, state.week || league.settings.leg || 1));
      const matchups = await getWeekMatchups(week, false);
      await ensurePlayers();

      DATA.league = league;
      DATA.users = users;
      DATA.rosters = rosters;
      DATA.matchups = matchups;
      DATA.week = week;
      DATA.trending = trending;

      DATA.recentPerf = await computeRecentPerformance(week);

      await loadMatchupDiff(week, league.season);
      await ensureDVP();
      const stdDevResult = await computeScoreStdDev(week);
      DATA.scoreStdDev = stdDevResult.stdDev;
      DATA.scoreStdDevSource = stdDevResult.source;

      renderAll();
      hideError();

      if (firstLoad) {
        firstLoad = false;
        if (!DATA.myUserId || !rosterForUser(DATA.myUserId)) {
          renderOwnerPicker();
          el("settings-modal").showModal();
        }
      }
    } catch (e) {
      console.error(e);
      showError(`Couldn't refresh data: ${e.message}`);
    } finally {
      setLive(false);
      updateLastUpdated();
    }
  }

  function initTabs() {
    document.querySelectorAll(".tab-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const view = btn.getAttribute("data-view");
        document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
        if (view === "trade" && !DATA.tradeValuesLoaded) loadTradeValues();
      });
    });
  }

  function initSettings() {
    el("settings-btn").addEventListener("click", () => {
      renderOwnerPicker();
      el("settings-modal").showModal();
    });
    el("settings-close").addEventListener("click", () => el("settings-modal").close());
    el("settings-modal").addEventListener("click", (e) => {
      if (e.target === el("settings-modal")) el("settings-modal").close();
    });
  }

  function init() {
    initTabs();
    initSettings();
    initTrade();
    refreshCycle();
    setInterval(refreshCycle, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshCycle();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
