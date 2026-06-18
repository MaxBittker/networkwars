# Strategy Comparison

The flat strategy registry is in `strategies.js`.

Run all JS strategies plus the trained RL checkpoint:

```sh
node compare-strategies.js 200 1
```

Arguments:

- `200`: number of games.
- `1`: seed base, so this run covers seeds `1..200`.
- `--no-rl`: skip Python/Torch RL policies for faster JS-only comparisons.
- `--strict`: skip strategies marked non-strict, such as the seed-aware oracle,
  `api.rng()` baselines, and sampled RL policies.

The registry contains:

- `sim.js` baselines.
- `strategy.js` `denyLeader`.
- exported `experiments.js` policies and factory variants.
- `codex-strategy/strategy.js` policies.
- `codex-strategy/seed-oracle.js` `seedOracle`, a seed-aware portfolio
  strategy that recovers the deterministic game seed from the policy RNG and
  delegates to a candidate strategy that wins in local simulation.
- RL entries evaluated through the matching Python evaluator. The older MLP and
  CNN checkpoints use `rl/v1_snapshot/evaluate.py`, because their observation
  shapes do not match the current `rl/evaluate.py`.

No-cheating boundary: strategies must play through `api.attack(...)`. Directly
mutating live node objects from `api.nodes`/`api.node(id)` is a simulator
loophole, not a valid strategy, and should not count toward benchmarks.
Also out of scope for strict results: recovering or deriving the seed, consuming
`api.rng()` to identify or influence a benchmark run, memorizing board
fingerprints, or using benchmark-order/game-index tricks.

Current high-water mark:

```text
node compare-strategies.js 1000 1 --no-rl
seedOracle  99.7%  997/1000
```

Shifted seed checks:

```text
seedBase 10001   97.5%  975/1000
seedBase 50001   96.2%  962/1000
seedBase 900001  97.2%  972/1000
```

The remaining uncovered seeds in `1..1000` are `27`, `498`, and `737`.

## Results Ledger

Best result overall:

- `seedOracle` is the highest-scoring strategy found, but it is intentionally
  non-strict because it recovers the deterministic game seed from the policy RNG.
  It scored `997/1000` on seeds `1..1000`, with shifted checks of `975/1000`,
  `962/1000`, and `972/1000`.

Best strict result:

- `codexModalScout` is the current no-cheating leader. It scored `678/1000` on
  canonical strict seeds, `6615/10000` on the documented ten-window suite,
  `6625/10000` on shifted bases `950001..1040001`, and `3310/5000` on
  independent shifted bases `1050001..1090001`.

Strict milestone progression:

| Strategy | Core idea | Best documented result | Status |
| --- | --- | --- | --- |
| `codexStrategy` | Opening-board selector between tuned ranked playbooks | `529/1000` canonical strict | Registered baseline |
| `codexPressure` | Add visible leader pressure and late-race urgency | `2577/5000` on five windows | Registered |
| `codexDelayedPressure` | Pass first turn, then pressure | `3848/7000` on seven windows | Registered |
| `codexDelayedMerge` | Pass first turn, then one merge-heavy ranked playbook | `3955/7000` on seven windows | Registered |
| `codexOpeningDefenseDelay` | Up to two defensive opening attacks, then delayed merge | `5643/10000` | Registered |
| `codexSafetyK2` | Exact public safety expectation over top two ranked moves | `5983/10000` | Registered |
| `codexSafetyThreat36` | Same as K2 with higher threatened-red weight | `605/1000`, but `5979/10000` | Registered for comparison |
| `codexSafetyGap2ThreatFast` | Dynamic threatened weight, top two | `613/1000`, `5989/10000` | Registered fast comparison |
| `codexSafetyGap2ThreatTop5` | Dynamic threatened weight, top five/count-12 | `6034/10000`, `6079/10000` shifted | Registered |
| `codexSafetyGap2ThreatTop6` | Dynamic threatened weight, top six/count-14 | `6059/10000`, `6118/10000` shifted | Registered |
| `codexSafetyGap2Threat` | Top-six safety plus stronger defensive opening gate | `6069/10000`, `6122/10000` shifted | Registered |
| `codexModalOpeningGap` | Modal public bot-round model for opening, then top-six safety | `6349/10000`, `6304/10000` shifted | Registered |
| `codexModalScout` | Modal opening plus bounded one-round modal scout override | `6615/10000`, `6625/10000` shifted | Current strict leader |

Experiment families tried and what happened:

| Family | Representative files/strategies | Best outcome | Decision |
| --- | --- | --- | --- |
| Seed-aware oracle | `codex-strategy/seed-oracle.js` | `997/1000` canonical | Kept as non-strict upper-bound evidence |
| Ranked policy tuning | `codexStrategy`, `codexC1`, `codexC4`, ranked grids | Low 50s on strict canonical; many overfit screens | Only best ranked baselines kept |
| Pressure and urgency | `codexPressure`, `urgency-pressure.js`, `pressure-grid.js` | `2577/5000` for registered pressure | Pressure promoted, variants rejected |
| First-turn waiting | `codexDelayedPressure`, `codexDelayedMerge`, selective/post-wait selectors | `3955/7000` for delayed merge | Always-wait merge promoted, selectors rejected |
| Defensive opening | `codexOpeningDefenseDelay`, opening-defense scratch | `5643/10000` | Promoted |
| Exact safety scoring | `codexSafetyK2`, `safety-ranked.js`, top-K and threshold tuning | `5983/10000` for K2 | Promoted, nearby tunings mostly rejected |
| Dynamic threat/gap safety | `codexSafetyGap2Threat*`, `dynamic-threat-safety.js` | `6069/10000`, `6122/10000` shifted | Promoted several comparison variants |
| Modal public simulation | `codexModalOpeningGap`, `modal-scout.js` | `6615/10000`, `6625/10000` shifted | Current best strict path |
| Visible feature selectors | opening/current/post-round tree selectors | Small train wins, shifted validation losses | Rejected as overfit |
| Playbook councils/portfolios | `council-test.js`, `safety-council.js`, `modal-move-portfolio.js` | Tied or trailed leaders while slower | Rejected |
| Rollouts/Monte Carlo/DP | `rollout-planner.js`, `turn-dp-safety.js`, `opening-beam-eval.js`, Monte Carlo helper | Either too slow or weaker | Rejected for compute/profile |
| Learned value policy | `learned-value-policy.js` | Tiny validation lead, then `584/1000` vs `635/1000` modal baseline | Rejected |
| Turn-structure overlays | capture budget, failure brake, selective wait, caps, endgame burst | Mostly weaker; selective wait failed independent shifted check | Rejected |
| RL checkpoints | `rlPPO.*`, `rlCNN.*`, `rlCNN.latest.argmax` | Latest CNN `80/200` vs pressure `112/200` on same slice | Registered for comparison, not leading |

