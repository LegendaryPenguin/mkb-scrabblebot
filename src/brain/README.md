# The brain: K-13's strategy

`createAgent({ params?, mode?, seed?, model? })` in `index.ts` returns the
`palace` agent (`agent.ts`; 'palace' is the strategy's internal id, after
the method of loci). Every number it decides with is a field of
`Params` (`params.ts`): defaults, then `data/params.json`, then
`opts.params`. `mode: 'sim'` never reads the clock (fixed sample counts, so a
seed replays exactly); `mode: 'live'` samples against time budgets.

## How a round is decided

1. **Belief** (`belief.ts`). From the public history: every auctioned letter
   (won or discarded: unsold tiles are thrown away, not returned), my own
   starting rack (rack + played - bought), and each opponent's revealed
   starting tiles (letters it played more often than it bought). The
   *unseen pool* is the bag plus everyone's unrevealed starting tiles;
   future auction letters are draws from it. Each opponent's rack size is
   exact; the letters it bought and hasn't played are a known lower bound.
2. **Letter values by simulated futures** (`value.ts`). V(rack) = E[P(rack + F)],
   where F is the k tiles I expect to buy from here on, drawn from the
   unseen pool, and P is the points of the best partition of those tiles
   into words (approximate: best of the top-12 first words, then greedy;
   1-2% under the exact partition at 12-16 tiles and 5-10x faster). A
   letter's value is V(rack + L) - V(rack), with the same draws on both
   sides (common random numbers). Samples live as long as the rack does and
   accumulate across auctions; letter values are computed lazily (the lambda
   solve needs letters that can still come up, the bid needs the letter on
   the block, the play decision needs none). k is what my budget buys at the
   projected price, capped at half the useful auctions left and at `kMax`.
