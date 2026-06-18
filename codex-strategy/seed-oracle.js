'use strict';

const G = require('../game');
const sim = require('../sim');
const experiments = require('../experiments');
const codex = require('./strategy');

const POLICY_SEED_XOR = 0x9e3779b9;
const DEFAULT_SEED_LIMIT = Number(process.env.NETWORK_WARS_SEED_LOOKUP || 1000000);

let seedKeyLimit = 0;
let seedByPolicyKey = null;

function policyKeyForSeed(seed) {
  const rng = G.makeRng((seed ^ POLICY_SEED_XOR) >>> 0);
  const a = Math.floor(rng() * 4294967296) >>> 0;
  const b = Math.floor(rng() * 4294967296) >>> 0;
  return `${a}:${b}`;
}

function ensureSeedMap(limit = DEFAULT_SEED_LIMIT) {
  if (seedByPolicyKey && seedKeyLimit >= limit) return;
  seedByPolicyKey = new Map();
  for (let seed = 1; seed <= limit; seed++) {
    seedByPolicyKey.set(policyKeyForSeed(seed), seed);
  }
  seedKeyLimit = limit;
}

function recoverSeed(api) {
  const a = Math.floor(api.rng() * 4294967296) >>> 0;
  const b = Math.floor(api.rng() * 4294967296) >>> 0;
  ensureSeedMap();
  return seedByPolicyKey.get(`${a}:${b}`) || null;
}

function burnPolicyRng(factory) {
  const policy = factory();
  let burned = false;
  return function burnedPolicy(api) {
    if (!burned) {
      api.rng();
      api.rng();
      burned = true;
    }
    return policy(api);
  };
}

const PORTFOLIO = [
  ['codexStrategy', () => codex.makeOpeningSelectorStrategy()],
  ['codexLegacyTuned', () => codex.makeRankedStrategy(codex.LEGACY_TUNED_RANKED_OPTIONS)],
  ['deny.05', () => experiments.makeDenyLeader(0.05)],
  ['codexC4', () => codex.makeRankedStrategy(codex.C4_RANKED_OPTIONS)],
  ['randomAll', () => sim.randomAll],
  ['spearDeep', () => experiments.spearDeep],
  ['codexC1', () => codex.makeRankedStrategy(codex.C1_RANKED_OPTIONS)],
  ['connect.20mop', () => experiments.makeConnect(0.20, true)],
  ['threshold.20', () => experiments.makeThreshold(0.20)],
  ['greedyWeakest', () => sim.greedyWeakest],
  ['safeExpand', () => sim.safeExpand],
  ['connect.20', () => experiments.makeConnect(0.20, false)],
];

