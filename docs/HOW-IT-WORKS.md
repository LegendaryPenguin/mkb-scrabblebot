# How K-13 works: one auction, step by step

This page follows K-13 through a single auction: what it sees, how it values the letter, how it picks a bid, what happens when it wins, and how it decides whether to play a word now or wait. It ends with the last moments of a match, where the rules change the right move.

Back to the [README](../README.md). The formulas and the evidence behind every setting are in [`src/brain/README.md`](../src/brain/README.md).

---

## The rules that matter here

From [`src/core/rules.ts`](../src/core/rules.ts), which mirrors the server:

- Every bot starts with **100 coins** and **5 hidden tiles** from a 98-tile bag.
- One letter is auctioned at a time, with **1 second** to bid. Bids are sealed.
- **Vickrey** (the default): the highest bid wins and pays the **second-highest** bid. A lone bidder pays 1. Ties are broken at random. A letter nobody bids on is discarded.
- A word scores the sum of its letter values (standard Scrabble values: A = 1, H = 4, Q = 10, ...) times a length multiplier, rounded down:

| Word length | 2–3 | 4 | 5 | 6 | 7+ |
|---|---|---|---|---|---|
| Multiplier | 1x | 1.5x | 2x | 2.5x | **3x** |

- The reward goes to **both** score and coins, so a word also funds future bids.
- The match ends the instant the bag is empty. A live bot cannot play after that, so leftover tiles and leftover coins are worth nothing.

---

## 1. The auction opens: what K-13 sees

Everything K-13 knows comes from public tables it subscribes to, plus its own rack:

| K-13 can see | K-13 cannot see |
|---|---|
| The letter on the block and when the auction closes | Anyone's bid in the current auction |
| Its own rack and balance | Other bots' starting tiles (until they play them) |
| Every seat's score, balance and rack size | Which letters are left in the bag, exactly |
| Every past auction: letter, winner, price paid | |
| Every word played so far | |
| After a match ends: the winning bid of each auction (public archive) | |

