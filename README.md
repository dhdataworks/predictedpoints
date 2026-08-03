# Predicted Points — FPL 2026/27

A static dashboard that projects expected points for every Fantasy Premier League
player. No server, no build step, no dependencies — plain HTML, CSS and JavaScript
reading three JSON files.

## Getting it running

**Nothing needs installing on your machine.** The repo ships with a small seed dataset
(two clubs) so the page renders immediately, and GitHub fills in the rest.

1. Push the repo to GitHub.
2. **Settings → Actions → General → Workflow permissions → Read and write.** Without
   this the data refresh can't commit its results.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch
   `main`, folder `/ (root)`.
4. Check the **Actions** tab. The first run pulls all ~560 players and commits the data
   files. The site appears at `https://<username>.github.io/<repo>/`.

The workflow at `.github/workflows/update-data.yml` re-runs every morning at 06:15 UTC,
so prices, injuries and fixture difficulty stay current without you touching anything.
You can also trigger it by hand from the Actions tab.

### Previewing locally (optional)

Browsers block `fetch` on `file://` URLs, so double-clicking `index.html` won't work —
it needs serving. Any of these will do:

- VS Code's **Live Server** extension (nothing to install beyond the extension)
- `npx serve` if you have Node
- `python -m http.server 8000` if you have Python

### Refreshing the data by hand (optional)

If you'd rather not wait for the scheduled run, `fetch_fpl_data.py` does the
same job locally. It's standard library only, so Python 3 is the sole requirement — but
you never need it if you're happy letting the Action do the work.

## How the projection works

The number in the right-hand column is not last season's points total scaled up. It's
rebuilt from scratch using the 2026/27 scoring rules.

**Per 90 minutes played:**

| Component | Source |
|---|---|
| Appearance | flat 2 points |
| Goals | expected goals per 90, weighted 70–100% against actual output depending on sample size, times 10/6/5/4 by position |
| Assists | expected assists per 90 × 3 |
| Clean sheet | Poisson probability of zero conceded from expected goals conceded per 90, × 4/4/1/0 |
| Goals conceded | −0.5 × expected goals conceded per 90, for keepers and defenders |
| Saves | saves per 90 ÷ 3, keepers only |
| Defensive contribution | Poisson probability of reaching 10 actions (DEF) or 12 (MID/FWD) × 2 |
| Bonus | last season's bonus per 90 |
| Cards | last season's yellows per 90 × −1 |

**Then scaled by:**

- **Team strength.** ±6% per point of team strength either side of the league midpoint,
  with expected goals conceded moving the opposite way. Deliberately light: a player's
  own per-90 rates already carry his club's quality, so a bigger nudge here would count
  it twice. What's left is there to catch players who have changed clubs.
- **Fixtures.** Average difficulty over the window you've selected shifts attacking
  output by ±8% and clean sheet chances by ±9% per point of difficulty. This one is
  applied at full weight, because it's genuinely forward-looking and isn't baked into
  last season's numbers.
- **Minutes.** Last season's minutes per game by default, or you can assume everyone
  starts and plays 90.
- **Availability.** Injured and suspended players are discounted by their reported
  chance of playing, not hidden.

**Players with no Premier League minutes at all** — new signings from abroad — have no
per-90 data to work from. They're marked `est`, given the median per-90 score for their
position and price bracket, and assigned minutes based on how heavily owned they are,
which is a rough proxy for whether managers expect them to start. Treat those rows as a
placeholder rather than a projection.

Players with a handful of minutes are *not* treated this way. Their per-90 rates are
noisy, but the minutes scaling shrinks them to almost nothing, which is the right answer
for a squad player.

### Known limitations

- A player who changed clubs carries his old side's defensive numbers, so his clean
  sheet and conceded terms describe last season's team, not this one.
- Penalty duties are flagged in the table but not modelled. If a player has just
  inherited the spot kicks, the projection is understated.
- Bonus is a historical rate, not a BPS simulation.
- Fixture difficulty is FPL's own 1–5 rating, which is coarse.

## Files

```
index.html                         markup
styles.css                         styling
model.js                           the projection engine
app.js                             filtering, sorting, rendering
players.json                       per-player stats
teams.json                         clubs and strength ratings
fixtures.json                      upcoming fixtures and difficulty by team
fetch_fpl_data.py                  pulls all three from the FPL API
.github/workflows/update-data.yml  daily refresh
```

## Adjusting the model

Everything lives in `model.js`. The scoring constants are in `RULES`, the strength and
fixture multipliers are in `project()`, and the per-90 assembly is in
`expectedPointsPer90()`. Change a coefficient, reload the page, see the ranking move.

---

Built with the public Fantasy Premier League API. Not affiliated with the Premier League.