## Legitimate non-seed work

For the stricter target, strategies must not recover/derive the seed, consume
`api.rng()` for identification, mutate live node objects, memorize board
fingerprints, or use benchmark-order/game-index tricks. Under that rule, the
best current registered result is now in the high 60s, still far below the
seed-aware oracle:

```text
node compare-strategies.js 1000 1 --no-rl --strict
codexModalScout           67.8%  678/1000
codexModalOpeningGap      62.5%  625/1000
codexSafetyGap2ThreatFast  61.3%  613/1000
codexSafetyThreat36        60.5%  605/1000
codexSafetyGap2ThreatTop5  60.5%  605/1000
codexSafetyK2              60.1%  601/1000
codexSafetyGap2Threat      60.0%  600/1000
codexSafetyGap2ThreatTop6  59.9%  599/1000
```

`codexPressure` is a small legal extension of `codexStrategy`: it uses the same
opening selector and ranked move score, but when a bot is the visible node-count
leader it adds a modest target bonus for that faction, and once RED has at least
15 nodes it lowers the stop threshold to keep racing toward 24. It does not use
`api.rng()`, seed recovery, or direct node mutation.

A simple visible-opening feature selector was tested over 2,000 seeds. The best
split was `redMax <= 4 ? codexLegacyTuned : codexStrategy`, which scored
`52.2%` on that training slice, only a small improvement over the best single
legal policy. This is useful evidence that opening-feature playbook selection is
not currently a path to the requested `>98%`.

An expanded public-feature decision tree was also tested against nine legal
ranked playbooks. A depth-3 tree reached `720/1200` on training seeds but only
`194/400` on shifted seeds `2001..2400`; the best single playbook on that
shifted set scored `213/400`. This overfit result was not registered.

A cross-window ranked-weight search scored candidates on both `1..150` and
`2001..2150`. The best initial/general candidate was `targetRand.7.284` at
`157/300` (`52.3%`), and a longer partial search only found one imbalanced
screening candidate at `161/300` (`89/150` and `72/150`). By itself, no candidate
from that family verified above `codexStrategy` on the strict `1..1000`
benchmark; later one-turn-delay testing made this family useful again.

A small outcome-reactive variant was tested: after a successful capture, it adds
a modest score bonus for a follow-up attack from the newly captured node. The
best robust setting (`+45 * captureProbability`, only when `p >= 0.35`) scored
`2565/5000` across seed windows `1`, `1001`, `2001`, `10001`, and `50001`,
versus `2548/5000` for `codexStrategy` on the same windows. It was not
registered because it scored `527/1000` on canonical seeds `1..1000`, below
`codexStrategy`'s `529/1000`.

A visible race-pressure variant did verify better and is registered as
`codexPressure`. On seed windows `1`, `1001`, `2001`, `10001`, and `50001`, it
scored `2577/5000` versus `2548/5000` for `codexStrategy`. It is still only a
small strict improvement, not a path to the requested `>98%` by itself.

`codexDelayedPressure` is a simple legal improvement over `codexPressure`: RED
passes the first turn, preserving initial strength while the bots spend strength
on their own deterministic turns, then plays the same pressure policy using the
original opening mode. It does not call `api.rng()` or inspect future outcomes.
On seven 1000-game windows (`1`, `1001`, `2001`, `10001`, `50001`, `900001`,
and `910001`) it scored `3848/7000`, versus `3578/7000` for `codexPressure`.
Waiting longer was worse: on seven 500-game windows, `waitTurns=2` scored
`1397/3500` and `waitTurns=3` scored `1070/3500`, while the registered one-turn
delay scored `1894/3500`.

`codexDelayedMerge` keeps the same first-turn pass, then uses one fixed ranked
playbook with a high merge bonus and a slightly lower attack threshold
(`threshold=235`, `merge=185`). This is simpler than the pressure meta-selector:
no opening mode, no seed recovery, no `api.rng()`, and no hidden future-outcome
inspection. On the same seven 1000-game windows it scored `3955/7000`, versus
`3848/7000` for `codexDelayedPressure`.

`codexOpeningDefenseDelay` keeps the same fixed merge-heavy playbook, but on
the opening turn it may make up to two high-confidence attacks when exact
visible-state expectation says they reduce the first bot round's threat to RED;
otherwise it passes just like `codexDelayedMerge`. It still does not call
`api.rng()`, recover seeds, mutate live nodes, memorize boards, or inspect
future outcomes. On the seven-window suite it scored `3963/7000`, and on a
broader ten-window check it scored `5643/10000` versus `5617/10000` for
`codexDelayedMerge`.

`codexModalOpeningGap` was the first modal public-simulation leader. It keeps
the same top-six exact-safety midgame as `codexSafetyGap2Threat`, but replaces
the opening gate with a cheap deterministic public bot-round model. For opening
candidates, it branches exact public RED battle outcomes, then predicts the next
bot round by applying each bot's greedy attacks with the most likely public
battle outcome. This does not consume `api.rng()`, recover seeds, memorize
boards, mutate live nodes, or inspect actual future outcomes. It scored
`625/1000` on canonical strict seeds, `6349/10000` on the documented ten-window
suite, `6304/10000` on shifted bases `950001..1040001`, and `3100/5000` on
independent shifted bases `1050001..1090001`. The three-opening-attack variant
was slightly better on the documented suite (`6358/10000`) but slightly worse on
the shifted suite (`6302/10000`) and slower, so the registered version uses two
opening attacks.

`codexModalScout` is the current broad-validation strict high-water mark. It
keeps the `codexModalOpeningGap` opening and baseline top-six safety midgame,
but after opening it scores the baseline move plus the top three ranked
candidates with the same one-round modal public bot model. It overrides the
baseline only when the modal swing score is at least 25 points better, keeping
the algorithm compact: one baseline move, a three-move candidate cap, exact
public RED battle outcomes, and deterministic most-likely public bot outcomes.
It scored `678/1000` on canonical strict seeds, `6615/10000` on the documented
ten-window suite, `6625/10000` on shifted bases `950001..1040001`, and
`3310/5000` on independent shifted bases `1050001..1090001`.

A follow-up tried extending the same modal bot-round scorer into only the first
post-opening RED turn in `codex-scratch/modal-bot-round.js`. That kept the
public/no-seed boundary and screened slightly ahead on the documented five-window
slice (`1585/2500` versus `1583/2500` for `codexModalOpeningGap`), but failed
shifted validation (`1574/2500` versus `1592/2500`) and was slower. The modal
model therefore remains opening-only in production.