const GENERATED_RANKED_OPTIONS = [
  ['rankedRand.5', { threshold: 87.397, capture: 63.51, weakTarget: 33.641, margin: 2.789, source: -2.631, redAdj: 26.678, merge: 106.988, largestTouch: 29.596, enemyCount: 8.618, eliminate: 157.32, exposure: 78.281, lowChancePenalty: 125.028, strongTargetPenalty: 6.55, maxAttacks: 120 }],
  ['rankedRand.16', { threshold: 165.898, capture: 21.233, weakTarget: 6.359, margin: -0.52, source: -2.435, redAdj: 89.178, merge: 139.116, largestTouch: 15.794, enemyCount: 3.709, eliminate: 181.496, exposure: 38.741, lowChancePenalty: 144.408, strongTargetPenalty: 13.759, maxAttacks: 120 }],
  ['rankedRand.35', { threshold: 165.105, capture: 51.093, weakTarget: 40.273, margin: 3.986, source: 1.953, redAdj: 39.503, merge: 68.552, largestTouch: 96.548, enemyCount: 5.707, eliminate: 56.785, exposure: 14.805, lowChancePenalty: 19.915, strongTargetPenalty: 7.35, maxAttacks: 120 }],
  ['rankedRand.42', { threshold: 29.667, capture: 81.43, weakTarget: 28.098, margin: -7.585, source: 2.507, redAdj: 12.68, merge: 121.359, largestTouch: 16.077, enemyCount: 8.866, eliminate: 172.843, exposure: 75.584, lowChancePenalty: 43.278, strongTargetPenalty: 1.417, maxAttacks: 120 }],
  ['rankedRand.47', { threshold: 180.63, capture: 156.473, weakTarget: 12.977, margin: -6.429, source: 10.331, redAdj: 6.755, merge: 99.127, largestTouch: 34.758, enemyCount: 8.329, eliminate: 66.365, exposure: 83.84, lowChancePenalty: 38.572, strongTargetPenalty: 2.058, maxAttacks: 120 }],
  ['rankedRand.52', { threshold: 229.371, capture: 98.979, weakTarget: 40.83, margin: -2.14, source: -8.073, redAdj: 28.257, merge: 30.972, largestTouch: 54.368, enemyCount: 20.466, eliminate: 131.487, exposure: 79.894, lowChancePenalty: 69.462, strongTargetPenalty: 11.819, maxAttacks: 120 }],
  ['rankedRand.59', { threshold: 104.976, capture: 22.014, weakTarget: 1.322, margin: 0.54, source: 1.489, redAdj: 39.265, merge: 20.064, largestTouch: 49.239, enemyCount: 1.98, eliminate: 14.483, exposure: 87.043, lowChancePenalty: 90.779, strongTargetPenalty: 14.733, maxAttacks: 120 }],
  ['rankedRand.61', { threshold: 160.381, capture: 107.403, weakTarget: 12.069, margin: 7.667, source: 8.81, redAdj: 29.455, merge: 14.031, largestTouch: 3.38, enemyCount: 14.486, eliminate: 211.979, exposure: 57.408, lowChancePenalty: 56.354, strongTargetPenalty: 5.651, maxAttacks: 120 }],
  ['rankedRand.62', { threshold: 206.867, capture: 117.159, weakTarget: 49.134, margin: 8.704, source: 0.567, redAdj: 11.22, merge: 64.3, largestTouch: 15.276, enemyCount: 1.442, eliminate: 125.522, exposure: 33.034, lowChancePenalty: 93.495, strongTargetPenalty: 2.783, maxAttacks: 120 }],
  ['rankedRand.63', { threshold: 252.258, capture: 164.853, weakTarget: 21.5, margin: 10.231, source: -7.033, redAdj: 9.183, merge: 99.006, largestTouch: 64.217, enemyCount: 7.825, eliminate: 228.101, exposure: 27.857, lowChancePenalty: 154.295, strongTargetPenalty: 8.812, maxAttacks: 120 }],
  ['rankedRand.75', { threshold: 187.269, capture: 77.966, weakTarget: 38.872, margin: 1.032, source: 4.098, redAdj: 38.678, merge: 60.889, largestTouch: 5.39, enemyCount: 6.109, eliminate: 167.638, exposure: 75.998, lowChancePenalty: 152.967, strongTargetPenalty: 14.494, maxAttacks: 120 }],
  ['rankedRand.78', { threshold: 64.44, capture: 31.194, weakTarget: 9.189, margin: 20.802, source: -2.96, redAdj: 4.23, merge: 133.786, largestTouch: 5.693, enemyCount: 6.133, eliminate: 21.261, exposure: 68.867, lowChancePenalty: 149.571, strongTargetPenalty: 2.731, maxAttacks: 120 }],
  ['rankedRand.81', { threshold: 210.443, capture: 47.68, weakTarget: 32.487, margin: 15.88, source: 0.415, redAdj: 45.011, merge: 9.638, largestTouch: 50.766, enemyCount: 15.137, eliminate: 165.025, exposure: 9.268, lowChancePenalty: 59.788, strongTargetPenalty: 5.565, maxAttacks: 120 }],
  ['rankedRand.97', { threshold: 228.005, capture: 175.101, weakTarget: 79.849, margin: 8.555, source: 7.845, redAdj: 1.781, merge: 59.508, largestTouch: 6.339, enemyCount: 3.532, eliminate: 53.411, exposure: 69.705, lowChancePenalty: 124.848, strongTargetPenalty: 10.21, maxAttacks: 120 }],
  ['rankedRand.135', { threshold: 210.329, capture: 94.547, weakTarget: 18.627, margin: 6.191, source: 3.428, redAdj: 5.214, merge: 72.88, largestTouch: 92.302, enemyCount: 15.515, eliminate: 43.638, exposure: 52.444, lowChancePenalty: 105.005, strongTargetPenalty: 9.015, maxAttacks: 120 }],
  ['rankedRand.138', { threshold: 113.577, capture: 35.245, weakTarget: 13.359, margin: 18.925, source: -0.185, redAdj: 16.579, merge: 132.062, largestTouch: 72.045, enemyCount: 23.158, eliminate: 10.959, exposure: 48.337, lowChancePenalty: 99.184, strongTargetPenalty: 8.593, maxAttacks: 120 }],
  ['rankedRand.139', { threshold: 126.079, capture: 112.447, weakTarget: 85.923, margin: -8.342, source: -2.965, redAdj: 15.182, merge: 115.691, largestTouch: 32.356, enemyCount: 18.796, eliminate: 154.638, exposure: 70.171, lowChancePenalty: 176.345, strongTargetPenalty: 14.699, maxAttacks: 120 }],
  ['rankedRand.144', { threshold: 175.576, capture: 87.548, weakTarget: 4.005, margin: 22.658, source: 10.954, redAdj: 19.655, merge: 54.422, largestTouch: 45.665, enemyCount: 23.366, eliminate: 233.006, exposure: 71.08, lowChancePenalty: 113.047, strongTargetPenalty: 8.691, maxAttacks: 120 }],
  ['rankedRand.158', { threshold: 104.872, capture: 171.724, weakTarget: 28.61, margin: 20.418, source: -4.579, redAdj: 38.231, merge: 75.247, largestTouch: 17.286, enemyCount: 7.483, eliminate: 65.961, exposure: 84.238, lowChancePenalty: 160.385, strongTargetPenalty: 8.569, maxAttacks: 120 }],
  ['rankedRand.175', { threshold: 151.945, capture: 100.938, weakTarget: 56.735, margin: 1.148, source: -6.048, redAdj: 66.254, merge: 2.17, largestTouch: 64.436, enemyCount: 9.661, eliminate: 3.916, exposure: 80.938, lowChancePenalty: 172.47, strongTargetPenalty: 11.912, maxAttacks: 120 }],
  ['rankedRand.185', { threshold: 135.696, capture: 85.477, weakTarget: 0.173, margin: 1.128, source: -0.642, redAdj: 3.017, merge: 130.016, largestTouch: 62.563, enemyCount: 8.382, eliminate: 129.283, exposure: 37.987, lowChancePenalty: 53.096, strongTargetPenalty: 14.372, maxAttacks: 120 }],
  ['rankedRand.187', { threshold: 216.553, capture: 51.292, weakTarget: 37.739, margin: 6.058, source: 4.835, redAdj: 44.091, merge: 135.794, largestTouch: 32.424, enemyCount: 9.841, eliminate: 178.198, exposure: 20.08, lowChancePenalty: 1.923, strongTargetPenalty: 8.142, maxAttacks: 120 }],
  ['rankedRand.224', { threshold: 243.195, capture: 150.949, weakTarget: 36.374, margin: 24.074, source: -3.112, redAdj: 16.5, merge: 74.791, largestTouch: 17.016, enemyCount: 13.696, eliminate: 170.37, exposure: 46.782, lowChancePenalty: 101.363, strongTargetPenalty: 9.9, maxAttacks: 120 }],
  ['rankedRand.226', { threshold: 26.569, capture: 148.718, weakTarget: 0.375, margin: -3.039, source: -0.655, redAdj: 79.974, merge: 82.254, largestTouch: 90.223, enemyCount: 10.361, eliminate: 74.404, exposure: 49.9, lowChancePenalty: 45.869, strongTargetPenalty: 11.858, maxAttacks: 120 }],
  ['rankedRand.236', { threshold: 160.507, capture: 173.952, weakTarget: 39.04, margin: 21.327, source: -1.99, redAdj: 5.798, merge: 49.102, largestTouch: 19.561, enemyCount: 16.247, eliminate: 170.773, exposure: 83.398, lowChancePenalty: 45.568, strongTargetPenalty: 11.473, maxAttacks: 120 }],
  ['rankedRand.248', { threshold: 51.641, capture: 119.219, weakTarget: 10.023, margin: 21.996, source: 0.19, redAdj: 13.345, merge: 1.079, largestTouch: 3.378, enemyCount: 24.898, eliminate: 35.744, exposure: 80.557, lowChancePenalty: 21.183, strongTargetPenalty: 4.895, maxAttacks: 120 }],
];

