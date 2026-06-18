'use strict';

// Flat strategy registry for comparing RED policies against the built-in bots.
// JS entries are callable sim.js policies. RL entries are evaluated externally
// through rl/evaluate.py because the trained PPO policy lives in Python/Torch.

const sim = require('./sim');
const rootStrategy = require('./strategy');
const experiments = require('./experiments');
const codex = require('./codex-strategy/strategy');
const seedOracle = require('./codex-strategy/seed-oracle');

const jsStrategies = {
  // Built-in baselines from sim.js.
  passive: sim.passive,
  randomAll: sim.randomAll,
  greedyWeakest: sim.greedyWeakest,
  safeExpand: sim.safeExpand,
  cautiousExpand: sim.cautiousExpand,

  // Existing root strategy.
  denyLeader: rootStrategy.denyLeader,

  // Experiment policies and representative factory variants.
  bestFirst: experiments.bestFirst,
  bestFirstWeak: experiments.bestFirstWeak,
  spearDeep: experiments.spearDeep,
  'threshold.10': experiments.makeThreshold(0.10),
  'threshold.20': experiments.makeThreshold(0.20),
  'spearhead.10': experiments.makeSpearhead(0.10),
  'spearhead.20': experiments.makeSpearhead(0.20),
  'maxExpand.10': experiments.makeMaxExpand(0.10),
  'maxExpand.20': experiments.makeMaxExpand(0.20),
  'connect.20': experiments.makeConnect(0.20, false),
  'connect.20mop': experiments.makeConnect(0.20, true),
  'hybrid.10': experiments.makeHybrid(0.10),
  'planner.10': experiments.makePlanner(0.10),
  'deny.15': experiments.makeDenyLeader(0.15),
  'deny.10': experiments.makeDenyLeader(0.10),
  'deny.05': experiments.makeDenyLeader(0.05),
  'deny.0': experiments.makeDenyLeader(0.0),

  // Codex-tuned strategies.
  codexStrategy: codex.codexStrategy,
  codexPressure: codex.codexPressure,
  codexDelayedPressure: codex.codexDelayedPressure,
  codexDelayedMerge: codex.codexDelayedMerge,
  codexOpeningDefenseDelay: codex.codexOpeningDefenseDelay,
  codexSafetyK2: codex.codexSafetyK2,
  codexSafetyThreat36: codex.codexSafetyThreat36,
  codexSafetyGap2ThreatFast: codex.codexSafetyGap2ThreatFast,
  codexSafetyGap2ThreatTop5: codex.codexSafetyGap2ThreatTop5,
  codexSafetyGap2ThreatTop6: codex.codexSafetyGap2ThreatTop6,
  codexSafetyGap2Threat: codex.codexSafetyGap2Threat,
  codexModalScout: codex.codexModalScout,
  codexModalOpeningGap: codex.codexModalOpeningGap,
  codexC1: codex.codexC1,
  codexC4: codex.codexC4,
  codexLegacyTuned: codex.makeRankedStrategy(codex.LEGACY_TUNED_RANKED_OPTIONS),
  seedOracle: seedOracle.seedOracleStrategy,
};

const nonStrictJs = new Set([
  'randomAll',
  'seedOracle',
]);

const externalStrategies = {
  'rlPPO.argmax': {
    kind: 'python-rl',
    checkpoint: 'rl/policy_final.pt',
    script: 'rl/v1_snapshot/evaluate.py',
    policyModule: 'policy',
    sample: false,
    strict: true,
  },
  'rlPPO.sampled': {
    kind: 'python-rl',
    checkpoint: 'rl/policy_final.pt',
    script: 'rl/v1_snapshot/evaluate.py',
    policyModule: 'policy',
    sample: true,
    strict: false,
  },
  'rlCNN.argmax': {
    kind: 'python-rl',
    checkpoint: 'rl/policy_cnn_v3.pt',
    script: 'rl/v1_snapshot/evaluate.py',
    policyModule: 'policy_cnn',
    sample: false,
    strict: true,
  },
  'rlCNN.latest.argmax': {
    kind: 'python-rl',
    checkpoint: 'rl/experiments/178106301897/model_000400.pt',
    script: 'rl/evaluate.py',
    policyModule: 'policy_cnn',
    sample: false,
    strict: true,
  },
  'rlCNN.sampled': {
    kind: 'python-rl',
    checkpoint: 'rl/policy_cnn_v3.pt',
    script: 'rl/v1_snapshot/evaluate.py',
    policyModule: 'policy_cnn',
    sample: true,
    strict: false,
  },
};

const strategies = {
  ...Object.fromEntries(Object.entries(jsStrategies).map(([name, policy]) => [
    name,
    { kind: 'js', policy, strict: !nonStrictJs.has(name) },
  ])),
  ...externalStrategies,
};

module.exports = {
  strategies,
  jsStrategies,
  externalStrategies,
};