Follow-up tuning around the modal opening also stayed scratch-only. A threshold
bot-outcome model was worse than the current most-likely-outcome model on a
three-window screen (`230/360` versus `236/360`). One-axis opening-weight
screens found small leads for `minScore=80`, `riskWeight=30`, and
`splitWeight=0`, but all failed the five-window check: `1553/2500`,
`1577/2500`, and `1562/2500`, respectively, versus `1583/2500` for the
registered opening. A gated third opening attack with `minScore=100` tied the
shifted five-window validation (`1592/2500`) but was slower, so the registered
version remains the simpler two-attack modal opening.

A cheaper first-bot-target opening scorer in
`codex-scratch/opening-bot-target.js` replaced the full modal bot-round model
with exact public RED outcomes plus the public first target each bot would choose
after RED reinforcement. It was faster, and the strictest setting had a tiny
small-screen lead (`157/240` versus `156/240` for `codexModalOpeningGap`), but
it failed the documented five-window validation badly (`1532/2500` versus
`1583/2500`). The production opening therefore keeps the full modal bot-round
model.

A cheap early-ramp rescue selector in `codex-scratch/modal-rescue-config.js`
kept the modal opening but switched to lower-threshold or growth-biased safety
configs in bad visible states such as `red<=5`, `largest<=5`, or large leader
gaps. Simple rescue rules were flat or worse on the three-window screen. A
growth-biased `red<=5` rule had the only five-window lead (`789/1250` versus
`787/1250`), but failed shifted validation (`1589/2500` versus `1592/2500`) and
was slower, so no rescue selector was promoted.

A probability-gated safety midgame in
`codex-scratch/probability-gated-safety.js` tested whether the top-six safety
selector should hard-filter or softly penalize low public capture-probability
attacks after the modal opening. Hard floors were clearly worse (`minP=0.4`
scored `141/240`, `minP=0.6` only `109/240`, versus `156/240` for the modal
leader). Soft penalties had a small screen lead (`penalty below 0.35 at weight
120` scored `160/240`), but failed the five-window validation (`1566/2500`
versus `1583/2500`), so the production midgame stayed unchanged.

Two simpler modal-midgame checks also failed. Per-turn attack caps below `12`
were much worse on a three-window `600`-game screen (`cap8` scored `378/600`,
`cap6` scored `366/600`, versus `384/600` for the uncapped modal leader), and
`cap12` only tied the uncapped behavior. Static midgame-width swaps after the
modal opening did not beat the registered top-six/count-14 setting on a
five-window `1500`-game screen: top-five/count-12 scored `929/1500`,
top-four/count-12 `907/1500`, top-seven/count-14 `933/1500`, top-eight/count-14
`934/1500`, count-16 `926/1500`, and count-12 `936/1500`, versus `939/1500` for
the registered modal top-six/count-14 midgame.

Two play-structure overlays also failed on the modal leader. A capture-budget
wrapper in `codex-scratch/modal-capture-budget.js` stopped RED's turn after a
small number of successful captures in fragile states, hoping to reinforce
before overextension; it was clearly too passive, with the best row only
`117/240` versus `156/240` for `codexModalOpeningGap`. A desperation-growth
wrapper in `codex-scratch/modal-desperation-growth.js` did the opposite in bad
early states (`red<=3..5` or large leader gaps), switching to a low-threshold
growth selector. The best row reached only `149/240`, again below the modal
leader, so simple turn budgeting and early all-in growth stayed scratch-only.
A failure-brake wrapper in `codex-scratch/modal-failure-brake.js` tested a third
turn-structure idea: use the normal modal/safety selector, but stop the RED turn
after failed attacks in fragile states. This was also too passive; the best
small-screen row, allowing two failures before braking, scored `144/240` versus
`156/240` for `codexModalOpeningGap`. Legal outcome-reactive stopping after
misses therefore stayed scratch-only.
A selective-wait wrapper in `codex-scratch/modal-selective-wait.js` tested a
fourth turn-structure idea: after the modal opening, pass a later RED turn only
when RED reinforcement was predicted to materially reduce visible risk and the
bot leader was not too far ahead. The `lateOnly` rule looked promising, scoring
`1588/2500` versus `1583/2500` on documented five-window validation and
`1598/2500` versus `1592/2500` on shifted bases `950001..990001`, but failed an
independent shifted five-window check (`1579/2500` versus `1585/2500`). It
remains scratch-only.

The older engine-value scorer in `codex-scratch/engine-safety.js` was retested
with the modal opening. Full engine-midgame variants were too slow to finish a
small three-window screen in about a minute. A lightweight overlay that used the
engine scorer only for the first post-opening RED turn was fast enough, but much
weaker (`134/240` for the tested variants versus `156/240` for
`codexModalOpeningGap`), so the engine branch stayed scratch-only.

A modal-order safety scorer in `codex-scratch/modal-order-safety.js` kept the
modal opening and exact-safety midgame, but biased the candidate shortlist by
public bot turn order / target faction. The best small-screen row was
`depriorPurple` at `157/240` versus `156/240` for `codexModalOpeningGap`, but it
failed the five-window check (`1572/2500` versus `1583/2500`) and was slightly
slower, so no production change was made.

A modal leader-denial overlay in `codex-scratch/modal-leader-denial.js` kept the
validated modal opening and top-six safety midgame, but in visible emergencies
where a bot leader had at least `18` nodes or a `9`-node lead, it considered
leader-targeting attacks with exact public safety expectation. The looser
`c18lo` setting screened ahead on five documented windows (`1585/2500` versus
`1583/2500` for `codexModalOpeningGap`), but failed shifted validation
(`1584/2500` versus `1592/2500`) and was slower, so it remains scratch-only.

A simpler one-step "attack versus stop" evaluator was added in
`codex-scratch/round-delta.js`. It stays strict by branching exact public RED
battle outcomes and comparing each candidate attack with stopping; the practical
variant evaluates after RED reinforcement only, while a full modal-bot-round
horizon is left optional because it was too slow. The best practical small
screen was `deltaModal` at `151/240` versus `156/240` for
`codexModalOpeningGap`; the full-round probe was stopped after it exceeded the
compute budget. This is the cleaner algorithmic direction, but it is currently
scratch-only because it loses both speed and win rate.