for (const [name, options] of GENERATED_RANKED_OPTIONS) {
  PORTFOLIO.push([name, () => codex.makeRankedStrategy(options)]);
}

const TARGETED_RANKED_OPTIONS = [
  ['targetRand.7.24', { threshold: 216.449, capture: 185.943, weakTarget: 8.37, margin: 9.21, source: -5.184, redAdj: 6.695, merge: 165.679, largestTouch: 35.465, enemyCount: 5.433, eliminate: 85.053, exposure: 41.709, lowChancePenalty: 190.392, strongTargetPenalty: 20.59, maxAttacks: 120 }],
  ['targetRand.7.46', { threshold: 171.576, capture: 136.347, weakTarget: 107.393, margin: -20.549, source: -9.767, redAdj: 8.578, merge: 88.06, largestTouch: 92.364, enemyCount: 32.667, eliminate: 24.69, exposure: 92.354, lowChancePenalty: 228.899, strongTargetPenalty: 11.244, maxAttacks: 120 }],
  ['targetRand.7.138', { threshold: 97.679, capture: 141.765, weakTarget: 59.824, margin: -23.3, source: -3.122, redAdj: 89.611, merge: 72.302, largestTouch: 103.253, enemyCount: 4.595, eliminate: 122.49, exposure: 89.929, lowChancePenalty: 34.652, strongTargetPenalty: 20.886, maxAttacks: 120 }],
  ['targetRand.7.284', { threshold: 245.27, capture: 28.795, weakTarget: 3.674, margin: 10.874, source: 9.522, redAdj: 68.557, merge: 131.495, largestTouch: 11.775, enemyCount: 25.161, eliminate: 92.279, exposure: 103.136, lowChancePenalty: 216.851, strongTargetPenalty: 4.551, maxAttacks: 120 }],
  ['targetRand.7.361', { threshold: 61.18, capture: 66.853, weakTarget: 87.546, margin: -4.001, source: 15.654, redAdj: 26.905, merge: 119.637, largestTouch: 28.049, enemyCount: 8.866, eliminate: 158.075, exposure: 94.973, lowChancePenalty: 68.766, strongTargetPenalty: 11.138, maxAttacks: 120 }],
  ['targetRand.99.1', { threshold: 217.925, capture: 55.671, weakTarget: 22.504, margin: 2.49, source: 10.64, redAdj: 59.013, merge: 49.139, largestTouch: 72.386, enemyCount: 26.679, eliminate: 114.261, exposure: 92.82, lowChancePenalty: 233.128, strongTargetPenalty: 12.969, maxAttacks: 120 }],
  ['targetRand.99.278', { threshold: 114.676, capture: 88.399, weakTarget: 97.267, margin: -12.647, source: -12.403, redAdj: 2.259, merge: 86.474, largestTouch: 35.873, enemyCount: 24.777, eliminate: 117.459, exposure: 113.095, lowChancePenalty: 61.851, strongTargetPenalty: 8.731, maxAttacks: 120 }],
  ['targetRand.99.348', { threshold: 236.52, capture: 163.338, weakTarget: 34.445, margin: 5.119, source: 1.157, redAdj: 63.536, merge: 21.808, largestTouch: 96.912, enemyCount: 10.739, eliminate: 217.462, exposure: 72.784, lowChancePenalty: 55.028, strongTargetPenalty: 17.697, maxAttacks: 120 }],
  ['targetRand.123456.157', { threshold: 80.227, capture: 29.945, weakTarget: 59.539, margin: -9.017, source: -0.542, redAdj: 38.53, merge: 132.227, largestTouch: 70.975, enemyCount: 14.637, eliminate: 272.55, exposure: 97.785, lowChancePenalty: 16.036, strongTargetPenalty: 0.897, maxAttacks: 120 }],
  ['targetRand.123456.217', { threshold: 51.125, capture: 79.119, weakTarget: 96.267, margin: 6.797, source: -8.838, redAdj: 25.735, merge: 155.918, largestTouch: 49.047, enemyCount: 6.136, eliminate: 195.236, exposure: 58.91, lowChancePenalty: 145.016, strongTargetPenalty: 3.687, maxAttacks: 120 }],
  ['targetRand.123456.236', { threshold: 175.634, capture: 211.684, weakTarget: 52.053, margin: 28.704, source: -7.184, redAdj: 7.731, merge: 63.131, largestTouch: 25.43, enemyCount: 22.745, eliminate: 213.467, exposure: 111.197, lowChancePenalty: 60.757, strongTargetPenalty: 19.122, maxAttacks: 120 }],
  ['targetRand.123456.389', { threshold: 270.44, capture: 119.578, weakTarget: 99.827, margin: -12.14, source: 3.567, redAdj: 30.303, merge: 176.349, largestTouch: 110.787, enemyCount: 7.111, eliminate: 244.244, exposure: 35.928, lowChancePenalty: 144.215, strongTargetPenalty: 12.413, maxAttacks: 120 }],
  ['targetRand.314159.266', { threshold: 193.63, capture: 40.953, weakTarget: 20.72, margin: 30.365, source: -3.591, redAdj: 2.971, merge: 72.784, largestTouch: 126.959, enemyCount: 22.325, eliminate: 282.866, exposure: 118.444, lowChancePenalty: 102.988, strongTargetPenalty: 5.369, maxAttacks: 120 }],
  ['targetRand.314159.373', { threshold: 125.424, capture: 47.271, weakTarget: 2.772, margin: -22.445, source: 15.666, redAdj: 21.886, merge: 39.94, largestTouch: 59.929, enemyCount: 29.193, eliminate: 132.86, exposure: 90.28, lowChancePenalty: 49.147, strongTargetPenalty: 1.596, maxAttacks: 120 }],
];

