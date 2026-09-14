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
  // Statuses Sleeper itself treats as a near-certain zero (inactive/ruled out) —
  // their projection is zeroed, not just discounted, since there's no real chance
  // of the outcome landing anywhere near a normal game.
  const INJURY_OUT_FLAGS = ["Out", "IR", "Suspended", "Sus", "PUP"];
  // Statuses where the player might genuinely still play — a real but uncertain
  // risk, applied as a percentage discount to their own projection rather than an
  // automatic bench swap, so a still-elite Questionable starter isn't reflexively
  // pulled for a much weaker healthy bench option.
  const INJURY_RISK_DISCOUNT = { Questionable: 0.85, Doubtful: 0.5 };

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
    lastSeasonPerf: {},
    scoreStdDev: null,
    scoreStdDevSource: null,
    waiverPosFilter: "ALL",
  };
  const DEFAULT_SCORE_STDDEV = 22; // points — typical weekly fantasy lineup volatility, used only until real season data exists

  const MATCHUP_DIFF_CACHE_PREFIX = "ffl_matchupdiff_v1_";
  const TRADE_VALUES_CACHE_KEY = "ffl_trade_values_v1";
  const TRADE_VALUES_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const DVP_CACHE_PREFIX = "ffl_dvp_v8_"; // bumped: added rostered-players-only custom-scoring match diagnostic
  const DVP_MAX_AGE_MS = 20 * 60 * 60 * 1000; // recompute roughly once a day
  const DVP_POSITIONS = ["QB", "RB", "WR", "TE", "DEF", "K"];
  // Trade suggestions stick to skill positions — DEF/K rarely carry real
  // trade value or get traded in practice, and FantasyCalc itself barely
  // prices them.
  const TRADE_POSITIONS = ["QB", "RB", "WR", "TE"];
  const PROJECTION_BLEND = 0.6; // weight on a player's own recent scoring vs. opponent DVP baseline
  // Per-week decay applied when averaging a range of real games (see
  // computeDVPForRange): 0.93 gives roughly a 9-10 week half-life, so a full
  // last-season average still leans noticeably toward the second half of that
  // season — closer to a player's current role/opportunity than the season
  // open — without discarding the earlier weeks entirely.
  const RECENCY_DECAY = 0.93;

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

  // Live-adjusted total for the CURRENT week's matchups/win%: once a player has
  // actually recorded a nonzero score this week, use that real number instead of
  // the pre-game projection — mirrors what Sleeper's own in-app projection does,
  // converging to the true final score as games finish instead of staying frozen
  // at a pre-game snapshot all day. A 0 in Sleeper's live feed is ambiguous
  // (genuinely scored zero vs. hasn't played yet) — treated as "hasn't played"
  // here, since that's the far more common case and the safer assumption.
  function teamLiveAdjustedTotal(roster) {
    const matchup = matchupFor(roster.roster_id);
    return (roster.starters || []).reduce((sum, pid, idx) => {
      if (!pid || pid === "0") return sum;
      const live = ptsFor(matchup, pid, idx);
      const val = live ? live : projectPoints(pid) || 0;
      return sum + val;
    }, 0);
  }

  // Starters who haven't recorded a live score yet this week — same "0 means
  // hasn't played" convention as teamLiveAdjustedTotal above, kept consistent
  // so the count always matches what's actually driving the live total.
  function yetToPlayInfo(roster) {
    const matchup = matchupFor(roster.roster_id);
    let count = 0;
    const positions = [];
    (roster.starters || []).forEach((pid, idx) => {
      if (!pid || pid === "0") return;
      if (ptsFor(matchup, pid, idx)) return;
      count++;
      const p = DATA.players[pid];
      const pos = p && p.p ? p.p : "?";
      if (!positions.includes(pos)) positions.push(pos);
    });
    return { count, positions };
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

  // Generic engine: Sleeper computes its own pts_ppr/pts_half_ppr/pts_std
  // fields as a dot product of raw per-stat counts (pass_yd, rec, rec_yd,
  // rush_td, bonus_rec_yd_100, fgm_40_49, ...) against a scoring table — that's
  // true for every position, not just defense. Doing that same dot product
  // ourselves against THIS league's actual scoring_settings, instead of
  // trusting Sleeper's generic preset, is what lets custom bonuses (TE
  // premium, yardage bonuses, distance-bucketed kicker/defense scoring, etc.)
  // actually show up in projections. Points-allowed brackets are excluded
  // here since they're keyed by opponent score, not a per-stat count — those
  // are handled separately by pointsAllowBracketPoints below.
  function customPointsFromStatLine(statLine, scoringSettings) {
    if (!statLine || !scoringSettings) return { points: null, matched: false };
    let total = 0;
    let matched = false;
    for (const key in scoringSettings) {
      if (key.startsWith("pts_allow_") || key.startsWith("yds_allow_")) continue;
      const weight = scoringSettings[key];
      if (typeof weight !== "number" || weight === 0) continue;
      const statVal = statLine[key];
      if (typeof statVal === "number") {
        total += statVal * weight;
        matched = true;
      }
    }
    return { points: matched ? total : null, matched };
  }

  // Points-allowed brackets in ascending order — the dominant swing factor in
  // most leagues' defense scoring (often a 10+ point spread shutout-to-blowout),
  // and the piece most likely to diverge from Sleeper's generic preset since
  // every league sets its own bracket values.
  const PTS_ALLOW_BRACKETS = [
    { max: 0, key: "pts_allow_0" },
    { max: 6, key: "pts_allow_1_6" },
    { max: 13, key: "pts_allow_7_13" },
    { max: 20, key: "pts_allow_14_20" },
    { max: 27, key: "pts_allow_21_27" },
    { max: 34, key: "pts_allow_28_34" },
    { max: Infinity, key: "pts_allow_35p" },
  ];
  function pointsAllowBracketPoints(statLine, scoringSettings) {
    if (!statLine || typeof statLine.pts_allow !== "number") return { points: 0, matched: false };
    const bracket = PTS_ALLOW_BRACKETS.find((b) => statLine.pts_allow <= b.max);
    if (bracket && typeof scoringSettings[bracket.key] === "number") {
      return { points: scoringSettings[bracket.key], matched: true };
    }
    return { points: 0, matched: false };
  }
  // Defense points = the generic per-stat dot product (sacks, INTs, forced
  // fumbles, defensive TDs, ...) plus the points-allowed bracket, which isn't
  // a simple stat-count multiply.
  function customDefensePoints(statLine, scoringSettings) {
    if (!statLine || !scoringSettings) return { points: null, matched: false };
    const generic = customPointsFromStatLine(statLine, scoringSettings);
    const bracket = pointsAllowBracketPoints(statLine, scoringSettings);
    const matched = generic.matched || bracket.matched;
    return { points: matched ? (generic.points || 0) + (bracket.points || 0) : null, matched };
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
    const scoringSettings = (DATA.league && DATA.league.scoring_settings) || {};
    const table = {}; // opponent team -> position -> { sum, n }
    const perPlayer = {}; // player_id -> { sum, n } — this specific player's own average that season
    // The leaguewide match rate below spans every NFL player at these positions,
    // most of whom are backups/inactives most weeks — a low overall rate can just
    // mean "lots of zero-production players had no stat keys to match," not that
    // real production is being missed. Tracking rostered-players-only separately
    // gives a much more honest signal for whether THIS league's actual players
    // (the ones projections are built from) are being custom-scored correctly.
    const rosteredIds = new Set();
    (DATA.rosters || []).forEach((r) => (r.players || []).forEach((pid) => rosteredIds.add(pid)));
    const weekResults = await Promise.all(
      weeks.map((w) => Promise.all([fetchWeekStats(season, w), fetchWeekSchedule(season, w)]))
    );
    let weeksWithData = 0;
    let statLinesSeen = 0;
    let statLinesUsable = 0; // had a matching scoring field
    let observations = 0; // actually attributed into the table (also needs a schedule match)
    let defCustomMatched = 0;
    let defCustomTotal = 0;
    let offCustomMatched = 0;
    let offCustomTotal = 0;
    let rosteredMatched = 0;
    let rosteredTotal = 0;
    for (let i = 0; i < weekResults.length; i++) {
      const [stats, schedule] = weekResults[i];
      if (!stats || !schedule) continue;
      weeksWithData++;
      // Recency weight: the most recent week in this range counts fully, each
      // week further back counts a little less — real per-week results, just
      // biased toward a player's current role rather than diluted evenly across
      // a whole season that may include a since-changed team/role/depth-chart
      // spot. Rolled into perPlayer/table via the {sum,n} contract itself (n
      // accumulates weight, not a literal count), so avgPts()'s sum/n stays a
      // correct weighted average with no changes needed there.
      const weight = Math.pow(RECENCY_DECAY, weeks.length - 1 - i);
      for (const pid in stats) {
        const p = DATA.players[pid];
        if (!p || !p.t || !DVP_POSITIONS.includes(p.p)) continue;
        statLinesSeen++;
        let pts;
        let matched;
        if (p.p === "DEF") {
          defCustomTotal++;
          const custom = customDefensePoints(stats[pid], scoringSettings);
          matched = custom.matched;
          if (matched) defCustomMatched++;
          pts = custom.points !== null ? custom.points : pointsFromStatLine(stats[pid], field);
        } else {
          offCustomTotal++;
          const custom = customPointsFromStatLine(stats[pid], scoringSettings);
          matched = custom.matched;
          if (matched) offCustomMatched++;
          pts = custom.points !== null ? custom.points : pointsFromStatLine(stats[pid], field);
        }
        if (rosteredIds.has(pid)) {
          rosteredTotal++;
          if (matched) rosteredMatched++;
        }
        if (pts === null) continue;
        statLinesUsable++;
        if (!perPlayer[pid]) perPlayer[pid] = { sum: 0, n: 0 };
        perPlayer[pid].sum += pts * weight;
        perPlayer[pid].n += weight;
        const oppInfo = schedule[p.t];
        if (!oppInfo) continue;
        const opp = oppInfo.opponent;
        if (!table[opp]) table[opp] = {};
        if (!table[opp][p.p]) table[opp][p.p] = { sum: 0, n: 0 };
        table[opp][p.p].sum += pts * weight;
        table[opp][p.p].n += weight;
        observations++;
      }
    }
    const avg = {};
    for (const team in table) {
      avg[team] = {};
      for (const pos in table[team]) avg[team][pos] = table[team][pos].sum / table[team][pos].n;
    }
    return {
      avg,
      perPlayer,
      diagnostics: { weeksAttempted: weeks.length, weeksWithData, statLinesSeen, statLinesUsable, observations, field, defCustomMatched, defCustomTotal, offCustomMatched, offCustomTotal, rosteredMatched, rosteredTotal },
    };
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
          DATA.lastSeasonPerf = parsed.perPlayer || {};
          DATA.dvpFailed = false;
          return;
        }
      }
    } catch (e) { /* corrupt cache, recompute */ }

    try {
      let result, sourceLabel;
      if (usePrevious) {
        const prevSeason = String(Number(season) - 1);
        result = await computeDVPForRange(prevSeason, Array.from({ length: 18 }, (_, i) => i + 1));
        sourceLabel = `${prevSeason} season (no completed ${season} weeks yet)`;
      } else {
        result = await computeDVPForRange(season, Array.from({ length: week - 1 }, (_, i) => i + 1));
        sourceLabel = `${season}, weeks 1–${week - 1}`;
      }
      const d = result.diagnostics;
      const defNote = d.defCustomTotal
        ? `, DEF custom-scoring matched ${d.defCustomMatched}/${d.defCustomTotal}`
        : "";
      const offNote = d.offCustomTotal
        ? `, offense custom-scoring matched ${d.offCustomMatched}/${d.offCustomTotal}`
        : "";
      const rosteredNote = d.rosteredTotal
        ? `, your rostered players' custom-scoring matched ${d.rosteredMatched}/${d.rosteredTotal}`
        : "";
      const source = `${sourceLabel} — ${d.weeksWithData}/${d.weeksAttempted} weeks of data, ${d.observations} player-games, field "${d.field}"${defNote}${offNote}${rosteredNote}`;
      const table = result.avg;
      if (!Object.keys(table).length) throw new Error("empty DVP table");
      DATA.dvp = table;
      DATA.dvpSource = source;
      DATA.dvpDiagnostics = result.diagnostics;
      DATA.lastSeasonPerf = usePrevious ? result.perPlayer : {};
      DATA.dvpFailed = false;
      try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: table, source, perPlayer: DATA.lastSeasonPerf })); } catch (e) { /* quota — fine */ }
    } catch (e) {
      DATA.dvp = {};
      DATA.dvpSource = null;
      DATA.lastSeasonPerf = {};
      DATA.dvpFailed = true;
    }
  }

  // Blends a player's own scoring history with their opponent's defense-vs-position
  // baseline. "Own history" prefers this season's real games; before enough of
  // those exist, it falls back to this exact player's own average from last
  // season (a real starter's established level), not a generic position average —
  // a position-wide DVP number blends in every backup/role player who saw the
  // field, which understates anyone who's actually a real starter. Only a player
  // with no track record at all (true rookie, first game ever) falls back to the
  // pure position average, since that's the only real signal available for them.
  // This week's real downside risk from Sleeper's own injury designation — never
  // applied to the historical averages themselves (DATA.recentPerf/lastSeasonPerf
  // stay untouched raw box-score data, so future weeks aren't corrupted by a
  // status that's since cleared), only to this week's forward-looking number.
  function injuryDiscountFactor(status) {
    if (!status) return 1;
    if (INJURY_OUT_FLAGS.includes(status)) return 0;
    if (INJURY_RISK_DISCOUNT.hasOwnProperty(status)) return INJURY_RISK_DISCOUNT[status];
    return 1;
  }

  function projectPoints(playerId) {
    const p = DATA.players[playerId];
    if (!p) return null;
    const recentAvg = avgPts(DATA.recentPerf, playerId);
    const lastSeasonAvg = avgPts(DATA.lastSeasonPerf, playerId);
    const personalAvg = recentAvg !== null ? recentAvg : lastSeasonAvg;
    const oppInfo = opponentInfoFor(playerId);
    const dvpAvg = oppInfo && DATA.dvp[oppInfo.opponent] ? DATA.dvp[oppInfo.opponent][p.p] : undefined;
    let base;
    if (personalAvg !== null && dvpAvg !== undefined) base = personalAvg * PROJECTION_BLEND + dvpAvg * (1 - PROJECTION_BLEND);
    else if (personalAvg !== null) base = personalAvg;
    else if (dvpAvg !== undefined) base = dvpAvg;
    else return null;
    return base * injuryDiscountFactor(p.i);
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
          renderTradeSuggestions();
          return;
        }
      }
    } catch (e) { /* corrupt cache, refetch */ }

    statusEl.hidden = false;
    statusEl.textContent = "Loading trade values…";
    try {
      const { ppr, numTeams, numQbs, isDynasty } = leagueTradeParams();
      const res = await fetch(`/api/trade-values?ppr=${ppr}&numTeams=${numTeams}&numQbs=${numQbs}&isDynasty=${isDynasty}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.detail || json.error || `status ${res.status}`);
      DATA.tradeValues = json.values || {};
      DATA.tradeValuesLoaded = true;
      DATA.tradeValuesFailed = false;
      try { localStorage.setItem(TRADE_VALUES_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: DATA.tradeValues })); } catch (e) { /* quota — fine */ }
      statusEl.hidden = true;
    } catch (e) {
      DATA.tradeValuesFailed = true;
      DATA.tradeValuesLoaded = true;
      statusEl.hidden = false;
      // Surface the real upstream detail (from api/trade-values.js's error body)
      // instead of a fixed generic message — otherwise every failure looks
      // identical and there's no way to tell a rate limit from a shape change
      // from FantasyCalc just being down.
      statusEl.textContent = `Trade values are unavailable right now (${e.message || "FantasyCalc lookup failed"}). Try again later.`;
    }
    renderTradeCheck();
    renderTradeSuggestions();
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
  // Ensures a two-team matchup pairing always has "my" roster first, so it
  // consistently renders on the left, both in the matchups list and the detail view.
  function orderPairMeFirst(pair) {
    const myRoster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!myRoster || pair.length < 2) return pair;
    return pair[1].roster_id === myRoster.roster_id && pair[0].roster_id !== myRoster.roster_id
      ? [pair[1], pair[0]]
      : pair;
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
    const proj = projectPoints(playerId);
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
      <div class="player-points">${fmtPts(pts)}<span class="slot-side-proj">proj ${fmtPts(proj)}</span></div>
    </div>`;
  }

  // One side of a slot-by-slot matchup row: a player's name, injury badge, live
  // points, and projection, mirror-aligned depending on which team's side it's on.
  function matchupSlotSideHtml(playerId, matchup, idx, align) {
    if (!playerId || playerId === "0") {
      return `<div class="slot-side ${align}"><div class="slot-side-name" style="color:var(--text-dim)">Empty</div></div>`;
    }
    const p = DATA.players[playerId] || { n: playerId, p: "", t: "", i: null };
    const live = ptsFor(matchup, playerId, idx);
    const proj = projectPoints(playerId);
    return `<div class="slot-side ${align}">
      <div class="slot-side-name-row">
        ${injuryBadge(p.i)}
        <span class="slot-side-name">${escapeHtml(p.n)}</span>
      </div>
      <div class="slot-side-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}</div>
      <div class="slot-side-pts">${fmtPts(live)}<span class="slot-side-proj">proj ${fmtPts(proj)}</span></div>
    </div>`;
  }

  function matchupSlotRowHtml(pidA, pidB, slot, matchupA, matchupB, idx) {
    return `<div class="matchup-slot-row">
      ${matchupSlotSideHtml(pidA, matchupA, idx, "left")}
      <div class="matchup-slot-label">${escapeHtml(slot)}</div>
      ${matchupSlotSideHtml(pidB, matchupB, idx, "right")}
    </div>`;
  }

  function benchRowCompactHtml(playerId, matchup) {
    const p = DATA.players[playerId] || { n: playerId, p: "", t: "", i: null };
    const live = ptsFor(matchup, playerId);
    const proj = projectPoints(playerId);
    return `<div class="bench-compact-row">
      <div class="bench-compact-name"><span>${escapeHtml(p.n)}</span>${injuryBadge(p.i)}</div>
      <div class="bench-compact-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}</div>
      <div class="bench-compact-pts">${fmtPts(live)}<span class="slot-side-proj">proj ${fmtPts(proj)}</span></div>
    </div>`;
  }

  function benchFor(roster) {
    if (!roster) return [];
    const reserveSet = new Set([...(roster.reserve || []), ...(roster.taxi || [])]);
    const starterSet = new Set(roster.starters || []);
    return (roster.players || []).filter((pid) => !starterSet.has(pid) && !reserveSet.has(pid));
  }

  function openMatchupDetail(matchupId) {
    const group = DATA.matchups.filter((m) => String(m.matchup_id) === String(matchupId));
    if (group.length < 2) return;
    const [a, b] = orderPairMeFirst(group);
    const rosterA = DATA.rosters.find((r) => r.roster_id === a.roster_id);
    const rosterB = DATA.rosters.find((r) => r.roster_id === b.roster_id);
    const slotOrder = (DATA.league.roster_positions || []).filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI");
    const startersA = rosterA ? rosterA.starters || [] : [];
    const startersB = rosterB ? rosterB.starters || [] : [];

    el("matchup-detail-name-a").textContent = rosterA ? teamNameFor(rosterA.owner_id) : "Team";
    el("matchup-detail-name-b").textContent = rosterB ? teamNameFor(rosterB.owner_id) : "Team";
    el("matchup-detail-total-a").textContent = `Total: ${fmtPts(rosterA ? teamLiveAdjustedTotal(rosterA) : 0)}`;
    el("matchup-detail-total-b").textContent = `Total: ${fmtPts(rosterB ? teamLiveAdjustedTotal(rosterB) : 0)}`;
    const ytsA = rosterA ? yetToPlayInfo(rosterA) : { count: 0, positions: [] };
    const ytsB = rosterB ? yetToPlayInfo(rosterB) : { count: 0, positions: [] };
    el("matchup-detail-yts-a").textContent = ytsA.count ? `Yet to play (${ytsA.count}): ${ytsA.positions.join(", ")}` : "";
    el("matchup-detail-yts-b").textContent = ytsB.count ? `Yet to play (${ytsB.count}): ${ytsB.positions.join(", ")}` : "";
    el("matchup-detail-yts-row").hidden = !ytsA.count && !ytsB.count;
    el("matchup-detail-rows").innerHTML =
      slotOrder
        .map((slot, idx) => matchupSlotRowHtml(startersA[idx], startersB[idx], slot, a, b, idx))
        .join("") || `<div class="empty-state">No starters set.</div>`;

    const benchA = benchFor(rosterA);
    const benchB = benchFor(rosterB);
    el("matchup-detail-bench-a").innerHTML =
      benchA.map((pid) => benchRowCompactHtml(pid, a)).join("") || `<div class="empty-state">None</div>`;
    el("matchup-detail-bench-b").innerHTML =
      benchB.map((pid) => benchRowCompactHtml(pid, b)).join("") || `<div class="empty-state">None</div>`;

    el("matchup-detail-title").textContent = `Week ${DATA.week} Matchup`;
    el("matchup-detail-modal").showModal();
  }

  function initMatchupDetail() {
    el("matchup-detail-close").addEventListener("click", () => el("matchup-detail-modal").close());
    el("matchup-detail-modal").addEventListener("click", (e) => {
      if (e.target === el("matchup-detail-modal")) el("matchup-detail-modal").close();
    });
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
        const [a, b] = orderPairMeFirst(group);
        const rosterA = DATA.rosters.find((r) => r.roster_id === a.roster_id);
        const rosterB = DATA.rosters.find((r) => r.roster_id === b.roster_id);
        const projA = rosterA ? teamLiveAdjustedTotal(rosterA) : null;
        const projB = rosterB ? teamLiveAdjustedTotal(rosterB) : null;
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
          const proj = m === a ? projA : projB;
          const filledSlots = roster ? (roster.starters || []).filter((pid) => pid && pid !== "0").length : null;
          const totalSlots = roster ? (roster.starters || []).length : null;
          const incomplete = filledSlots !== null && totalSlots !== null && filledSlots < totalSlots;
          const yts = roster ? yetToPlayInfo(roster) : { count: 0, positions: [] };
          return `<div class="matchup-row">
            ${av ? `<img class="matchup-avatar" alt="" src="${av}" />` : `<div class="matchup-avatar"></div>`}
            <div class="matchup-team">
              <div class="matchup-team-name">${escapeHtml(name)}${isMe ? " (You)" : ""}</div>
              <div class="matchup-team-meta">${roster ? `${roster.settings.wins}-${roster.settings.losses}${roster.settings.ties ? "-" + roster.settings.ties : ""}` : ""}${proj !== null ? ` · proj ${fmtPts(proj)}` : ""}${prob !== null ? ` · ${Math.round(prob * 100)}% to win` : ""}${incomplete ? ` · ${escapeHtml(`${filledSlots}/${totalSlots} slots filled`)}` : ""}${yts.count ? ` · yet to play (${yts.count}): ${escapeHtml(yts.positions.join(", "))}` : ""}</div>
            </div>
            <div class="matchup-score${winning ? " winning" : ""}">${(m.points || 0).toFixed(2)}</div>
          </div>`;
        });
        return `<div class="matchup-card clickable" data-matchup-id="${escapeHtml(String(a.matchup_id))}">${rows[0]}<div class="matchup-divider"></div>${rows[1]}<div class="matchup-tap-hint">Tap for player-by-player breakdown</div></div>`;
      })
      .join("");

    document.querySelectorAll("#matchups-list .matchup-card[data-matchup-id]").forEach((card) => {
      card.addEventListener("click", () => openMatchupDetail(card.getAttribute("data-matchup-id")));
    });
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

    // Same live-score/win% math as the Matchups tab, surfaced here too so a
    // health-check doesn't require switching tabs — only shown when this
    // week's matchup pairing is actually known.
    let summaryHtml = "";
    const myMatchup = matchupFor(roster.roster_id);
    if (myMatchup && myMatchup.matchup_id != null) {
      const oppEntry = DATA.matchups.find(
        (m) => String(m.matchup_id) === String(myMatchup.matchup_id) && m.roster_id !== roster.roster_id
      );
      const oppRoster = oppEntry ? DATA.rosters.find((r) => r.roster_id === oppEntry.roster_id) : null;
      const projMe = teamLiveAdjustedTotal(roster);
      const projOpp = oppRoster ? teamLiveAdjustedTotal(oppRoster) : null;
      const prob = projOpp !== null ? winProbability(projMe, projOpp) : null;
      summaryHtml = `<div class="myteam-summary">
        <div class="myteam-summary-pts">${fmtPts(projMe)}</div>
        <div class="myteam-summary-meta">${prob !== null ? `${Math.round(prob * 100)}% to win` : "proj"}</div>
      </div>`;
    }

    el("myteam-header").innerHTML = `
      ${av ? `<img alt="" src="${av}" />` : ""}
      <div>
        <div class="myteam-title">${escapeHtml(name)}</div>
        <div class="myteam-record">${roster.settings.wins || 0}-${roster.settings.losses || 0}${roster.settings.ties ? "-" + roster.settings.ties : ""}</div>
      </div>
      ${summaryHtml}`;

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
      slots.filter((s) => INJURY_OUT_FLAGS.includes(s.info.i)),
      slots.filter((s) => INJURY_RISK_DISCOUNT.hasOwnProperty(s.info.i)),
      slots.filter((s) => !INJURY_FLAGS.includes(s.info.i)),
    ];

    // Tier 1: ruled out (or as good as) — Sleeper itself expects zero snaps
    // (projectPoints already zeroes their number), so always swap to the best
    // available bench option regardless of relative projection.
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
      suggestions.push({ starterPid: s.pid, starterAvg: projectPoints(s.pid), benchPid: chosen, benchAvg: chosenProj, reason: "out", slot: s.slot });
    });

    // Tiers 2 and 3 share the same comparison logic — a real margin between the
    // starter's own (already risk-discounted, for tier 2) projection and the best
    // bench option — just with a different label for why the starter's flagged.
    function suggestIfBenchBeats(s, reason) {
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
        suggestions.push({ starterPid: s.pid, starterAvg: starterProj, benchPid: best, benchAvg: bestProj, reason, slot: s.slot });
      }
    }

    // Tier 2: real but uncertain risk (Questionable/Doubtful) — the starter's own
    // projection already carries the risk discount, so a swap is only flagged if
    // a bench option clears that discounted number by a real margin.
    passes[1].forEach((s) => suggestIfBenchBeats(s, "risk"));
    // Tier 3: healthy — pure performance comparison.
    passes[2].forEach((s) => suggestIfBenchBeats(s, "performance"));

    if (!suggestions.length) {
      wrap.innerHTML = `<div class="empty-state">No changes suggested — your lineup looks solid based on projected points and health.</div>`;
      return;
    }

    wrap.innerHTML = suggestions
      .map((s) => {
        const sp = DATA.players[s.starterPid] || { n: s.starterPid };
        const bp = DATA.players[s.benchPid] || { n: s.benchPid };
        let reasonText;
        if (s.reason === "out") {
          const code = INJURY_CODES[sp.i] || sp.i;
          reasonText =
            s.benchAvg !== null
              ? `${sp.n} is ${code} — ${bp.n} projects for ${fmtPts(s.benchAvg)} pts`
              : `${sp.n} is ${code} — ${bp.n} may be the safer play`;
        } else if (s.reason === "risk") {
          const code = INJURY_CODES[sp.i] || sp.i;
          const riskPct = Math.round((1 - injuryDiscountFactor(sp.i)) * 100);
          reasonText = `${sp.n} is ${code} (${riskPct}% risk discount, now ${fmtPts(s.starterAvg)}) — ${bp.n} projects higher (${fmtPts(s.benchAvg)})`;
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

  // How many starting slots the league requires at each single-eligibility
  // position (FLEX/SUPER_FLEX excluded — they don't pin a specific position).
  // League-wide, not roster-specific, so computed once and reused for every
  // team's surplus/need profile.
  function requiredStartCounts() {
    const required = {};
    (DATA.league.roster_positions || []).forEach((s) => {
      if (s === "BN" || s === "IR" || s === "TAXI") return;
      const elig = flexEligibility(s);
      if (elig.length === 1) required[elig[0]] = (required[elig[0]] || 0) + 1;
    });
    return required;
  }
  function positionCounts(roster) {
    const counts = {};
    (roster.players || []).forEach((pid) => {
      const p = DATA.players[pid];
      if (p && p.p) counts[p.p] = (counts[p.p] || 0) + 1;
    });
    return counts;
  }
  function computeThinPositions(roster) {
    const counts = positionCounts(roster);
    const required = requiredStartCounts();
    return Object.keys(required).filter((pos) => (counts[pos] || 0) <= required[pos]);
  }
  // Positions where a roster carries meaningfully more depth than its own
  // starting requirement — at least 2 more than needed, real bench surplus
  // rather than a normal 1-deep bench. These are the players realistically
  // available to trade away without weakening the starting lineup.
  const TRADE_SURPLUS_MARGIN = 2;
  function computeSurplusPositions(roster) {
    const counts = positionCounts(roster);
    const required = requiredStartCounts();
    return Object.keys(counts).filter((pos) => (counts[pos] || 0) >= (required[pos] || 0) + TRADE_SURPLUS_MARGIN);
  }

  // Your single weakest rostered player at each position, by projection — the
  // player an available add would actually have to beat to be worth a pickup.
  // This catches real upgrade opportunities even when a position isn't
  // numerically "thin" (e.g. you have four bench WRs but they're all replacement-level).
  function rosterFloorByPosition(roster) {
    const floor = {};
    (roster.players || []).forEach((pid) => {
      const p = DATA.players[pid];
      if (!p || !p.p) return;
      const proj = projectPoints(pid);
      if (proj === null) return;
      if (!floor[p.p] || proj < floor[p.p].proj) floor[p.p] = { pid, name: p.n, proj };
    });
    return floor;
  }
  const WAIVER_UPGRADE_MARGIN = 2; // pts — ignore noise-level differences

  // Unified available-players browser: every unrostered player, optionally
  // filtered to one position, always ranked by the full projection engine —
  // not limited to Sleeper's "trending" feed. Replaces the old split between a
  // trending-only skill-position list and a separate DEF/K-only exhaustive
  // section, which could show conflicting "best pick" signals on one screen
  // (a trending-but-mediocre player up top while a better, non-trending option
  // only showed up in the DEF/K section below).
  function renderAvailablePlayers() {
    const wrap = el("waiver-list");
    const roster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    const filter = DATA.waiverPosFilter || "ALL";

    const takenIds = new Set();
    DATA.rosters.forEach((r) => (r.players || []).forEach((pid) => takenIds.add(pid)));
    const thinPositions = roster ? computeThinPositions(roster) : [];
    const floor = roster ? rosterFloorByPosition(roster) : {};
    const trendingCounts = {};
    (DATA.trending || []).forEach((t) => { trendingCounts[t.player_id] = t.count; });

    let pool = Object.entries(DATA.players)
      .filter(([pid, p]) => p && p.p && DVP_POSITIONS.includes(p.p) && !takenIds.has(pid))
      .map(([pid, p]) => ({ pid, info: p, proj: projectPoints(pid) }))
      .filter((x) => x.proj !== null);
    if (filter !== "ALL") pool = pool.filter((x) => x.info.p === filter);
    pool.sort((a, b) => b.proj - a.proj);
    const shown = pool.slice(0, 30);

    if (!shown.length) {
      wrap.innerHTML = `<div class="empty-state">No available players${filter !== "ALL" ? ` at ${escapeHtml(filter)}` : ""} right now.</div>`;
      return;
    }

    const totalSlots = roster ? (DATA.league.roster_positions || []).filter((s) => s !== "IR" && s !== "TAXI").length : null;
    const rosterFull = roster ? (roster.players || []).length >= totalSlots : false;
    const note = `Every available player${filter !== "ALL" ? ` at ${escapeHtml(filter)}` : ""}, ranked by projected points`;

    wrap.innerHTML =
      `<div class="waiver-note">${note}${rosterFull ? " · your roster is full, this would require a drop" : ""}</div>` +
      shown
        .map((x) => {
          const p = x.info;
          const f = floor[p.p];
          const isThin = thinPositions.includes(p.p);
          const beatsFloor = !!(f && x.proj > f.proj + WAIVER_UPGRADE_MARGIN);
          let reason = "";
          if (isThin && beatsFloor && f) {
            reason = `Fills a thin spot, and beats ${escapeHtml(f.name)} (${fmtPts(f.proj)})`;
          } else if (isThin) {
            reason = `Fills a thin spot at ${escapeHtml(p.p || "")}`;
          } else if (beatsFloor && f) {
            reason = `Would beat ${escapeHtml(f.name)}, your weakest ${escapeHtml(p.p || "")} (${fmtPts(f.proj)})`;
          }
          const opp = opponentInfoFor(x.pid);
          const oppText = opp ? `vs ${opp.opponent}${opp.opponentRecord ? ` (${opp.opponentRecord})` : ""}` : "";
          const trendCount = trendingCounts[x.pid];
          return `<div class="player-card">
            <div class="player-slot">${escapeHtml(p.p || "")}</div>
            <div class="player-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml(p.t || "")}</div>
            <div class="player-info">
              <div class="player-name-row"><span class="player-name">${escapeHtml(p.n)}</span>${injuryBadge(p.i)}</div>
              <div class="player-meta">${escapeHtml(p.p || "")}${p.t ? " · " + escapeHtml(p.t) : ""}${oppText ? " · " + escapeHtml(oppText) : ""}${trendCount ? ` · added in ${trendCount} leagues today` : ""}</div>
              ${reason ? `<div class="player-meta">${reason}</div>` : ""}
            </div>
            <div class="player-points">${fmtPts(x.proj)}</div>
          </div>`;
        })
        .join("");
  }

  function initWaiverFilter() {
    document.querySelectorAll(".pos-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".pos-chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        DATA.waiverPosFilter = btn.getAttribute("data-pos");
        renderAvailablePlayers();
      });
    });
  }

  // Scans every other team for a 1-for-1 swap where you give from a position
  // where you have real bench surplus and receive at a position you're thin
  // at — kept only when the two players' FantasyCalc values net out in your
  // favor. Deliberately one-sided: this tool exists to find offers worth
  // actually sending, not to do neutral analysis, so a trade that's even or
  // favors the other team never shows up here.
  function computeTradeSuggestions() {
    if (!DATA.tradeValuesLoaded || DATA.tradeValuesFailed) return [];
    const myRoster = DATA.myUserId ? rosterForUser(DATA.myUserId) : null;
    if (!myRoster) return [];

    const myNeeds = computeThinPositions(myRoster);
    const mySurplus = computeSurplusPositions(myRoster);
    const valueOf = (pid) => (DATA.tradeValues[pid] && DATA.tradeValues[pid].value) || null;

    const giveCandidates = (myRoster.players || []).filter((pid) => {
      const p = DATA.players[pid];
      return p && TRADE_POSITIONS.includes(p.p) && mySurplus.includes(p.p) && valueOf(pid) !== null;
    });
    if (!giveCandidates.length) return [];

    const suggestions = [];
    DATA.rosters.forEach((roster) => {
      if (roster.roster_id === myRoster.roster_id) return;
      const theirNeeds = computeThinPositions(roster);
      const theirSurplus = computeSurplusPositions(roster);
      const teamName = teamNameFor(roster.owner_id);

      const getCandidates = (roster.players || []).filter((pid) => {
        const p = DATA.players[pid];
        return p && TRADE_POSITIONS.includes(p.p) && myNeeds.includes(p.p) && theirSurplus.includes(p.p) && valueOf(pid) !== null;
      });
      if (!getCandidates.length) return;

      giveCandidates.forEach((givePid) => {
        const giveInfo = DATA.players[givePid];
        const giveValue = valueOf(givePid);
        getCandidates.forEach((getPid) => {
          const getInfo = DATA.players[getPid];
          const getValue = valueOf(getPid);
          const edge = getValue - giveValue;
          if (edge <= 0) return;
          suggestions.push({
            rosterId: roster.roster_id,
            teamName,
            givePid, giveInfo, giveValue,
            getPid, getInfo, getValue,
            edge,
            edgePct: edge / giveValue,
            mutualFit: theirNeeds.includes(giveInfo.p),
          });
        });
      });
    });

    // Trades that also fill a real need for the other team are the ones they
    // might actually accept — rank those first, then by your edge within
    // each group. Keep each player — yours or theirs — in at most one
    // suggestion; otherwise the same single valuable player on their roster
    // could get "offered for" by three different players of yours at once,
    // which isn't a real option since they can only complete one of those.
    suggestions.sort((a, b) => (b.mutualFit - a.mutualFit) || b.edgePct - a.edgePct);
    const seenGive = new Set();
    const seenGet = new Set();
    const deduped = [];
    for (const s of suggestions) {
      if (seenGive.has(s.givePid) || seenGet.has(s.getPid)) continue;
      seenGive.add(s.givePid);
      seenGet.add(s.getPid);
      deduped.push(s);
    }
    return deduped.slice(0, 8);
  }

  function renderTradeSuggestions() {
    const wrap = el("trade-suggestions");
    if (!wrap) return;
    if (!DATA.tradeValuesLoaded) {
      wrap.innerHTML = "";
      return;
    }
    if (DATA.tradeValuesFailed) {
      wrap.innerHTML = `<div class="empty-state">Suggestions need real trade values, which failed to load — see the status above.</div>`;
      return;
    }
    const suggestions = computeTradeSuggestions();
    if (!suggestions.length) {
      wrap.innerHTML = `<div class="empty-state">No trade currently favors you — either no other team has surplus at a position you need, or the value math doesn't come out ahead right now.</div>`;
      return;
    }
    wrap.innerHTML = suggestions
      .map((s, idx) => {
        const reason = s.mutualFit
          ? `You're thin at ${escapeHtml(s.getInfo.p)}; they're deep there but thin at ${escapeHtml(s.giveInfo.p)} — a real need fit for both sides.`
          : `You're thin at ${escapeHtml(s.getInfo.p)} and they have surplus depth there, though it's less of a need for them — may take convincing.`;
        return `<div class="suggestion-card">
          <div class="suggestion-body">
            <div class="trade-suggestion-team">vs ${escapeHtml(s.teamName)}</div>
            <div class="trade-suggestion-swap">
              <div><span class="sit">You give</span> ${escapeHtml(s.giveInfo.n)} (${escapeHtml(s.giveInfo.p)}${s.giveInfo.t ? " · " + escapeHtml(s.giveInfo.t) : ""}, ${s.giveValue.toLocaleString()})</div>
              <div><span class="start">You get</span> ${escapeHtml(s.getInfo.n)} (${escapeHtml(s.getInfo.p)}${s.getInfo.t ? " · " + escapeHtml(s.getInfo.t) : ""}, ${s.getValue.toLocaleString()})</div>
            </div>
            <div class="trade-suggestion-edge">+${s.edge.toLocaleString()} value in your favor (${Math.round(s.edgePct * 100)}%)</div>
            <div class="suggestion-reason">${reason}</div>
            <button class="trade-suggestion-load" data-idx="${idx}">Load into builder</button>
          </div>
        </div>`;
      })
      .join("");
    wrap.querySelectorAll(".trade-suggestion-load").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = suggestions[Number(btn.getAttribute("data-idx"))];
        if (!s) return;
        DATA.trade.give = [s.givePid];
        DATA.trade.get = [s.getPid];
        renderTradeCheck();
        el("trade-give-list").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
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
    renderAvailablePlayers();
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
    initMatchupDetail();
    initWaiverFilter();
    refreshCycle();
    setInterval(refreshCycle, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshCycle();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