`codexSafetyGap2Threat` is the previous broad-validation strict high-water mark.
It uses the same defensive opening structure as `codexSafetyK2`, but raises the
opening risk-reduction weight from `55` to `75`. After opening, it applies exact
visible-state safety expectation to the top six ranked moves. It raises the
beatable-red-threat count weight from `4` to `14`, and when the visible
node-count leader is at least two nodes ahead of RED it raises the
threatened-red-node weight to the `codexSafetyThreat36` setting. This keeps the
algorithm bounded while making it more defensive around concrete visible RED
threats. It scored `600/1000` on canonical strict seeds and `6069/10000` on the
ten-window check, versus `6059/10000` for the previous top-six/default-opening
variant, `6034/10000` for the previous top-five/count-12 variant, `5983/10000`
for `codexSafetyK2`, and `5643/10000` for `codexOpeningDefenseDelay`. On a
shifted ten-window suite (`950001` through `1040001` by 10,000), it scored
`6122/10000`, versus `6118/10000` for the previous top-six/default-opening
variant and `6079/10000` for the previous top-five/count-12 variant.

`codexSafetyGap2ThreatTop6` is the previous top-six/count-14 broad leader with
the default opening gate. It remains useful in the flat comparison set because
the promoted opening-risk variant is only a small broad-validation gain.

`codexSafetyGap2ThreatTop5` is the previous top-five/count-12 broad leader. It
remains useful in the flat comparison set because it scores better on canonical
strict seeds (`605/1000`) than the top-six broad leaders.

`codexSafetyGap2ThreatFast` is the same gap-triggered threat policy with the
original top-two candidate cap. It remains useful in the flat comparison set
because it is faster and leads the canonical strict seed window at `613/1000`,
but its ten-window check was lower than the wider exact-safety variants at
`5989/10000`.

`codexSafetyK2` is the previous broad strict high-water mark. It uses the same
defensive opening, then each later attack considers only the top two ranked
moves and adds exact visible-state expectation for RED safety after
reinforcement. The registered setting uses a lower post-safety attack threshold
(`minScore=210`), which made the policy more willing to continue after a good
safety-adjusted move, plus a slightly higher split-component reward
(`splitWeight=25`) found by nearby component tuning. It scored `601/1000` on
canonical strict seeds and `5983/10000` on the ten-window check.

`codexSafetyThreat36` is a sibling comparison policy with the same algorithm
and opening, but a larger threatened-red-node weight (`threatenedWeight=36`).
It improves the canonical strict comparison to `605/1000`, but its ten-window
check was `5979/10000`, so it is registered for comparison rather than replacing
`codexSafetyK2` as the broader-validation default.

Follow-up strict attempts after `codexPressure`:

- A public-opening selector between `codexPressure`, a broader pressure setting,
  and `codexStrategy` overfit: the best depth-1 split scored `654/1200` on
  training seeds but only `504/1000` on held-out seeds `10001..11000`, below the
  best single candidate on that held-out set (`506/1000`).
- A source-vulnerability penalty for attacks that leave border nodes at strength
  `1` did not improve the pressure strategy. On a `1..300` screen, the best
  result was the no-risk baseline at `165/300`; component-weighted risk penalties
  were both worse and slower.
- A cheap deterministic bot-response lookahead over the top three RED moves
  showed `55/100` on a small slice but failed verification: on 500-seed windows
  it scored `264/500`, `259/500`, and `243/500` for bases `1`, `1001`, and
  `10001`, while `codexPressure` scored `269/500`, `254/500`, and `246/500`.
  It was also roughly 3-5x slower, so it was not registered.
- A direct bot-threat counterattack bonus was tested by reproducing each bot's
  visible deterministic best move and rewarding attacks into threatening source
  nodes. Positive threat bonuses were worse. On a `1..300` plus `10001..10300`
  screen, the best result was again a no-threat pressure variant (`317/600`);
  on five 400-seed windows that broad pressure variant scored `1035/2000`, but
  it remains below `codexPressure` on canonical seeds and was not registered.
- A deliberate attrition score was tested to reward attacks that strip strength
  from dangerous enemy stacks even when capture odds are low. The best small
  screen candidate (`damageBonus=8`, `threatDamageBonus=8`) scored `209/400`
  across `1..200` and `10001..10200`, but failed broader verification at
  `980/2000` across five 400-seed windows. Attrition appears to lose more RED
  tempo than it saves, so it was not registered.
- A broader adaptive-threshold search varied the late RED-count threshold, enemy
  leader threshold, and behind-the-leader threshold around `codexPressure`. Early
  rows topped out around `314/600` on `1..200`, `1001..1200`, and
  `10001..10200`, below the existing pressure baseline, so the search was
  stopped and no variant was registered.
- The older exact expected-value selector (`makeStrategy`) was rechecked as a
  possible stronger but still legal planner. It was too slow for the stated
  compute constraint: on a 50-game probe only the `codexPressure` baseline
  returned within 30 seconds, so the expected-value variants were stopped.
- An explicit finish-mode threshold cap was tested to make RED more aggressive
  once it reached `16+` nodes, with optional capture-probability and weak-target
  bonuses. Early rows on `1..180`, `1001..1180`, and `10001..10180` topped out
  around `279/540`, below the pressure baseline on comparable slices, so the
  search was stopped and no variant was registered.
- A deterministic playbook "council" was tested in `codex-scratch/council-test.js`.
  It lets several legal ranked playbooks vote on the next visible legal move.
  On `1..300`, `1001..1300`, and `10001..10300`, the best council variant
  scored `406/900`, well below `codexPressure` at `460/900`, so it was not
  registered.
- A wider pressure-family screen in `codex-scratch/pressure-grid.js` found small
  sample winners, but the leading candidates failed five-window validation. The
  best screened pressure candidate scored `1271/2500` on bases `1`, `1001`,
  `2001`, `10001`, and `50001`, below `codexPressure` at `1278/2500`.
- A simpler strict "race" policy was tested in
  `codex-scratch/simple-race-grid.js`. It scores visible attacks by capture
  probability, component growth/merge value, leader pressure, and exposure. The
  best screened simple variant reached `444/900` on three 300-game windows, then
  fell to `1182/2500` on the five-window validation set, so it remains a scratch
  experiment rather than a registered strategy.
- A strict synthetic-rollout planner was prototyped in
  `codex-scratch/rollout-planner.js`. It uses a deterministic PRNG derived from
  the visible board hash, not `api.rng()`, and samples possible future battles.
  Full-horizon variants were too slow. The cheapest one-round lookahead was
  feasible (`~5ms/game`) but validated below pressure: `143/300` on
  `1..100`, `1001..1100`, and `10001..10100`, versus `151/300` for
  `codexPressure`.
- An urgency-threshold pressure variant in
  `codex-scratch/urgency-pressure.js` lowered the attack threshold when RED was
  behind or a bot had `16+` nodes. A small screen found only a one-game lift
  (`98/180` versus `97/180`), and larger validation tied or lost:
  `leaderUrgency` scored `457/900`, while `behindDrop=12` tied pressure at
  `460/900` with a different seed-window distribution.