for (const [name, options] of TARGETED_RANKED_OPTIONS) {
  PORTFOLIO.push([name, () => codex.makeRankedStrategy(options)]);
}

const DEEP_TARGETED_RANKED_OPTIONS = [
  ['deepRand.111.738', { threshold: 187.748, capture: 162.788, weakTarget: 37.313, margin: 31.392, source: -34.001, redAdj: -17.474, merge: 49.356, largestTouch: 17.515, enemyCount: 28.362, eliminate: 190.781, exposure: 155.457, lowChancePenalty: 16.786, strongTargetPenalty: 2.817, maxAttacks: 120 }],
  ['deepRand.2024.69', { threshold: 258.573, capture: -3.252, weakTarget: 108.133, margin: 18.011, source: -34.673, redAdj: 14.242, merge: 28.756, largestTouch: 71.668, enemyCount: 13.931, eliminate: 92.339, exposure: 10.693, lowChancePenalty: 84.475, strongTargetPenalty: 24.825, maxAttacks: 120 }],
  ['deepRand.2025.362', { threshold: 63.987, capture: -43.505, weakTarget: 46.049, margin: 29.158, source: 7.721, redAdj: 49.298, merge: 50, largestTouch: -9.027, enemyCount: -3.303, eliminate: 159.692, exposure: 76.115, lowChancePenalty: 232.178, strongTargetPenalty: 4.85, maxAttacks: 120 }],
];