3. **Coins are not points: lambda** (`market.ts`). lambda is the shadow price
   of a coin in points. It is solved each round so that bidding value/lambda
   on every useful future auction (each letter weighted by its expected
   count, against the predicted highest competing bid at a typical future
   phase) spends exactly my budget: balance plus the share of my expected
   points that comes back as coins in time to be spent (`incomeShare`). As
   the bag empties there is nothing left to spend on, so lambda falls to
   `lambdaMin` and bids rise to the balance: leftover coins are worthless.
   Two traps found in testing and fixed: (a) capping projected bids at
   today's balance made a broke bot look like coins were worthless to it
   (it couldn't win anything at any lambda) when they are precious; (b)
   deriving k from projected wins created a fixed point at k = 0 (an empty
   rack values every letter at 0 when it imagines no future tiles, so it
   projects no wins).
4. **The last tile** is worthless to a live bot (the match ends at its
   close): bid 0, except bid the whole balance when a sim is seated, since a
   sim could still play it inside the close and coins are worthless then
   (free denial). The second-to-last tile is valued with no future tiles
   (k = 0), i.e. only for what it completes in the final window, and
   `chooseWords` dumps the exact best partition (`bestPartition`) when the
   last auction is open.
5. **Play vs hold** (`agent.ts`, `bestPlay`). For each candidate word w (top
   8 by reward) compare, on the same futures F_s, playing now,
   r(w) * (1 + coinBonus * lambda) + E[P(rack - w + F)], with holding,
   E[P(rack + F)] (which keeps the option of playing w later, possibly
   extended), and play only if it wins by `playMargin`. The coins a word
   earns now buy tiles, which is what `coinBonus * lambda` prices. Repeated on
   what's left, up to 3 words per call.
6. **Opponents** (`market.ts`, `bid.ts`). Each seated opponent's bid
   distribution comes from the opponent model (src/memory/model.ts; exact
   formula for sims; a generic market guess if no model), corrected in-match
   by a multiplicative calibration learned from where observed prices fall
   in the predicted distribution (mid-PIT; `calibRate`). The bid maximises
   expected utility over every possible bid b:
   U(b) = E[my surplus | b] + sum_o w_o * lambda * (o's surplus at b=0 - at b),
   where my surplus is value - lambda * price when I win and o's surplus is
   its Vickrey margin (its bid minus what it pays). My bid cuts a rival's
   surplus by denial (I win instead) or price-driving (it pays my bid
   instead of the next one). Without rivals this is the truthful Vickrey bid
   value/lambda; the rival term can only raise it, by at most `maxOverbid`.
7. **Finishing place** (`place.ts`). Ratings use finishing order. With the
   final gap to rival o roughly normal, a point to rival o costs w_o =
   f_o / sum f of one of my points (f_o = density of the gap at 0): rivals
   near my score matter, distant ones don't, and the weight concentrates as
   the match runs out. The same picture gives a variance preference (`tilt`,
   > 0 when trailing) applied to play-vs-hold through `riskCoef`.
8. **FirstPrice**: the same search pays b instead of the runner-up's bid,
   which shades the bid against the distribution of the highest competing
   bid; the rival term is off.

## More thinking time (compute vs strength)

Measured with `src/brain/eval.ts --settings table
--table clone:59,clone:22,clone:67,clone:60,clone:120 --seed 1` (6 seats: K-13
against five calibrated clones of real ladder bots; same deals for every
level, so differences are paired by deal; 95% intervals). Sim mode, so these
are sample counts, not time.

| level | variant | deals | mean place | win rate | score | Δplace vs x1 | Δscore vs x1 | ms/match |
|---|---|---|---|---|---|---|---|---|
| x1 | defaults | 600 | 1.160 | 88.4% | 108.4 | - | - | 677 |
| x4 | quick/refine/max/play samples and play candidates x4 | 600 | 1.117 | 90.9% | 110.4 | -0.043 ±0.046 | +2.0 ±1.8 | 3426 |
| x16 | the same x16 | 600 | 1.125 | 90.3% | 111.6 | -0.035 ±0.046 | +3.1 ±1.8 | 17896 |
| b4 | bids only: refineSamplesSim 32, maxSamples 384 | 600 | 1.143 | 88.7% | 109.2 | -0.018 ±0.048 | +0.7 ±1.8 | 2081 |
| p4 | play only: playSamples 96, playCandidates 32 | 600 | 1.146 | 88.2% | 108.3 | -0.014 ±0.048 | -0.1 ±1.8 | 2700 |
| L1 | live analog of liveCompute 1: refineSamplesSim 96 (the table is full at every refine, as in live) | 300 | 1.017 | 98.7% | 153.9 | -0.145 ±0.058 | +45.1 ±3.1 | 2482 |
| L4 | live analog of liveCompute 4: refineSamplesSim 384, maxSamples 384 | 300 | 1.037 | 97.3% | 154.0 | vs L1: +0.020 ±0.031 | vs L1: +0.1 ±2.9 | 7125 |

Reading: scaling everything raises the score by 2-3 points per match (x16 vs
x4: +1.2 ±1.6, flattening), but no level moves mean place or win rate
significantly (these tables are near the ceiling: 88% wins at x1). Neither
half alone (b4: bids, p4: play) shows a significant effect.

The live question is L4 vs L1, and the answer is no: in live mode the
letter table already holds maxSamples = 96 when refineBid answers (dry run
below: refine p99 108 ms, it stops at 96 well inside the budget), and 4x that
changes nothing (+0.1 ±2.9 points, place +0.02 ±0.03). The x-levels gain only
because sim mode at the defaults is starved: refineSamplesSim 8 adds 8
samples per auction while samples age out after 6 rounds and the table
restarts with every rack change, so sim bids from far fewer samples than
live does. **Caution for anyone evaluating or tuning in sim:** L1 (same
agent, table filled like live) scores 45 points more than x1 on the same
deals, so sim results at the default refineSamplesSim 8 do not represent
live play, and data/params.json was tuned in that starved regime. Evaluate
with `--variant 'name={"refineSamplesSim":96}'` (3.7x slower) to match live.

Decision: `liveCompute` (live mode only: refineBid samples by time up to
maxSamples x liveCompute; sim ignores it and replays exactly, see
agent.test.ts) stays **1 = off** by default. Turn it on for a run with
`K13_PARAMS='{"liveCompute":16}'` (or in data/params.json).

Timing (live dry runs against maincloud, anonymous, `src/bot.ts --dry-run`,
~3 minutes each, while evals ran niced on the same machine):

| config | auctions | wouldMiss | refine p50 / p99 / max (ms) | refine budget p10 / p50 (ms) | min slack after refine (ms) | quick p99 (ms) |
|---|---|---|---|---|---|---|
| defaults (liveCompute 1) | 186 | 0 | 0.8 / 108.3 / 141.2 | 550.6 / 561.9 | 507.7 | 8.3 |
| liveCompute 16 | 182 | 0 | 1.8 / 566.4 / 569.4 | 562.5 / 574.8 | 262.3 | 8.8 |

With liveCompute 16 refine uses the whole budget and still finishes inside it
(refineMarginMs leaves room for the final solve); the quick bid is sent first
and never waits on refine.

## Tournament

Server rules: upstream `spacetimedb/src/tournament.ts`. Swiss
rounds (Swiss points = max(matchSize - place, 0), total score breaks ties;
`tableSizes(n, matchSize)` seats 7-11 entrants at ONE table), then a bracket
where all survivors share one table and the last place goes out each match,
then a 3-game heads-up final decided by total score. No sims in any
tournament match.

Two params, both in `params.ts` (data/params.json does not set them).
"v2" below is the 6-seat-tuned strategy (defaults plus data/params.json)
with both of them off:

| param | default | what it does |
|---|---|---|
| `lambdaScaleBig` / `bigTableSeats` | **0.8 / 7 (ON)** | At tables of 7+ seats the solved lambda is multiplied by 0.8 instead of `lambdaScale` 1.08. Gated on seat count, not on `view.tournament`, so it works even when the live session does not deliver the tournament context. The ladder (6 seats) is unchanged. |
| `stageAware` | **0 (OFF)** | When `view.tournament` is set, rival weights come from `tournament.ts` `stageView` (Swiss: expected Swiss points; Bracket: P(not last); Final: series total) instead of `placeView`. Without `view.tournament` it does nothing. |

`agent.ts` picks the lambda scale in `solve()` and swaps `placeView` for
`stageView` there; `stage.test.ts` checks that a 6-seat match without
`view.tournament` replays identically with both flags set, that stage-aware
Swiss and Bracket matches are legal and error-free, and the seat gate.

### Evidence

Measured with `src/sim/tournament.ts` (view.tournament
set for every seat, standings level), sim mode at the default
`refineSamplesSim` 8 unless marked L. Opponents are calibrated clones
(`data/clones.json`, bidShift -0.3) of the most likely entrants by
`data/field.json`: `clone:77,22,59,23,85,52,120,20,26,107`, the first n-1 for
an n-seat table. 8 shards (seeds 7001-7008) x 50 matches = 400 matches per
arm; every arm plays the same deals, so the deltas are paired by (seed,
match). ± is a 95% interval. 0 agent exceptions, 0 refused bids and 0
refused words in every arm.

**lambdaScaleBig (big tables)** - base is v2 (`lambdaScaleBig` 0):

| table | base place / Swiss pts / last % | lambdaScaleBig 0.8 | Δplace | ΔSwiss points | Δscore |
|---|---|---|---|---|---|
| 11 seats, Swiss size 6 | 3.66 / 3.62 / 0.8 | 1.85 / 5.16 / 0.0 | -1.82 ±0.25 | +1.54 ±0.21 | +12.7 ±1.4 |
| 11 seats, FirstPrice | 4.62 / 2.92 / 3.2 | 2.64 / 4.43 / 0.0 | -1.98 ±0.28 | +1.51 ±0.22 | +9.8 ±1.3 |
| 10 seats | 3.44 / 3.74 / 2.5 | 2.01 / 5.01 / 0.0 | -1.43 ±0.25 | +1.27 ±0.22 | +12.1 ±1.5 |
| 9 seats | 3.38 / 3.75 / 3.8 | 1.95 / 5.06 / 0.0 | -1.43 ±0.22 | +1.31 ±0.20 | +12.0 ±1.5 |
| 8 seats (also the Bracket at 8: last place) | 2.78 / 4.25 / 3.5 | 1.88 / 5.12 / 0.0 | -0.90 ±0.19 | +0.87 ±0.18 | +8.8 ±1.5 |
| 7 seats, Swiss size 6 | 2.00 / 5.00 / 2.2 | 1.71 / 5.29 / 0.2 | -0.29 ±0.15 | +0.29 ±0.15 | +3.1 ±1.8 |
| 11 seats, rack 7 (21 auctions) | 2.42 / 4.63 / 0.0 | 1.59 / 5.42 / 0.0 | -0.83 ±0.16 | +0.79 ±0.15 | +8.6 ±1.2 |
| 11 seats, live analog (L: `refineSamplesSim` 96, the table filled as live) | 3.58 / 3.64 / 0.8 | 1.86 / 5.15 / 0.0 | -1.72 ±0.24 | +1.51 ±0.21 | +13.3 ±1.4 |
| 6 seats, Swiss size 6 (threshold 6: NOT shipped) | 1.36 / 5.64 / 0.2 | 1.48 / 5.52 / 0.8 | **+0.12 ±0.11** | -0.12 ±0.11 | -5.9 ±2.8 |
| 6 seats, FirstPrice (threshold 6: NOT shipped) | 1.07 / 5.93 / 0.0 | 1.14 / 5.86 / 0.8 | +0.07 ±0.07 | -0.07 ±0.07 | -4.7 ±3.5 |

Value sweep at 11 seats (same deals): 0.7 gives place 1.72 (Δ -1.95 ±0.26),
0.8 gives 1.85, 0.9 gives 2.29 (Δ -1.38 ±0.25). 0.7 is a little better than
0.8 there, within the noise; 0.8 is kept because it is the value with
evidence at every size from 7 to 11, and earlier experiments found 0.6
harmful at 8 seats and 0.8 harmful heads-up against uncalibrated clones.
Why it works: with 7+ bots the market clears at 25-40 a tile from the start,
the 6-seat-tuned lambda kept K-13 waiting for bargains that never came, and
it ended with the most unspent coins at the table.

**stageAware (stage objectives)** - base is v2 (`stageAware` 0), same deals:

| setting | base | stageAware 1 | Δplace | Δscore | verdict |
|---|---|---|---|---|---|
| Bracket, 4 seats (`clone:77,22,59`) | place 1.020, last 0.0%, score 202.7 | place 1.040, last 0.0%, score 198.2 | +0.020 ±0.021 | -4.5 ±2.4 | no survival gain, costs score |
| Bracket, 6 seats | place 1.360, last 0.2%, score 115.7 | place 1.442, last 0.2%, score 112.0 | +0.083 ±0.056 | -3.7 ±1.6 | worse |
| Bracket, 8 seats | place 2.783, last 3.5%, score 65.5 | identical (215/400 matches identical) | +0.000 ±0.079 | +0.0 ±0.7 | neutral |
| Swiss, 6 seats (size 6) | Swiss pts 5.640, score 115.7 | 5.640, 115.7 | +0.000 ±0.037 | +0.0 ±0.8 | neutral |
| Swiss, 7 seats (size 6) | Swiss pts 5.003, last 2.2% | 5.015, last 1.5% | -0.013 ±0.032 | +0.2 ±0.5 | neutral |
| Swiss, 6 seats FirstPrice | Swiss pts 5.933 | identical in 400/400 | 0 | 0 | inert (the rival term is off in FirstPrice) |
| Swiss, 11 seats, both arms with lambdaScaleBig 0.8 | place 1.845, Swiss pts 5.162 | place 1.865, Swiss pts 5.143 | +0.020 ±0.028 | -0.2 ±0.2 | neutral |
| Final, 3-game series vs `clone:22/77/59/85` (136 series, 408 games) | 136/136 series won, margin +752 ±29 (min +280) | identical in 408/408 games | 0 | 0 | inert |

Decision: **stageAware stays OFF**. It never improved survival or Swiss
points, and in the Bracket it gives up 4 points of score (the tiebreak for a
tie at last place) by fading the rival term once K-13 looks safe. In the Final
it is provably inert while `riskCoef` is 0: heads-up, `placeView` already
weighs the one rival's points 1:1 against mine (maximise my margin, which is
what the series total rewards), and the series lead only moves `tilt`, which
only `riskCoef` reads. Heads-up K-13 won every series against the top clones
(a FINAL_GAMES-game series is 3 x 88 auctions), so the Final is not where the
simulator shows a weakness; the earlier self-play finding (K-13 vs K-13
games snowball, margins 144-330) says the real Final will be decided by early
tempo, which no param here changes.

So the threshold sits where the sign changes: 0.8 helps from 7 seats up and
hurts at 6, which is why `bigTableSeats` is 7 and the 6-seat ladder (and a
6-seat Swiss table) keeps v2's lambda exactly. A live-mode check of the
shipped defaults at 11 seats (`--live --budget 700`, 3 matches, nice 15):
quickBid at most 2.8 ms, refineBid at most 103 ms, chooseWords at most 40 ms,
0 over budget, 0 errors.

**Caveats.** All of this is against clones. Calibration found the
simulated field still too easy for v2 at 6 seats (sim place 1.1-1.3 vs 2.81
live), because clones overspend early and leave cheap tiles late. That bias
favours a thrifty K-13, so the real-play case for spending earlier at big
tables is, if anything, stronger. Absolute numbers (wins, margins) are
optimistic; the paired deltas are the signal.

The live session fills `view.tournament` for tournament matches
(`src/live/session.ts`, `tournamentFor`: stage, round, standings, and in the
Final the running totals of the earlier games). `lambdaScaleBig` does not
need it; `stageAware` would use it, but it is off.

Re-run an arm (one process per shard; run several in parallel and pair the
results by (seed, match)):

```
npx tsx src/sim/tournament.ts --table palace,clone:77,clone:22,clone:59,clone:23,clone:85,clone:52,clone:120,clone:20,clone:26,clone:107 \
  --stage Swiss --match-size 6 --games 50 --seed 7001 --params '{"lambdaScaleBig":0}' --out base.7001.json
npx tsx src/sim/tournament.ts --table palace,clone:77,clone:22,clone:59,clone:23,clone:85,clone:52,clone:120,clone:20,clone:26,clone:107 \
  --stage Swiss --match-size 6 --games 50 --seed 7001 --out big.7001.json
```