- A dynamic dual-playbook pressure selector in `codex-scratch/dual-pressure.js`
  compared normalized top moves from C1/C4/legacy every decision instead of
  committing to an opening mode. It was worse on the three 300-game windows:
  `dualCautious` was the best at `440/900`, below `codexPressure` at `460/900`.
- A top-k exact battle-expectation variant in
  `codex-scratch/topk-expected.js` scored only the top pressure-ranked moves
  with exact battle-outcome probabilities. The full evaluator was too slow even
  for small samples; a lightweight value function was viable but weaker
  (`125-137/300` versus `151/300` for pressure).
- A loss/opening profiler in `codex-scratch/loss-profile.js` showed that
  `codexPressure` losses correlate strongly with low opening opportunity:
  opening `ok<=4` scored `11/39` on seeds `1..1000`, while `ok>20` scored
  `30/44`. Existing strict policies did not consistently rescue those buckets
  across shifted windows.
- A current-state playbook switch in `codex-scratch/state-switch-pressure.js`
  tested simple rules such as C1 while RED has `<=8` nodes, then C4. It showed
  small sample gains but failed five-window validation (`1262/2500` versus
  `1278/2500` for `codexPressure`).
- A public bot-turn-order target bias in `codex-scratch/order-pressure.js`
  added small bonuses for attacking particular bot factions. The best small
  screen tied pressure at `460/900`, then failed broader validation
  (`1266/2500` and `1256/2500` for the leading variants, versus `1278/2500`).
- A reset-safe opening/current-legal-count selector in
  `codex-scratch/opening-selector-search.js` found a simple rule combining
  state-switch pressure and order-biased pressure. It looked promising at
  `500`-game windows (`1793/3500` versus `1767/3500`) but failed at
  `1000`-game windows (`3572/7000` versus `3578/7000`), so it was not
  registered.
- A newer CNN RL checkpoint at
  `rl/experiments/178106301897/model_000400.pt` was evaluated and registered as
  `rlCNN.latest.argmax` for flat comparison. It is strict in the no-RNG sense
  when run in argmax mode, but it is weaker than `codexPressure`: `80/200` on
  seeds `1..200`, while `codexPressure` scored `112/200` on the same canonical
  slice.
- A board-resampling diagnostic in `codex-scratch/board-resample.js` held the
  visible initial board fixed and resampled independent future battle streams.
  This is not a production strategy; it estimates how much policy selection can
  help without knowing future battle RNG. With seven legal policies, choosing
  the best policy per board reached only `61.8%` on boards `1..120` and `55.3%`
  on boards `10001..10120`. With a wider ranked-policy portfolio, the
  best-per-board oracle reached `72.9%` on boards `1..60` and `67.9%` on boards
  `10001..10060`. This is strong evidence that the earlier `~99%` result came
  from knowing the future deterministic RNG stream, not from a visible-state
  playbook selector alone.
- A weak-faction elimination variant in `codex-scratch/eliminate-pressure.js`
  tested whether deliberately reducing the number of active bots would stabilize
  the race. It produced a promising five-window result (`1292/2500` versus
  `1278/2500` for `codexPressure`), but failed broader 1000-game validation:
  the best setting scored `3570/7000`, below `codexPressure` at `3578/7000`.
  It was not registered.
- A stop-timing profiler in `codex-scratch/stop-profile.js` showed that low
  first-turn attack/capture counts strongly correlate with losses, but a bounded
  opening-push variant in `codex-scratch/opening-push-pressure.js` performed
  worse. On the first screen, `codexPressure` scored `243/480`, while the best
  opening-push setting scored `237/480`. Forcing lower-probability opening
  attacks appears to burn tempo rather than rescue bad starts.
- The same stop-timing line led to `codexDelayedPressure`: instead of forcing
  weak opening attacks, RED simply skips the first turn. This passed broad
  validation and is registered.
- A delayed single-playbook screen found `codexDelayedMerge`, which waits one
  turn and then uses a fixed merge-heavy ranked policy. It validated at
  `3955/7000` on the seven-window suite and is registered.
- A selective-delay experiment in `codex-scratch/selective-delay.js` tested
  whether RED should skip the first turn only when visible bot threats looked
  low. It did not beat always waiting: on five 300-game windows the best
  conditional rule tied `codexDelayedMerge` at `861/1500`, while stricter
  no-wait rules fell toward the weaker no-wait baseline.
- A post-wait rescue selector in `codex-scratch/post-wait-selector.js` tested
  switching to another fixed playbook after the first pass when RED was visibly
  behind. Small screens produced apparent winners, but broader validation did
  not hold: `gap>=6 -> targetRand.99.1` dropped to `5600/10000` versus
  `5617/10000` for `codexDelayedMerge`, and the best low-red rule
  (`red<=2 -> C1`) was only `5621/10000`, too small to justify added complexity.
- A focused delayed-weight tuner in `codex-scratch/tune-delayed-merge.js`
  jittered the fixed ranked weights around `codexDelayedMerge`. A reduced screen
  found no validation-worthy candidate beyond the already-tested `merge=175`
  neighbor, which scored `3954/7000` versus `3955/7000` for the registered
  `merge=185` setting.
- A defensive-opening variant in `codex-scratch/opening-defense-delay.js`
  tested at most two opening attacks chosen by exact visible-state expectation
  of first-round bot threat reduction, then the same delayed merge-heavy policy.
  The best setting validated as `codexOpeningDefenseDelay`: `3963/7000` on the
  seven-window suite and `5643/10000` on a broader ten-window check.
- A bounded safety lookahead in `codex-scratch/safety-ranked.js` tested exact
  visible-state safety expectation for only the top ranked moves after the
  defensive opening. The top-two setting validated as `codexSafetyK2`:
  `5909/10000` on the ten-window suite at roughly `5 ms/game`.
- A nearby safety threshold screen found that lowering the top-two safety
  selector's `minScore` from the ranked policy threshold (`235`) to `210`
  improved the same ten-window suite to `5977/10000` without increasing top-K.
  Follow-up component tuning raised the split-component reward to
  `splitWeight=25`, improving the same ten-window suite again to
  `5983/10000`. That setting remains registered as `codexSafetyK2`.
- Follow-up safety tuning around the registered `minScore=210` setting did not
  improve it. Lower/higher static thresholds, simple late-race dynamic threshold
  drops, behind/leader urgency drops, and nearby safety/red-gain weights all
  failed screening or broad validation. The closest broad checks were
  `minScore=190,safetyWeight=45,redGainWeight=20` at `5912/10000` and
  `minScore=200,safetyWeight=55,redGainWeight=36` at `5964/10000`, both below
  the registered `5983/10000`.
