# Network Wars — project instructions

## Gameplay policy
- **Never surrender.** When driving the real game (iOS mirroring or otherwise),
  play every game out to its natural terminal (a faction reaching 24 nodes). A
  losing or partial game is more valuable played to the end than forfeited —
  keep partial-game data, do not Surrender to reset. Restart only via the
  post-game (win/loss) modal's New Game / Play Again button.

## Engine (one C source of truth; pure MCTS — RL/neural-net path was removed)
- `solver/` is the engine + search + analysis subproject. **Pure C-UCT MCTS (no
  neural net) is our best algorithm** — the AlphaZero/PufferLib training path was
  dropped (it plateaued below the search; findings in memory
  `alphago-levers-ruled-out`). No Gymnasium env or torch/pufferlib dependency.
- **`solver/fast_engine.c` is the single implementation of everything**: board
  generation + the iOS deal, the four bots, the fair-coin-attrition battle,
  reinforcement, win check, and the open-loop C-UCT search (ranked **C1** rollout
  baked in, `c_puct=2.5`). The search has an opt-in **grading mode**
  (`uct_set_grade`, default off = bit-identical): root min-visit floor + dominance
  early-stops disabled + second-half Q readout, for accurate comparison ACROSS root
  moves rather than fastest best-move pick — used by every flow that grades human
  play (blunder alert, h2h score-my-decisions via the search request's `grade`
  flag), never by play/autoplay (verified helpful by `solver/grade_eval.py`;
  regression-gated in `validate_fast.py`). Everything else is a thin client over it:
  - `solver/fastnw.py` — ctypes client (marshals int32 arrays; implements no rules).
  - `solver/network_wars.py` — a readable State/Node shim that delegates every rule
    to the C engine, so the `iphone_data/` analysis tooling keeps its object API.
  - `public/` — the **self-contained WASM frontend**: `fast_engine.c` is compiled to
    WASM (`public/fast_engine.js`, single-file ESM, wasm embedded) and runs IN THE
    BROWSER inside a Web Worker. `public/fastnw.js` is the JS marshalling layer (port
    of `fastnw.py`); `public/engine.worker.js` is the game/orchestration layer (port
    of `server.py`'s handlers) — it holds game state and speaks the same `/api/game/*`
    contract via postMessage, so `index.html` needs no server to play. Search runs
    in the worker so the UI never blocks (adaptive budget: floor ~2000 sims, ceiling
    ~150k, visit-margin early stop — see memory `adaptive-sims`).
    Its `updateWinner` ends the game on **any of**: a faction at 24, one faction left,
    **or RED at 0 nodes** — that last one because attacks launch only FROM an owned node,
    so a wiped red can never move again and the game is already lost. Without it the
    player was left with no legal moves, forced to End Turn while the bots raced to 24
    (fixed 2026-07-17; regression-checked by driving the worker over 40 seeds and
    asserting no state has `counts.red===0 && !over` — ~3/40 games end by wipe, and the
    check catches 2 violations if the rule is removed).
    `public/board.js` is the **shared** board renderer + battle/bot-turn animation
    (octagon nodes, coin-flip replay, reinforce flashes) — the one place the game's
    look lives; both pages import it and neither draws its own board.
    Two pages, both pure-static (`server.py` also routes the extensionless
    `/head-to-head`):
      - `index.html` — free play + AI assist/suggestions/blunder alert/autoplay.
      - `head-to-head.html` — **duplicate-format** play vs the engine, continuous: you
        play a seed blind (your worker issues ZERO searches) while the AI plays THE SAME
        seed **concurrently in a SECOND worker**; finish and the next seed is dealt, with
        a running W-L tally. **The two workers are load-bearing, not a nicety**:
        `engine.worker.js` serves its inbox in order and aborts an in-flight search as
        soon as a request queues behind it, so a shared worker would let every tap you
        make truncate the AI's search and silently handicap it — corrupting the very
        comparison the page exists to make. The AI's progress shows as a **blurred +
        grayscale** thumbnail badge (ambient proof-of-work; readable would spoil the seed
        you're still on) with a `+N` backlog marker — you never wait for it.
        Because the seed pins board+dice, this removes the deal variance that dominates
        unpaired winrates (`sim-vs-real-deal-imbalance`, `hard-set-2026-07-02`). The
        tally panel is deliberately minimal — the two W-L score cards + the seed-list
        browser, nothing else (the McNemar/sign-test readout was cut as clutter
        2026-07-17; per-move scoring is the skill readout). Per-seed detail: **one red-nodes-vs-turn graph with both players' lines**
        (you teal / AI yellow, + the 24-to-win line; legend doubles as each side's final
        score) + **both move lists**, steppable — tapping a move replays the seed to that
        point (bit-exact) and shows the exact board with the move highlighted. AI moves
        carry the search's own win% per move; labels are snapshotted at play time (`mv.l`)
        so lists render without a replay. Decision scoring re-searches every position
        of your game (grading-mode searches, 16k floor / 24k ceiling) and grades each
        choice vs the search's best — the blunder-alert metric over a whole game; it
        starts **automatically whenever a seed's analysis opens** (no button), results
        render **rolling** (each scored move fills in as its search finishes; only a
        complete review is persisted), and a loss **auto-opens its analysis**
        (the next seed is dealt underneath, so closing drops you into it).
        Only **live** decisions (best-Q in 2–98%) are scored: in a decided position every
        move scores gap 0, so including them flatters the player (measured: a
        pass-every-turn game reads −7.7%/move unfiltered vs −27.6% over its 6 real
        decisions). No intro/setup gate — loading the page deals a seed immediately (a
        stored tally resumes). Caveat (documented in the page's header comment, no
        longer surfaced in the UI): same seed = same deal + same dice STREAM, but draws
        are consumed serially, so once your moves diverge from the AI's you pull
        different coins. Duplicate bridge, not dice-for-dice (which isn't coherent once
        actions differ).
    Both pages share one opt-in assist, the **sweep-up offer** (`nwSweep`): auto-play
    the rest of a won game with the mop-up rule in `fast_engine.c`
    (`sweep_best_move` — strongest attacker, hit any strictly weaker neighbor, else
    end turn). Its gate is a **Monte-Carlo certificate of that policy**
    (`sweep_certify`: play the mop-up to the end 1000x on the private sim dice, offer
    only if none lose), NOT a win% off the search, and it **re-certifies before every
    swept action** (400 trials, bail if >2 lose) and hands the game back if the dice
    turn. The old gate — "the search says every root move wins >99.95%" — was unsound
    twice over (it measured how the SEARCH would play, and grading-mode Qs in
    near-won positions average ~20 rollouts, so the threshold couldn't resolve 99%
    from 100% and raising it did nothing): it fired in 188/190 games at a median of
    **turn 3 / 10 RED nodes** and the mop-ups it authorized **lost 5.3%**. The
    certificate is ~100x cheaper (0.1ms median / 8.6ms worst in WASM) and measures
    0 losses in 12400 sweeps. Full numbers + tooling: `solver/SWEEP_UP.md`
    (`sweep_audit.py`, `sweep_variants.py`, `sweep_final.py`).
  - `solver/server.py` — now OPTIONAL: it serves `public/` static assets and the
    legacy `/api/game/*` (no longer used by the browser), and is only needed for the
    iOS `/grab` and `/load` workflow (live iPhone Mirroring). Pure offline play needs
    no Python — serve `public/` with any static server (`cd public && python3 -m
    http.server`) or open via the server.
  There is no JS rules engine — board-gen, bots, battle, reinforce, and search are all
  the one C source. Regression gates: `solver/validate_fast.py` (native, board/deal/
  battle invariants over 1000 seeds + frozen golden-seed outcomes) and
  `solver/validate_wasm.py` (WASM board-gen BIT-PARITY vs native over 1000 seeds +
  structural/battle invariants + determinism, via `solver/wasm_gate.mjs` in node).
  Third gate for the browser layer: `node solver/worker_gate.mjs [nseeds]` fakes a Web
  Worker so `engine.worker.js` can be driven in node over the pages' own
  `/api/game/*` request sequence (routes + the sweep-up loop, incl. its bail path).
- Two things came from the real game: the deal (every faction totals 20, 4 fixed
  templates) and battle. BATTLE is now the **real decompiled mechanic** —
  **iterated fair-coin attrition, zero fitted parameters** (2026-07-02; recovered
  from the shipped iOS IPA, see solver/REAL_BATTLE_DECOMPILED.md and
  ipa_decompile/). The atomic op is a **fair coin** (`killflip(team) =
  teamRandom.Next(2)`, p=0.5). `resolve_battle`: two guarded attacker **pre-fires**
  (coin → defender loses 1), then a symmetric loop (each round the attacker's coin
  can drop a defender and the defender's coin can drop an attacker) until `d==0` or
  `a==1`; **capture** iff `a>1 && d==0` → occupier `a-1`, source keeps exactly 1;
  else **repel** → source ground to 1, defender keeps remnant `d`. Survivors are NOT
  a separate draw — the attrition loop IS the survivor distribution. Coins are
  integer `RNG()<0.5` for WASM bit-parity; the search's CAPP/CAPES tables are the
  exact DP of this loop. (The old fitted single-shot `a^3.40/(a^3.40+1.26 d^3.40)` +
  beta-binomial survivor model was a good surrogate — it nailed parity ≈0.44 — but
  is now removed in favor of ground truth.)
- BOTS are the **real decompiled opponent AI** (2026-07-17; `OpponentAIOriginal`
  from the IPA — max spotted the chain behavior in live play, asm in
  `ipa_decompile/re/ai/`): each bot makes ONE **strongest-first** pass over the
  islands it owned at turn start; each island attacks its **smallest adjacent
  enemy** and, on capture, the bot **keeps attacking with the stack it just
  moved** (chain) until a repel or the target isn't strictly weaker
  (okAttack: attacker ≥2 and > defender). A stack is never revisited and attacks
  that open up later in the turn are not taken; ties are deterministic (node-id /
  adjacency order — NO RNG in move selection, so bot turns consume dice only in
  battles); then it reinforces its largest component's border. The in-turn cursor
  is exposed (`bot_turn_begin/next`) so the browser worker replays turns
  attack-by-attack bit-identically to the atomic `end_turn`. (The shipped app
  also contains an unused `OpponentAINiceEarly` variant — ruled out as the live
  default by 11 early bot captures of 3-6-army red nodes across 100 live games,
  which its early-game mercy rule forbids.)
- Build + drive: native `solver/build_native.sh` (PGO: instrument → profile →
  rebuild; **bit-identical play**, ~3% faster; falls back to the plain one-liner
  `cc -O3 -ffast-math -shared -fPIC solver/fast_engine.c -o solver/fast_engine.so`
  if llvm-profdata is missing), then `solver/fmcts.py` (or `solver/par_eval.py` for
  parallel winrate evals), or `solver/server.py` to play in a browser. WASM build (for
  the in-browser engine; NOTE: **no `-ffast-math`** — it breaks cross-arch board-gen
  bit-parity, and the search doesn't need it): run `solver/build_wasm.sh` (emcc
  single-file ESM → `public/fast_engine.js`), then validate with `python3
  solver/validate_wasm.py`. On the iOS-faithful deal, offline self-play winrate is
  **~94–95%** (8000 sims). The old offline-over-predicts-live gap is **CLOSED**: after
  the battle/survivor recalibration above, a 100-game live run scored **94.0%** (CI
  87.5–97.2%), matching offline at the same C-UCT config (memory
  `sim-real-gap-closed-2026-06-29`, supersedes the old ~77–81% plateau). Most of the
  few losses are early dice-snowballs, not search errors.

## Driving the real iOS app
- `solver/iphone_data/` captures/parses/taps the real app via macOS iPhone Mirroring.
- `series.py` runs a series of live games with the C-UCT engine and logs a rich
  JSONL (full trajectory + per-move win expectation + algo config). It never
  surrenders (see policy above).
