'use strict';

// Strict scratch search for a tiny visible-feature selector between the two
// best SafetyK2 variants. Runtime policy candidates use only public opening
// features and then delegate to a normal strict strategy.

const G = require('../game');
const sim = require('../sim');
const codex = require('../codex-strategy/strategy');

const FACTIONS = ['red', 'green', 'yellow', 'blue', 'purple'];
const BOTS = ['green', 'yellow', 'blue', 'purple'];
const HUMAN = 'red';

function makeInitialState(seed) {
  const rng = G.makeRng(seed >>> 0);
  return { ...G.buildBoard(rng), rng };
}

function counts(state) {
  const out = Object.fromEntries(FACTIONS.map(f => [f, 0]));
  for (const n of state.nodes) out[n.owner]++;
  return out;
}

function components(state, faction) {
  const seen = new Set();
  const out = [];
  for (const n of state.nodes) {
    if (n.owner !== faction || seen.has(n.id)) continue;
    const comp = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop();
      comp.push(id);
      for (const nb of state.adj[id]) {
        if (state.nodes[nb].owner === faction && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function legalMoves(state) {
  const moves = [];
  for (const n of state.nodes) {
    if (n.owner !== HUMAN || n.strength <= 1) continue;
    for (const to of state.adj[n.id]) {
      if (state.nodes[to].owner !== HUMAN) moves.push({ from: n.id, to });
    }
  }
  return moves;
}

function openingFeatures(seed) {
  const state = makeInitialState(seed);
  const moves = legalMoves(state);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const comps = components(state, HUMAN);
  const largest = comps.reduce((best, comp) => Math.max(best, comp.length), 0);
  let good04 = 0;
  let good05 = 0;
  let high07 = 0;
  let pSum = 0;
  let pMax = 0;
  let weakTargets = 0;
  let enemyBeatsRed = 0;
  let redAdj = 0;
  const enemyTouch = new Set();

  for (const move of moves) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    pSum += p;
    pMax = Math.max(pMax, p);
    if (p > 0.4) good04++;
    if (p > 0.5) good05++;
    if (p > 0.7) high07++;
    if (to.strength <= 2) weakTargets++;
    enemyTouch.add(to.owner);
  }

  for (const red of redNodes) {
    for (const nbId of state.adj[red.id]) {
      const nb = state.nodes[nbId];
      if (nb.owner !== HUMAN) {
        redAdj++;
        if (nb.strength > red.strength) enemyBeatsRed++;
      }
    }
  }

  const redStrengths = redNodes.map(n => n.strength);
  return {
    legal: moves.length,
    good04,
    good05,
    high07,
    pAvg10: moves.length ? Math.round((pSum / moves.length) * 10) : 0,
    pMax10: Math.round(pMax * 10),
    weakTargets,
    redTotal: redStrengths.reduce((a, b) => a + b, 0),
    redMax: redStrengths.reduce((a, b) => Math.max(a, b), 0),
    redMin: redStrengths.reduce((a, b) => Math.min(a, b), 99),
    largest,
    redComps: comps.length,
    enemyBeatsRed,
    redAdj,
    enemyTouch: enemyTouch.size,
  };
}

function policyResult(factory, seed) {
  return sim.playGame(factory(), seed).won;
}

function collect(games, bases) {
  const rows = [];
  for (const seedBase of bases) {
    for (let i = 0; i < games; i++) {
      const seed = seedBase + i;
      rows.push({
        seed,
        features: openingFeatures(seed),
        k2: policyResult(() => codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 }), seed),
        threat36: policyResult(() => codex.makeSafetyK2Strategy({
          minScore: 210,
          splitWeight: 25,
          threatenedWeight: 36,
        }), seed),
      });
    }
  }
  return rows;
}

function scoreRule(rows, feature, op, cut, threatWhenTrue) {
  let wins = 0;
  for (const row of rows) {
    const value = row.features[feature];
    const test = op === '<=' ? value <= cut : value >= cut;
    const useThreat = test ? threatWhenTrue : !threatWhenTrue;
    if (useThreat ? row.threat36 : row.k2) wins++;
  }
  return wins;
}

function candidateRules(rows) {
  const features = Object.keys(rows[0].features);
  const rules = [];
  const baseK2 = rows.filter(r => r.k2).length;
  const baseThreat = rows.filter(r => r.threat36).length;
  rules.push({ label: 'alwaysK2', wins: baseK2 });
  rules.push({ label: 'alwaysThreat36', wins: baseThreat });

  for (const feature of features) {
    const values = [...new Set(rows.map(row => row.features[feature]))].sort((a, b) => a - b);
    for (const cut of values) {
      for (const op of ['<=', '>=']) {
        for (const threatWhenTrue of [true, false]) {
          const wins = scoreRule(rows, feature, op, cut, threatWhenTrue);
          const side = threatWhenTrue ? 'threat' : 'k2';
          rules.push({
            label: `${feature}${op}${cut}?${side}`,
            feature,
            op,
            cut,
            threatWhenTrue,
            wins,
          });
        }
      }
    }
  }

  rules.sort((a, b) => b.wins - a.wins || a.label.localeCompare(b.label));
  return rules;
}

function makeSelector(rule) {
  return function factory() {
    const k2 = codex.makeSafetyK2Strategy({ minScore: 210, splitWeight: 25 });
    const threat = codex.makeSafetyK2Strategy({
      minScore: 210,
      splitWeight: 25,
      threatenedWeight: 36,
    });
    let selected = null;
    return function selector(api) {
      const state = {
        nodes: api.nodes.map(n => ({
          id: n.id,
          x: n.x,
          y: n.y,
          owner: n.owner,
          strength: n.strength,
        })),
        adj: api.nodes.map(n => api.neighbors(n.id).slice()),
      };
      const c = counts(state);
      const opening = FACTIONS.every(f => c[f] === 6)
        && state.nodes.every(n => n.strength >= 1 && n.strength <= 5);

      if (opening || !selected) {
        if (opening) {
          const features = openingFeaturesFromState(state);
          const test = rule.op === '<='
            ? features[rule.feature] <= rule.cut
            : features[rule.feature] >= rule.cut;
          selected = (test ? rule.threatWhenTrue : !rule.threatWhenTrue) ? threat : k2;
        } else {
          selected = k2;
        }
      }

      return selected(api);
    };
  };
}

function openingFeaturesFromState(state) {
  const moves = legalMoves(state);
  const redNodes = state.nodes.filter(n => n.owner === HUMAN);
  const comps = components(state, HUMAN);
  const largest = comps.reduce((best, comp) => Math.max(best, comp.length), 0);
  let good04 = 0;
  let good05 = 0;
  let high07 = 0;
  let pSum = 0;
  let pMax = 0;
  let weakTargets = 0;
  let enemyBeatsRed = 0;
  let redAdj = 0;
  const enemyTouch = new Set();

  for (const move of moves) {
    const from = state.nodes[move.from];
    const to = state.nodes[move.to];
    const p = codex.captureProbability(from.strength, to.strength);
    pSum += p;
    pMax = Math.max(pMax, p);
    if (p > 0.4) good04++;
    if (p > 0.5) good05++;
    if (p > 0.7) high07++;
    if (to.strength <= 2) weakTargets++;
    enemyTouch.add(to.owner);
  }

  for (const red of redNodes) {
    for (const nbId of state.adj[red.id]) {
      const nb = state.nodes[nbId];
      if (nb.owner !== HUMAN) {
        redAdj++;
        if (nb.strength > red.strength) enemyBeatsRed++;
      }
    }
  }

  const redStrengths = redNodes.map(n => n.strength);
  return {
    legal: moves.length,
    good04,
    good05,
    high07,
    pAvg10: moves.length ? Math.round((pSum / moves.length) * 10) : 0,
    pMax10: Math.round(pMax * 10),
    weakTargets,
    redTotal: redStrengths.reduce((a, b) => a + b, 0),
    redMax: redStrengths.reduce((a, b) => Math.max(a, b), 0),
    redMin: redStrengths.reduce((a, b) => Math.min(a, b), 99),
    largest,
    redComps: comps.length,
    enemyBeatsRed,
    redAdj,
    enemyTouch: enemyTouch.size,
  };
}

function validateRule(rule, games, bases) {
  const factory = makeSelector(rule);
  let total = 0;
  let ms = 0;
  const parts = [];
  for (const seedBase of bases) {
    const result = sim.scorePolicy(factory(), { games, seedBase });
    total += result.wins;
    ms += result.totalMs;
    parts.push(`${seedBase}:${result.wins}/${games}`);
  }
  return { total, parts, msPerGame: ms / (games * bases.length) };
}

function main() {
  const games = Number(process.argv[2]) || 120;
  const bases = process.argv.slice(3).map(Number).filter(Number.isFinite);
  const trainBases = bases.length ? bases : [1, 1001, 10001];
  const rows = collect(games, trainBases);
  const rules = candidateRules(rows).slice(0, 15);
  console.log(`training ${rows.length} games`);
  for (const rule of rules) {
    console.log(`${rule.label.padEnd(30)} ${rule.wins}/${rows.length}`);
  }

  const validateBases = [1, 1001, 2001, 10001, 50001];
  console.log('\nvalidation');
  for (const rule of rules.slice(0, 8).filter(rule => rule.feature)) {
    const result = validateRule(rule, games, validateBases);
    console.log(`${rule.label.padEnd(30)} ${result.total}/${games * validateBases.length}  ${result.parts.join('  ')}  ${result.msPerGame.toFixed(2)}ms/game`);
  }
}

if (require.main === module) main();

module.exports = {
  candidateRules,
  collect,
  makeSelector,
  openingFeatures,
  openingFeaturesFromState,
  validateRule,
};