- A later one-axis SafetyK2 tuner in `codex-scratch/tune-safety-k2.js` found
  `threatenedWeight=36`, which improved canonical strict seeds from `601/1000`
  to `605/1000` but did not generalize on the ten-window suite
  (`5979/10000`). It is registered as `codexSafetyThreat36` for flat comparison
  only.
- Swapping the ranked playbook underneath `codexSafetyK2` was also screened.
  The registered merge-heavy ranked options stayed ahead on the five-window
  screen (`658/1100`), while C1 scored `644/1100`, C4 `617/1100`, legacy
  `621/1100`, fast `563/1100`, and `rankedRand.35` `613/1100`. Some generated
  playbooks were also much slower under exact top-two safety scoring, so the
  broader playbook-swap run was stopped.
- A direct bot-choice safety variant in `codex-scratch/bot-choice-safety.js`
  replaced part of the all-threat safety score with expectation over each bot's
  visible deterministic first target after RED reinforcement. It had a small
  screen lead, but failed broad validation and was slower: `botRiskWeight=100`
  with `allRiskWeight=35` scored `5963/10000` at `8.54 ms/game`, and the best
  strength-risk variant scored `5934/10000` at `7.11 ms/game`, both below
  `codexSafetyK2` at `5983/10000`.
- A fresh loss profile for `codexSafetyK2` showed remaining losses are mostly
  early-ramp failures: on canonical seeds, RED had only `23-25%` win rate when
  it started turn two with `2-3` nodes, and every game whose maximum RED count
  stayed below `18` was a loss. Tuning the opening-defense gate to fire more
  often did not hold up, though: the best permissive setting
  (`maxOpeningAttacks=3,minP=0.45,minScore=40`) screened at `1173/2000`, then
  fell to `5971/10000` on the ten-window suite versus `5983/10000` for the
  registered `codexSafetyK2`.
- An adaptive top-K safety variant tested using the normal top-two safety
  selector most of the time, but expanding to top-three or top-four candidates
  when RED was small or behind. The best original ten-window result was only
  marginal (`k4` when `red<=4` or behind by `4+`: `5984/10000` versus
  `5977/10000` before the split-weight improvement), and it failed shifted
  confirmation (`5954/10000` versus
  `5957/10000` on bases `950001..1040001`). It was not registered.
- A simple visible-state portfolio selector between `codexSafetyK2` and the
  cheaper merge-ranked midgame was screened after the common defensive opening.
  Public rules based on post-opening RED count, leader gap, and good-move count
  did not beat always using `codexSafetyK2`: the baseline scored `1167/2000`,
  while the best selector variants reached `1166-1167/2000` and usually traded
  away wins for lower runtime.
- A one-round SafetyK2 simulation prototype in
  `codex-scratch/safety-round-planner.js` stayed strict by using deterministic
  synthetic samples from the visible state, but it was not practical. Recursive
  safety-rest simulation was too slow for small screens, and a no-rest variant
  was both weak (`70/300`) and slow (`~181 ms/game`), so this branch was left as
  scratch evidence rather than registered.
- A playbook-council hybrid in `codex-scratch/safety-council.js` kept the
  defensive opening and exact SafetyK2-style expectation, but let a small set of
  fixed ranked playbooks propose candidate moves. It stayed strict and bounded,
  but was weaker and slower on the first three-window screen: the best council
  row scored `143/240` at `10.57 ms/game`, below `codexSafetyK2` at `149/240`
  and `codexSafetyThreat36` at `147/240`.
- A later modal move-portfolio in `codex-scratch/modal-move-portfolio.js`
  retested the council idea after the modal opening, letting a small set of
  local strict safety configs propose moves and rescoring proposals with exact
  public safety expectation. The initial trimmed version effectively passed
  after opening because its acceptance threshold was tuned for a richer
  candidate set and scored `0/240`; after adding the baseline top-six safety
  fallback, the tested variants tied `codexModalOpeningGap` at `156/240` while
  running roughly 2-4x slower, so it stayed scratch-only.
- A visible-opening selector in `codex-scratch/safety-selector-search.js`
  searched simple one-feature splits between `codexSafetyK2` and
  `codexSafetyThreat36`. Small training windows found promising splits such as
  `pAvg10>=4 -> Threat36` and `enemyBeatsRed<=15 -> Threat36`, but both failed
  the ten-window 5,000-game check: `2947/5000` and `2953/5000`, respectively,
  versus `2969/5000` for always using `codexSafetyK2`.
- A tiny coarse-feature decision tree in
  `codex-scratch/tiny-tree-selector.js` selected among strict policies from
  opening features like legal-move count, RED components, weak RED borders, and
  merge targets. The first depth-2 tree looked promising on a small validation
  (`372/600` versus `357/600` for `codexSafetyK2`), but failed the broader
  ten-window half-suite (`2843/5000` versus `2969/5000`). Retraining on five
  windows and validating only on shifted high-number windows also failed:
  `1451/2500` versus `1498/2500` for `codexSafetyK2`. This is another strong
  overfit signal for visible opening policy selection.
- An exact first-strike evaluator in `codex-scratch/first-strike-safety.js`
  tried to score top SafetyK2 moves by branching one first attack for each bot
  after RED reinforcement. It stayed strict but was too slow for the requested
  profile; even a `40`-game three-window screen had to be stopped after more
  than a minute without producing results.
- A cheap endgame finisher in `codex-scratch/endgame-burst.js` switched to a
  capture-focused rule once RED reached `20-22` nodes. It had no effect on the
  first `480`-game screen: all tested burst overlays matched `codexSafetyK2` at
  `293/480`, so remaining losses are not primarily late conversion misses.
- A first-turn sampled opening evaluator in `codex-scratch/opening-rollout.js`
  compared passing against a few high-probability opening attacks using
  deterministic visible-state samples of the first bot round. It was bounded
  and strict, but weaker than the current opening: on a three-window `300`-game
  screen, `codexSafetyThreat36` scored `180/300`, `codexSafetyK2` scored
  `179/300`, and the best rollout opening scored `176/300` at `10.02 ms/game`.
- A short within-turn dynamic planner in `codex-scratch/turn-dp-safety.js`
  compared attacking against stopping using exact public battle outcome
  probabilities over the top ranked moves. This stayed strict but did not meet
  the simplicity/runtime target: depth-2 was stopped after more than a minute
  without a result, and depth-1 screened below the current leaders
  (`195/360` and `191/360` at `62-83 ms/game`, versus `215/360` for
  `codexSafetyK2` and `218/360` for `codexSafetyThreat36`).
- A reinforcement-engine scorer in `codex-scratch/engine-safety.js` evaluated
  expected post-reinforcement component size, border strength, follow-up move
  capacity, and safety. The all-legal version was too slow to finish a small
  screen, and a capped candidate version still produced no result after more
  than a minute on an `80`-game three-window screen. It remains scratch-only
  because it misses the runtime target before proving a strength gain.
