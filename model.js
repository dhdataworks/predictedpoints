/* ---------------------------------------------------------------
   model.js — predicted points engine

   Everything here is deterministic and inspectable. Given a player's
   per-90 underlying numbers from last season, it rebuilds an expected
   FPL score using the 2026/27 scoring rules, then scales that by how
   many minutes the player is expected to get.

   No randomness, no external calls.
   --------------------------------------------------------------- */

const POS_NAME = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

/* 2026/27 scoring, taken from the FPL game settings */
const RULES = {
  appearance60: 2,
  goal: { 1: 10, 2: 6, 3: 5, 4: 4 },
  assist: 3,
  cleanSheet: { 1: 4, 2: 4, 3: 1, 4: 0 },
  concededPer2: { 1: -1, 2: -1, 3: 0, 4: 0 },
  savesPer3: { 1: 1, 2: 0, 3: 0, 4: 0 },
  defensiveContribution: { 1: 0, 2: 2, 3: 2, 4: 2 },
  defconThreshold: { 1: null, 2: 10, 3: 12, 4: 12 },
  yellow: -1
};

const MINUTES_IN_SEASON = 38 * 90;

/* --- small maths helpers ------------------------------------- */

function poissonAtLeast(lambda, k) {
  if (lambda <= 0) return 0;
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cumulative = term;
  for (let i = 1; i < k; i++) {
    term = (term * lambda) / i;
    cumulative += term;
  }
  return Math.max(0, Math.min(1, 1 - cumulative));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const per90 = (total, minutes) => (minutes > 0 ? (total * 90) / minutes : 0);

/* --- team and fixture context -------------------------------- */

/* Strength runs 1 (weakest) to 5 (strongest); 3 is the league midpoint. */
function teamStrength(team) {
  if (!team) return 3;
  return ((team.sh ?? 3) + (team.sa ?? 3)) / 2;
}

/* Average fixture difficulty over the next N gameweeks, plus a count
   of how many matches the team actually plays (blanks and doubles). */
function fixtureOutlook(fixtures, teamId, horizon) {
  const list = (fixtures.byTeam && fixtures.byTeam[String(teamId)]) || [];
  const upcoming = list.filter((f) => f.gw < (fixtures.next_gw ?? 1) + horizon);
  if (!upcoming.length) {
    return { avgDifficulty: 3, matches: horizon, hasData: false, list: [] };
  }
  const total = upcoming.reduce((sum, f) => sum + (f.diff ?? 3), 0);
  return {
    avgDifficulty: total / upcoming.length,
    matches: upcoming.length,
    hasData: true,
    list: upcoming
  };
}

/* --- the per-90 expected score ------------------------------- */

/*
   Returns a breakdown object in points per 90 minutes played.
   `ctx` carries the team strength and fixture multipliers.
*/
function expectedPointsPer90(p, ctx) {
  const pos = p.p;
  const mins = p.mn || 0;

  /* Attacking rates. xG and xA are the signal; actual output gets a
     small weight so finishers aren't punished, and only once there's
     enough of a sample to mean anything. */
  const sampleWeight = clamp(mins / 1200, 0, 1) * 0.3;
  const goals90 = p.xg * (1 - sampleWeight) + per90(p.g, mins) * sampleWeight;
  const assists90 = p.xa * (1 - sampleWeight) + per90(p.a, mins) * sampleWeight;

  /* Team and fixture adjustment. Attacking output scales with how good
     the side is and how kind the run of games looks. */
  const attackMult = ctx.attackMult;
  const concededMult = ctx.concededMult;

  const goalPts = goals90 * attackMult * RULES.goal[pos];
  const assistPts = assists90 * attackMult * RULES.assist;

  /* Clean sheets from expected goals conceded, via Poisson. */
  const xgc90 = (p.xgc || 0) * concededMult;
  const csProbability = xgc90 > 0 ? Math.exp(-xgc90) : 0;
  const csPts = csProbability * RULES.cleanSheet[pos];

  /* Goals conceded costs a point per two, so the expected hit is
     half the expected goals against while the player is on the pitch. */
  const concededPts = (RULES.concededPer2[pos] * xgc90) / 2;

  /* Saves, goalkeepers only: a point per three. A busier keeper behind
     a leakier defence saves more, so this rides on xGC too. */
  const savesPts =
    pos === 1 ? ((p.sv90 || 0) * concededMult * RULES.savesPer3[1]) / 3 : 0;

  /* Defensive contribution: 2 points for clearing the threshold.
     Model the count as Poisson around the player's per-90 rate. */
  const threshold = RULES.defconThreshold[pos];
  const defconProbability = threshold
    ? poissonAtLeast((p.dc || 0) * concededMult, threshold)
    : 0;
  const defconPts = defconProbability * RULES.defensiveContribution[pos];

  /* Bonus and cards come straight from last season's rates. */
  const bonusPts = per90(p.bo, mins);
  const cardPts = per90(p.yc, mins) * RULES.yellow;

  const appearancePts = RULES.appearance60;

  const total =
    appearancePts +
    goalPts +
    assistPts +
    csPts +
    concededPts +
    savesPts +
    defconPts +
    bonusPts +
    cardPts;

  return {
    total: Math.max(0, total),
    parts: {
      appearance: appearancePts,
      goals: goalPts,
      assists: assistPts,
      cleanSheet: csPts,
      conceded: concededPts,
      saves: savesPts,
      defcon: defconPts,
      bonus: bonusPts,
      cards: cardPts
    },
    csProbability,
    defconProbability,
    goals90: goals90 * attackMult,
    assists90: assists90 * attackMult
  };
}

/* --- minutes ------------------------------------------------- */

/*
   modes:
     "last"    use last season's minutes per game
     "starter" assume a nailed 90 every week
     "blend"   halfway between the two, which flatters returning players
*/
function expectedMinutesPerMatch(p, mode) {
  const lastSeason = clamp((p.mn || 0) / 38, 0, 90);
  if (mode === "starter") return 90;
  if (mode === "blend") return clamp((lastSeason + 90) / 2, 0, 90);
  return lastSeason;
}

/* Availability. Injured or suspended players are discounted, not hidden. */
function availability(p) {
  if (p.s === "a") return 1;
  if (p.ch === null || p.ch === undefined) return p.s === "d" ? 0.75 : 0;
  return clamp(p.ch / 100, 0, 1);
}

/* --- price baseline for players with no Premier League record ---
   New signings from abroad have no per-90 data, so their model score
   would be zero. Instead, take the median points-per-90 of players in
   the same position and price bracket who do have a record. */

function buildPriceBaseline(rated) {
  const buckets = new Map();
  rated.forEach((r) => {
    const key = `${r.player.p}:${Math.round(r.player.c / 10)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r.xp90);
  });
  const medians = new Map();
  buckets.forEach((values, key) => {
    values.sort((a, b) => a - b);
    medians.set(key, values[Math.floor(values.length / 2)]);
  });
  return (player) => {
    const exact = medians.get(`${player.p}:${Math.round(player.c / 10)}`);
    if (exact !== undefined) return exact;
    /* Fall back to the nearest priced bucket in the same position. */
    let best = null;
    let bestGap = Infinity;
    medians.forEach((value, key) => {
      const [pos, price] = key.split(":").map(Number);
      if (pos !== player.p) return;
      const gap = Math.abs(price - player.c / 10);
      if (gap < bestGap) {
        bestGap = gap;
        best = value;
      }
    });
    return best ?? 2;
  };
}

/* --- top level ----------------------------------------------- */

/*
   project(dataset, options) -> array of rows, one per player.

   options:
     horizon      number of upcoming gameweeks to project (1-38)
     minutesMode  "last" | "blend" | "starter"
     fixtureWeight  0-1, how much fixture difficulty moves the numbers
*/
function project(dataset, options) {
  const { players, teams, fixtures } = dataset;
  const horizon = clamp(options.horizon ?? 6, 1, 38);
  const minutesMode = options.minutesMode ?? "last";
  const fixtureWeight = clamp(options.fixtureWeight ?? 1, 0, 1);

  const teamById = new Map(teams.map((t) => [t.id, t]));

  /* Context per team: strength and fixture run. */
  const contextByTeam = new Map();
  teams.forEach((team) => {
    const strength = teamStrength(team);
    const outlook = fixtureOutlook(fixtures, team.id, horizon);
    const difficultyShift = (3 - outlook.avgDifficulty) * fixtureWeight;

    contextByTeam.set(team.id, {
      strength,
      outlook,
      /* Easier games mean more attacking returns. Team strength gets only
         half weight: a player's own per-90 rates already carry his club's
         quality, so a bigger nudge here would count it twice. The residual
         exists to catch players who have changed clubs. */
      attackMult: 1 + 0.06 * (strength - 3) + 0.08 * difficultyShift,
      /* Easier games and a better side mean fewer goals against. */
      concededMult: clamp(1 - 0.06 * (strength - 3) - 0.09 * difficultyShift, 0.4, 1.8)
    });
  });

  const defaultContext = {
    strength: 3,
    outlook: { avgDifficulty: 3, matches: horizon, hasData: false, list: [] },
    attackMult: 1,
    concededMult: 1
  };

  /* First pass: everyone with a real minutes record. Even a handful of
     minutes counts — the rates will be noisy, but the minutes scaling
     below shrinks those players to near nothing anyway, which is the
     right answer for a squad player. */
  const rows = players.map((player) => {
    const ctx = contextByTeam.get(player.t) || defaultContext;
    const hasRecord = (player.mn || 0) > 0;
    const model = expectedPointsPer90(player, ctx);
    return { player, ctx, hasRecord, model, xp90: model.total };
  });

  /* Second pass: fill in the players with no record from price. */
  const baselineFor = buildPriceBaseline(rows.filter((r) => r.hasRecord));

  return rows.map((row) => {
    const { player, ctx } = row;
    const estimated = !row.hasRecord;
    const xp90 = estimated ? baselineFor(player) : row.xp90;

    /* For a player with no minutes on record there is nothing to scale,
       so lean on ownership as a rough proxy for how nailed the community
       thinks he is: a barely-owned third-choice keeper lands near 25
       minutes a match, a heavily-backed new signing near 70. */
    const ownershipMinutes = 25 + 45 * clamp((player.sel || 0) / 6, 0, 1);
    const minutesPerMatch = estimated
      ? minutesMode === "last"
        ? ownershipMinutes
        : minutesMode === "starter"
        ? 90
        : clamp((ownershipMinutes + 90) / 2, 0, 90)
      : expectedMinutesPerMatch(player, minutesMode);

    const avail = availability(player);
    const matches = ctx.outlook.matches;
    const perMatch = xp90 * (minutesPerMatch / 90) * avail;
    const horizonPoints = perMatch * matches;
    const seasonPoints = perMatch * 38;
    const price = player.c / 10;

    return {
      id: player.i,
      name: player.n,
      fullName: player.fn,
      team: teamById.get(player.t) || { short: "???", name: "Unknown" },
      position: POS_NAME[player.p],
      positionId: player.p,
      price,
      status: player.s,
      news: player.nw,
      availability: avail,
      estimated,
      penaltyOrder: player.pen,
      selectedBy: player.sel,
      lastSeasonPoints: player.tp,
      minutesPerMatch,
      matches,
      avgDifficulty: ctx.outlook.avgDifficulty,
      fixtures: ctx.outlook.list,
      hasFixtures: ctx.outlook.hasData,
      xp90,
      perMatch,
      horizonPoints,
      seasonPoints,
      valuePerMillion: price > 0 ? horizonPoints / price : 0,
      breakdown: estimated ? null : row.model,
      raw: player
    };
  });
}

window.FPLModel = { project, POS_NAME, RULES, expectedPointsPer90 };
