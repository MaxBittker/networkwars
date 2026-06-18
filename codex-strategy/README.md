# Codex Strategy

This folder contains a self-contained RED strategy for the existing `sim.js`
policy API. It does not modify the shared top-level game files.

## Use

```js
const {
  codexModalScout,
  codexModalOpeningGap,
  codexSafetyGap2Threat,
  codexSafetyGap2ThreatFast,
  codexSafetyGap2ThreatTop5,
  codexSafetyGap2ThreatTop6,
} = require('./codex-strategy/strategy');
```

`codexModalScout(api)` is the strongest broad-validation strict policy in this
folder. On the opening turn it may make up to two high-confidence attacks
chosen by exact public RED battle outcomes plus a deterministic public model of
the next bot round. That bot model applies each bot's greedy attacks with the
most likely public battle outcome; it does not consume or infer the actual RNG.
After opening, it starts from the same top-six exact-safety midgame as
`codexModalOpeningGap`, then lets a small one-round modal scout override the
baseline move only when the public simulation sees a clear next-round swing.

No-cheating boundary: strict strategies here must not call `api.rng()`, recover
or derive seeds, mutate live nodes, memorize boards, or use benchmark-order
state.

`codexModalOpeningGap(api)` is the previous broad-validation strict leader. It
uses the same modal opening as `codexModalScout`, but after opening it always
uses the top-six exact-safety midgame without the modal scout override.

`codexSafetyGap2Threat(api)` is the previous pre-modal strict leader. It
uses exact visible-state safety expectation for the opening and the same top-six
midgame used by `codexModalOpeningGap`.

`codexSafetyGap2ThreatTop5(api)` is the previous top-five/count-12 broad leader.
It remains registered for flat comparison because it scores better on canonical
seeds than the top-six broad leader.

`codexSafetyGap2ThreatTop6(api)` is the previous top-six/count-14 broad leader
with the default opening gate. It remains registered because the promoted
opening-risk variant is only a small broad-validation improvement.

`codexSafetyGap2ThreatFast(api)` is the same gap-triggered threat policy with
the original top-two candidate cap. It is faster and scores best on canonical
seeds, while the top-six `codexSafetyGap2Threat` variant scores better across
broader validation suites.

`codexSafetyK2(api)` is the previous broad-validation leader and the base policy
for `codexSafetyGap2Threat`.

`codexSafetyThreat36(api)` is the same policy with a higher threatened-red-node
weight. It is useful for comparison because it scores better on canonical seeds,
but it did not beat `codexSafetyK2` across the broader ten-window check.

The earlier `codexStrategy(api)` locks in one of two tuned ranked policies from
the opening board:

- `codexC1`: used when the opening has at least 13 attacks with capture odds
  above 0.4.
- `codexC4`: used otherwise. This is the most robust single policy found.

Run the local comparison benchmark with:

```sh
node codex-strategy/benchmark.js 1000
```

## Validation

Best validation run:

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

Across ten 1,000-game windows (`1`, `1001`, `2001`, `10001`, `50001`,
`900001`, `910001`, `920001`, `930001`, and `940001` seed bases),
`codexModalScout` scored `6615/10000` at roughly `18.9 ms/game`.
`codexModalOpeningGap` scored `6349/10000` at roughly `11.7 ms/game`.
`codexSafetyGap2Threat` scored `6069/10000` at roughly `6.6 ms/game`.
`codexSafetyGap2ThreatTop6` scored `6059/10000` at roughly `6.4 ms/game`.
`codexSafetyGap2ThreatTop5` scored `6034/10000` at roughly `5.1 ms/game`.
`codexSafetyGap2ThreatFast` scored `5989/10000` at roughly `4.7 ms/game`.
`codexSafetyK2` scored `5983/10000`.
`codexSafetyThreat36` scored `5979/10000` on the same check.

On a shifted ten-window suite (`950001` through `1040001` by 10,000),
`codexModalScout` scored `6625/10000`, versus `6304/10000` for
`codexModalOpeningGap`, `6122/10000` for `codexSafetyGap2Threat`, `6118/10000`
for `codexSafetyGap2ThreatTop6`, and `6079/10000` for
`codexSafetyGap2ThreatTop5`. On independent shifted bases `1050001` through
`1090001`, it scored `3310/5000`, versus `3100/5000` for
`codexModalOpeningGap` and `3012/5000` for `codexSafetyGap2Threat`.