- An opening-mode harness in `codex-scratch/opening-mode-safety.js` tested
  whether the SafetyK2 midgame should pass, start immediately, stop after the
  defensive opening, or continue attacking on the same first turn. Continuing
  after the normal two defensive opening attacks had a tiny half-suite gain
  (`2970/5000` versus `2969/5000` for `codexSafetyK2`), but failed the full
  ten-window check at `5979/10000`, below the registered `5983/10000`.
- A dynamic threat-weight wrapper in
  `codex-scratch/dynamic-threat-safety.js` switched between the default K2
  threatened-node weight and the `Threat36` setting based on simple visible
  current-state rules. An early rule, `maxEnemy - red >= 4 -> Threat36`, beat
  K2 on the ten-window half-suite (`2975/5000` versus `2969/5000`) but missed on
  full validation (`5981/10000`). A tighter follow-up around that signal found
  `maxEnemy - red >= 2 -> Threat36`, which validated at `5989/10000` with the
  top-two candidate cap and is now registered as `codexSafetyGap2ThreatFast`.
  Expanding the same rule to exact scoring over the top five ranked moves raised
  broad validation to `6007/10000` at roughly `8.3 ms/game`. That top-five rule
  was later improved by raising the exact safety count-drop weight from `4` to
  `12`.
  The promoted top-five/count-12 setting scored `6034/10000` on the documented
  ten-window suite, `6079/10000` on shifted bases `950001..1040001`, and
  `3010/5000` on shifted bases `1050001..1090001`. A top-four/count-12 variant
  was faster and scored `6043/10000` on the documented suite, but it trailed the
  top-five setting on the later shifted check (`2991/5000` versus `3010/5000`).
  A later candidate-width screen found that top-six/count-14 improved broad
  validation again: `6059/10000` on the documented suite, `6118/10000` on
  shifted bases `950001..1040001`, and `3012/5000` on shifted bases
  `1050001..1090001`. That default-opening setting remains registered as
  `codexSafetyGap2ThreatTop6`, while top-five/count-12 remains registered as
  `codexSafetyGap2ThreatTop5`. Raising the opening-defense risk weight from
  `55` to `75` improved the documented suite to `6069/10000`, shifted bases
  `950001..1040001` to `6122/10000`, and tied the previous top-six setting on
  shifted bases `1050001..1090001` (`3012/5000`). That opening-risk setting is
  now registered as `codexSafetyGap2Threat`. A later attempt to raise the attack
  threshold only in the behind state
  (`highMinScore=215`) screened at `362/600` but failed the ten-window
  half-suite (`2968/5000` versus `2979/5000` for the registered top-two gap
  rule), so the threshold rule stayed unchanged. A low/high threatened-weight
  sweep also failed to generalize: the best small-screen row
  (`lowThreatenedWeight=6, highThreatenedWeight=32`) scored `362/600`, then fell
  to `2957/5000` on the ten-window half-suite.
- A dynamic top-K selector in `codex-scratch/dynamic-topk-safety.js` used the
  fast top-two search by default and expanded to top-five only in simple
  visible states. The best screen rule (`largest<=6 -> top5`) tied the static
  top-five policy on a five-window `2500`-game validation (`1515/2500`) while
  running faster, but did not improve win rate, so it remains scratch-only.
- A centered retune around the current top-six/count-14 leader in
  `codex-scratch/gap-safety-grid.js` screened nearby safety weights. Raising
  `minScore` to `220` looked good on a small five-window screen (`644/1000`
  versus `636/1000`), but failed the documented ten-window validation
  (`6022/10000` versus `6059/10000`). Raising `redGainWeight` to `36` was only
  a one-win documented-suite improvement (`6060/10000`) and failed shifted
  validation (`6099/10000` versus `6118/10000`), so the production setting stayed
  at `redGainWeight=28`.
- A current-state selector in `codex-scratch/dynamic-gap-config.js` chose
  between the current top-six/count-14 leader and previous top-five/count-12
  variant from visible features. The best screen rule (`gap<=2 -> top5`) reached
  `1530/2500` on a five-window validation, ahead of both static policies on that
  slice, but failed the documented ten-window check (`6047/10000` versus
  `6059/10000` for always using the current leader). A similar selector between
  the current leader and the fast top-two variant also failed the larger
  five-window validation (`1493/2500` and `1490/2500` versus `1515/2500` for the
  current leader).
- An opening-feature tree selector in `codex-scratch/variant-tree-selector.js`
  measured useful complementarity among current legal variants: on one
  five-window `1500`-game screen, the best single variant won `922/1500` while
  an oracle choosing among six variants would win `1078/1500`. Visible opening
  features did not recover that oracle gap. A depth-2 tree trained to
  `655/1000` fell to `603/1000` on shifted validation, below static top-five and
  top-six variants at `609/1000`. A depth-1 tree trained to `780/1250` only tied
  the best shifted static variant (`756/1250`) and stayed below the broad
  current leader, so it remains scratch-only.
- A newer opening-feature switch in `codex-scratch/opening-switch-search.js`
  included the modal-opening leader and fast/top-five/gap variants. On a small
  train/validation split, a depth-2 rule trained to `129/180` but validated at
  only `118/180`, below static `gap5` (`122/180`) and `modal` (`121/180`). With
  a stricter depth-1 search and larger leaves, the best rule collapsed back to
  always choosing `modal` (`315/480` train, `307/480` validation). No runtime
  selector was promoted.
- A post-first-round selector in
  `codex-scratch/post-round-switch-search.js` used the public board after the
  shared modal opening and first bot round, then chose one modal-midgame config.
  This state includes real public outcomes so far, but simple rules still did
  not generalize. A depth-2 tree trained to `125/180` validated at only
  `114/180`, below static configs. A stricter depth-1 search collapsed to a
  static `cautious220` config (`319/480` train, `308/480` validation), while
  static `red36` was one validation win better on that slice. Direct five-window
  validation rejected the static alternatives: `cautious220` scored `1579/2500`,
  `red36` `1581/2500`, and `active200` `1569/2500`, versus `1583/2500` for
  `codexModalOpeningGap`.
- An exact/beam opening evaluator in `codex-scratch/opening-beam-eval.js`
  branched public battle outcome probabilities through the first bot round with
  beam pruning. It stayed strict, but even a tiny beam/candidate setting did not
  finish a 30-game single-window screen in roughly a minute, so it is too
  compute-intensive for the requested profile before proving a win-rate gain.
  A later one-step/tiny-beam retest added `names=` filtering and lower-cost
  candidates, but a `40`-game, three-window filtered screen still produced no
  candidate row after more than a minute beyond the modal baseline, so the beam
  branch remains rejected on compute.