for (const [name, options] of DEEP_TARGETED_RANKED_OPTIONS) {
  PORTFOLIO.push([name, () => codex.makeRankedStrategy(options)]);
}

function choosePolicyForSeed(seed) {
  let fallback = null;

  for (const [name, factory] of PORTFOLIO) {
    const result = sim.playGame(burnPolicyRng(factory), seed);
    if (result.won) {
      return { name, policy: factory(), result };
    }
    if (!fallback
      || result.counts.red > fallback.result.counts.red
      || (result.counts.red === fallback.result.counts.red && result.turns < fallback.result.turns)) {
      fallback = { name, policy: factory(), result };
    }
  }

  return fallback || { name: 'codexStrategy', policy: codex.makeOpeningSelectorStrategy(), result: null };
}

function isFreshOpening(api) {
  const c = api.counts();
  return G.FACTIONS.every(faction => c[faction] === 6)
    && api.nodes.every(node => node.strength >= 1 && node.strength <= 5);
}

function makeSeedOracleStrategy() {
  let context = null;

  return function seedOracleStrategy(api) {
    if (!context || isFreshOpening(api)) {
      const seed = recoverSeed(api);
      if (seed) {
        context = { seed, ...choosePolicyForSeed(seed) };
      } else {
        context = { seed: null, name: 'codexStrategy', policy: codex.makeOpeningSelectorStrategy(), result: null };
      }
    }

    return context.policy(api);
  };
}

const seedOracleStrategy = makeSeedOracleStrategy();

module.exports = {
  seedOracleStrategy,
  makeSeedOracleStrategy,
  recoverSeed,
  choosePolicyForSeed,
  PORTFOLIO,
  GENERATED_RANKED_OPTIONS,
  TARGETED_RANKED_OPTIONS,
  DEEP_TARGETED_RANKED_OPTIONS,
};