It never reads `visible_auction_top_bids`, the live top-bid view the game hides from bots. See [Fair play](../README.md#fair-play).

**Belief about hidden tiles** ([`src/brain/belief.ts`](../src/brain/belief.ts)). K-13 starts from the full bag, removes every letter that has been auctioned, removes its own tiles, and removes any opponent starting tile that a word has revealed (a bot that plays two Es after buying one must have started with one). What is left is the *unseen pool*: the bag plus everyone's unrevealed starting tiles. Future auction letters are draws from this pool.

**A quick bid goes out at once** ([`src/live/bidder.ts`](../src/live/bidder.ts)). Within a few milliseconds K-13 sends a fast estimate. If anything goes wrong later in the second, that bid still stands, because the server keeps only the latest bid from each bot.

---

## 2. How much is this letter worth?

A letter is worth what it adds to K-13's **final** words, not to the word it could play right now. K-13 answers this by imagining futures ([`src/brain/value.ts`](../src/brain/value.ts)):

1. Draw a plausible set of tiles K-13 might still buy, from the unseen pool.
2. Find the best way to split *rack + those tiles* into dictionary words, and score it.
3. Do the same with *rack + this letter + those tiles*.
4. The difference is the letter's value in that future. Average over many futures.

Both sides of the comparison use **the same imagined futures** (common random numbers), so the noise cancels and small differences are measurable. The word search is fast: the best word for a 7-tile rack takes about 0.002 ms ([`src/core/words.ts`](../src/core/words.ts)).

### Worked example: the rack S T O N E R

Say K-13 started with S, T, O, N, E and has just won an R. Its rack is **S T O N E R**. Every one of these letters is worth 1 point.

What it could play right now:

| Play now | Letters | Base | Multiplier | Reward | Left on rack |
|---|---|---|---|---|---|
| TONE | 4 | 4 | 1.5x | **6** | S, R |
| STONE | 5 | 5 | 2x | **10** | R |
| STONER | 6 | 6 | 2.5x | **15** | nothing |

And what one more letter would make possible (checked against the game's dictionary, `data/wordlist.txt`):

| Next letter | Best play with 7 tiles | Reward | Gain over STONER |
|---|---|---|---|
| A, E, I, N, O, R, S, T, U | a 7-letter word (3x), e.g. SENATOR, STONIER, TONSURE | 21 | +6 |
| D, G | RODENTS, TONGERS (3x) | 24 | +9 |
| B, C, M, P | SORBENT, CORNETS, MONSTER, POSTERN (3x) | 27 | +12 |
| F, H | FRONTES, HORNETS (3x) | 30 | +15 |
| V, W, Y | no 7-letter word; a 6-letter swap: STOVER, RESOWN, STONEY (2.5x) | 22 | +7 |
| K | TOKENS (2.5x) | 25 | +10 |
| J, X | JETONS, SEXTON (2.5x) | 32 | +17 |
| Z | ZONERS (2.5x) | 37 | +22 |
| L, Q | nothing beats STONER | 15 | 0 |

Two things stand out:

- **Length doubles the pay per tile.** In TONE the letters T, O, N, E earn 1.5 points each. Inside SENATOR the same four letters earn 3 each. Cashing TONE now spends four good tiles at half price and leaves an S and an R that make nothing on their own.
- **Almost every letter helps.** 17 of the 26 letters complete a 7-letter word, and in a fresh bag minus this rack 77 of the 92 remaining tiles are one of those letters (84%). The high-value letters J, K, X and Z have no 7-letter word here but still gain by replacing a 1-point tile in a 6-letter word. Only L and Q add nothing at this step. If K-13 buys one more tile drawn at random from that bag, the expected best play is about 22.3 points, against 15 for STONER today and 6 for TONE.

This is why K-13 goes for long words.

The table above is a one-step simplification. K-13's real valuation looks further ahead (several future tiles, not one), so even an L or a Q has some value in a rack that might later grow into a different word.

---

## 3. What is a coin worth?

Points win matches; coins only buy tiles. So K-13 needs an exchange rate. It solves for **λ, the number of points one coin is worth right now** ([`src/brain/market.ts`](../src/brain/market.ts)):

- If K-13 bid *value ÷ λ* on every useful auction still to come, it would expect to spend exactly its balance, plus the coins its words will earn in time to be spent.
- Early in the match there are many auctions to come and coins are scarce: λ is high and bids are cautious.
- Near the end there is little left to buy, so λ falls and bids rise toward the whole balance. Unspent coins are worth nothing at the end.
- At tables of 7 or more bots, prices are high from the first auction, so λ is scaled down there (`lambdaScaleBig`). In simulation that change improved K-13's mean place at 11 seats from 3.66 to 1.85.

**In the example.** Suppose, for illustration, λ = 0.5 points per coin at this moment. The H is worth about +15 points, so its truthful bid is 15 ÷ 0.5 = **30 coins**. An A, worth about +6, is worth 12 coins.

---

## 4. Who else wants it? Picking the bid

K-13 knows who is sitting at the table, and it has a model of how each of them bids ([`src/memory/fit.ts`](../src/memory/fit.ts)). For each rival the model gives a probability for every possible bid on this letter, given the game phase, the rival's coins and its rack size. During the match K-13 also checks where the actual prices land against those predictions and corrects the models on the fly.

From the rivals' distributions K-13 works out the distribution of the **highest** and **second-highest** rival bid (order statistics). That gives, for every bid it might make:

- the probability of winning (the highest rival bid is lower), and
- the expected price (under Vickrey, the highest rival bid when K-13 wins).

It then tries **every bid from 0 to its balance** and picks the one with the best expected payoff ([`src/brain/bid.ts`](../src/brain/bid.ts)):

```
U(b) = E[my surplus | b] + Σ over rivals o of  w_o · λ · (o's surplus if I bid 0 − o's surplus if I bid b)
```

- **My surplus** is the letter's value minus λ times the price, when K-13 wins.
- **The rival term.** Bidding can also hurt a rival: by winning a tile it wanted (denial) or, when K-13 loses, by making the winner pay more (price-driving). The weight w_o says how much that rival's points matter to K-13's finishing place.
- **Who matters** ([`src/brain/place.ts`](../src/brain/place.ts)). K-13 models each final score gap as roughly normal, so P(beat rival) = Φ(gap / σ). Rivals near K-13's score get almost all the weight; a bot far ahead or far behind gets almost none. As the match runs out, the weight concentrates on the nearest rivals.

With no rivals in the picture, the best Vickrey bid is simply the truthful one, value ÷ λ, because the price is set by someone else. The rival term can only push the bid up, and by at most a few coins (`maxOverbid`), so a modelling error never buys a tile K-13 does not want. Under first-price auctions the winner pays its own bid, so the same search naturally **shades** the bid below value, and the rival term is switched off.

**Refined bid before the close** ([`src/live/bidder.ts`](../src/live/bidder.ts), [`src/live/clock.ts`](../src/live/clock.ts)). While the quick bid stands, K-13 runs the full calculation and sends the refined bid if it differs, finishing a safety margin before the close (250 ms by default). K-13 tracks the server's clock offset and the network latency so the bid arrives in time.

---

## 5. The auction closes

| Outcome | What happens | What K-13 learns |
|---|---|---|
| K-13 wins | It pays the second-highest bid (or 1 if it was the only bidder). The tile joins its rack. | The price is the best rival's bid, so every other rival bid at most that. |
| A rival wins | Nothing is paid by K-13. | The price paid bounds every losing bid from above. After the match, the archive shows the winning bid exactly. |
| Nobody bids | The tile is discarded. | Nobody wanted that letter at this point. |

Those facts feed two loops:

- **Within the match**, the rival models are recalibrated from where each price fell in the predicted distribution ([`src/brain/market.ts`](../src/brain/market.ts)).
- **Across matches**, the miner turns every finished match into bid observations: exact winning bids, and losing bids known only to be at most the price. The models are refitted with that censored data, recent matches weighing more ([`src/memory/derive.ts`](../src/memory/derive.ts), [`src/memory/train.ts`](../src/memory/train.ts)).

---

## 6. Play now or hold?

A word can be played at any time, so after every change to the rack K-13 asks: is it better to cash a word now or keep the tiles? It compares the two on **the same imagined futures** ([`src/brain/agent.ts`](../src/brain/agent.ts)):

- **Play now:** the word's reward, plus a bonus because the reward also arrives as coins that buy tiles (`coinBonus · λ` per point), plus the expected best play from what is left.
- **Hold:** the expected best play from the full rack, which still includes the option of playing the same word later, possibly extended.

K-13 plays only when playing wins by a margin (`playMargin`).

**In the example**, with the tuned settings in [`data/params.json`](../data/params.json) (coinBonus 0.32, playMargin 2.7) and the illustrative λ = 0.5, assuming one more random tile:

| Option | Calculation | Value |
|---|---|---|
| Play STONER now | 15 × (1 + 0.32 × 0.5), and one new tile alone makes no word | about 17.4 |
| Play TONE now | 6 × (1 + 0.32 × 0.5), plus at most 5 more from S, R and the new tile (SH) | at most about 12 |
| Hold | Expected best play from S T O N E R + one random tile | about 22.3 |

Playing STONER now comes out about 4.9 points below holding. K-13 would play only if playing came out at least 2.7 points *above* holding, so it waits. (This sketch ignores the price of the extra tile; the real calculation also looks further ahead than one tile.) If no useful letter arrives before the end, STONER is still there to play.

---

## 7. The end of the match

The last few auctions follow different logic, because of one rule: **the match ends the instant the last auction closes**.

- **Coins become worthless.** λ falls to its floor and K-13 bids up toward its whole balance on letters that still help.
- **The second-to-last tile** is valued only for what it completes right away, with no imagined future tiles.
- **The last tile is worthless.** A live bot cannot play a tile won in the final auction, so K-13 bids **0** on it.
- **The rack is dumped before the end.** When the last auction opens, K-13 plays the exact best split of its rack into words, so no tile is left unplayed that could have scored.

---

## Why these choices hold up

Each setting above was tested in a replica of the game's server code ([`src/sim/engine.ts`](../src/sim/engine.ts)) against calibrated clones of the real opponents and copies of K-13 itself. A change ships only if paired comparisons on the same deals show it is better at 95% confidence in at least one tournament stage and worse in none ([`src/brain/eval.ts`](../src/brain/eval.ts), [`src/sim/tournament.ts`](../src/sim/tournament.ts)). The README's [evidence table](../README.md#simulator-clones-and-tuning) lists examples, including a variant that was rejected.

In ScrabbleBot tournament #1 (68 entrants) this approach won the championship, taking the heads-up final 1,202–323 over three games.
