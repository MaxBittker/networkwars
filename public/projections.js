// One value at the first decision of each turn. Preserve missing values so a
// later post-battle estimate cannot slide back to the start of that turn.
function turnStartCurve(moves, valueAt) {
  const out = [];
  let turn = 1;
  for (let k = 0; k < moves.length; k++) {
    if (!out.length || out.at(-1).t !== turn)
      out.push({ t: turn, q: valueAt(k) ?? null });
    if (moves[k].e) turn++;
  }
  return out;
}

// AI values were recorded during play; human values come from the review's
// recommended move, representing the position before the recorded decision.
export const aiWinCurve = moves => turnStartCurve(moves, k => moves[k].q);
export const youWinCurve = (review, moves) =>
  turnStartCurve(moves, k => review?.moves[k]?.bestQ);