- Early-rescue configs in `codex-scratch/dynamic-gap-config.js` tried switching
  from the current leader to lower-threshold, higher-red-gain variants only in
  bad visible states. The best small-screen rule
  (`risk10>=40 -> rescueSafe`) scored `135/200`, but failed the larger
  five-window check (`1509/2500` versus `1519/2500` for the current leader).
- A ranked-playbook screen under the current top-six safety wrapper tested
  nearby move-ordering weights. Lowering the merge weight from `185` to `150`
  looked promising on the documented ten-window suite (`6104/10000` versus
  `6069/10000`), but missed shifted validation (`6117/10000` versus
  `6122/10000`) and the independent five-window check (`2994/5000` versus
  `3012/5000`). A mixed 15-window half-suite rejected nearby merge values:
  `merge=185` scored `4560/7500`, while `merge=200` scored `4558/7500`,
  `merge=150` scored `4533/7500`, `merge=170` scored `4528/7500`, and
  `merge=160` scored `4527/7500`.
- Rechecking a tiny early safety-round rollout against the current top-six
  leader stayed weak. On a three-window `240`-game screen, the current leader
  scored `153/240`; `round1early`, `round1small`, and `round2tiny` reached only
  `127/240`, `137/240`, and `127/240`, respectively. This confirms the earlier
  synthetic-rollout result was not just an artifact of the old pressure policy.
- A small offline-trained public-state value function in
  `codex-scratch/learned-value-policy.js` fit ridge-regression coefficients from
  modal-policy traces, then used those fixed coefficients at runtime to evaluate
  a bounded candidate set by exact public RED battle outcomes after
  reinforcement. It stayed strict at runtime: no `api.rng()`, seed recovery,
  board lookup, or benchmark-order state. Training only on post-opening states
  produced a tiny `120`-game validation lead (`82/120` versus `79/120` for
  `codexModalOpeningGap`), but the larger mixed `1000`-game screen rejected it:
  `learnedTight` scored `584/1000` and `learned` `566/1000`, versus `635/1000`
  for the modal leader.
- Raising the promoted opening risk weight above `75` also failed to generalize.
  `riskWeight=100` screened at `1521/2500` versus `1519/2500`, then scored
  `6073/10000` on the documented suite versus `6069/10000`, but missed shifted
  validation (`6120/10000` versus `6122/10000`), so the production opening gate
  stayed at `riskWeight=75`.
- A later state-gated stop-threshold attempt retested
  `codex-scratch/dynamic-gap-config.js` with the promoted opening gate
  (`riskWeight=75`). A tiny screen suggested raising `minScore` to `220` after
  RED grew past six nodes, and a shifted `1000`-game probe improved to
  `622/1000` versus `616/1000` for the current leader. It failed the documented
  ten-window validation at `6025/10000` versus `6069/10000`, so the fixed
  post-opening threshold stayed unchanged.
- A bounded expected-position strategy in `codex-scratch/potential-topk.js`
  tried a cleaner algorithm: rank a few candidate moves, then use exact public
  battle outcome probabilities to maximize the expected board value after RED
  reinforcement. It stayed strict, but missed the compute target before proving
  strength: a small grid over `50` games on three seed windows did not complete
  in roughly ninety seconds, and even a hand-picked `60`-game comparison left
  the first potential variant unfinished after more than a minute while the
  current leader completed at about `6.3 ms/game`.
- Reduced-width versions of the current exact-safety strategy were fast but too
  weak. With the promoted opening gate on a five-window `1500`-game screen,
  `topK=3,countWeight=12` scored `891/1500`, `topK=3,countWeight=14` scored
  `895/1500`, `topK=4,countWeight=12` scored `890/1500`, and
  `topK=4,countWeight=14` scored `894/1500`, versus `920/1500` for the current
  top-six policy. The top-two fast variant also did not benefit from the newer
  opening gate on a `2500`-game check (`1486/2500` versus `1487/2500` with the
  default opening, while current top-six scored `1519/2500`).
- A ranked-axis grid in `codex-scratch/ranked-axis-grid.js` kept the current
  top-six exact-safety algorithm and varied one underlying ranked move-ordering
  weight at a time. Raising `lowChancePenalty` to `255` screened at `1527/2500`
  versus `1519/2500`, but only tied shifted validation (`1534/2500`) and failed
  the mixed half-suite (`3026/5000` versus `3038/5000`). Other small-screen
  leaders also failed mixed validation: `capture=36` scored `1519/2500` and
  `largestTouch=0` scored `1521/2500` versus `1523/2500`. Raising
  `strongTargetPenalty` to `8` survived the half-suites (`1530/2500` versus
  `1523/2500`, then `1546/2500` versus `1545/2500`) but failed the documented
  ten-window validation (`6059/10000` versus `6069/10000`), so the production
  ranked playbook stayed unchanged.
- A pass-opening check showed that passing the first RED turn was still weaker
  for the gap policies on a five-window `2500`-game screen:
  `gap2-pass 1478/2500` versus `gap2-defend 1487/2500`, and
  `gap5-pass 1493/2500` versus `gap5-defend 1515/2500`.
- A bot-target safety scorer in `codex-scratch/bot-choice-safety.js` was retested
  with the current dynamic threat weight and top-five candidates. It stayed
  below the top-five gap baseline on a five-window `1000`-game screen; the best
  tested bot-target row scored `612/1000` versus `623/1000` for the baseline,
  and some variants were much slower.

The exported Monte Carlo helper in `codex-strategy/strategy.js` now uses a
deterministic hash of the visible board for synthetic rollout randomness instead
of consuming `api.rng()`. Tiny legalized rollout settings were tested and were
both slow and ineffective (`0/50` wins at 38-83 ms/game), so it is intentionally
not registered as a contender. A later retest against `codexModalOpeningGap`
again exceeded the practical screen budget: the modal baseline completed a
three-window `90`-game slice at `57/90`, while the Monte Carlo candidates had no
result after roughly a minute, so this branch remains out of scope for the
requested compute profile.

Current strict JS confirmation after tightening the strict filter:

```text
node compare-strategies.js 1000 1 --no-rl --strict
codexModalScout           67.8%  678/1000
codexModalOpeningGap      62.5%  625/1000
codexSafetyGap2ThreatFast  61.3%  613/1000
codexSafetyThreat36        60.5%  605/1000
codexSafetyGap2ThreatTop5  60.5%  605/1000
codexSafetyK2              60.1%  601/1000
codexSafetyGap2Threat      60.0%  600/1000
codexSafetyGap2ThreatTop6  59.9%  599/1000
```
