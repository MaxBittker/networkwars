/* fast_engine.c — Network Wars hot path in C (ctypes).
 *
 * Faithful port of network_wars.py mechanics: resolve_battle, best_bot_move,
 * run_bot_turn, reinforce, check_winner, rollout_to_terminal, end_turn.
 *
 * Topology (adjacency, coords) is fixed per game and set once via set_topology.
 * Board state = owner[N] (0=red,1..4=bots), strength[N]. Functions mutate the
 * caller-provided arrays in place.
 *
 * Two RNG sources:
 *   - mulberry32 (set_rng_mb32): used ONLY for parity validation vs Python.
 *   - private splitmix64 (sim_rng): seed-free dice for MCTS rollouts/transitions.
 *
 * Compile: cc -O3 -ffast-math -shared -fPIC fast_engine.c -o fast_engine.so
 */
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <stdlib.h>

#define MAXN 64
#define NF 5            /* factions: 0=red, 1..4 bots */
#define WIN_NODES 24
#define MAX_TURNS 300
#define ATTACKER_WIN_P 0.55
#define A_END (-1)          /* action sentinel: distinct from any frm<<8|to (>=0) */
#define MAXCHILD 512        /* max legal RED actions at one node */

/* ---- topology (fixed per game) ---- */
static int N = 0;
static int ADJ_OFF[MAXN + 1];
static int ADJ[MAXN * 8];

static void build_cap_tables(void);   /* fwd decl */
static void reinforce(int *owner, int *strength, int faction);  /* fwd decl */

void set_topology(int n, const int *adj_off, const int *adj_list) {
    N = n;
    for (int i = 0; i <= n; i++) ADJ_OFF[i] = adj_off[i];
    int total = adj_off[n];
    for (int i = 0; i < total; i++) ADJ[i] = adj_list[i];
    build_cap_tables();
}

/* ---- mulberry32 (parity only) ---- */
static uint32_t MB = 0;
void set_rng_mb32(uint32_t seed) { MB = seed; }
static double mb32(void) {
    MB = (MB + 0x6D2B79F5u);
    uint32_t t = (MB ^ (MB >> 15)) * (MB | 1u);
    t = (t + ((t ^ (t >> 7)) * (t | 61u))) ^ t;
    return (double)((t ^ (t >> 14))) / 4294967296.0;
}

/* ---- private seed-free rng (splitmix64) ---- */
static uint64_t SM = 0x12345678ULL;
void set_sim_seed(uint64_t s) { SM = s; }
static inline double sm_rand(void) {
    SM += 0x9E3779B97F4A7C15ULL;
    uint64_t z = SM;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    z = z ^ (z >> 31);
    return (double)(z >> 11) * (1.0 / 9007199254740992.0); /* 53-bit */
}

/* function pointer to the active rng (so parity tests can force mb32) */
static double (*RNG)(void) = sm_rand;
void use_mb32_rng(void) { RNG = mb32; }
void use_sim_rng(void) { RNG = sm_rand; }

/* ---- core mechanics ---- */
static inline void counts(const int *owner, int *c) {
    c[0]=c[1]=c[2]=c[3]=c[4]=0;
    for (int i = 0; i < N; i++) c[owner[i]]++;
}

static int check_winner(const int *owner) {
    int c[NF]; counts(owner, c);
    for (int f = 0; f < NF; f++) if (c[f] >= WIN_NODES) return f;
    int alive = -1, na = 0;
    for (int f = 0; f < NF; f++) if (c[f] > 0) { alive = f; na++; }
    return (na == 1) ? alive : -1;
}

/* ---- exact battle-outcome tables (variance-free policy estimates) ----
 * Models resolve_battle exactly: from (a,d) with a>1,d>0 go to (a,d-1) w.p. p,
 * (a-1,d) w.p. q. Capture iff d reaches 0. DP recurrences:
 *   P(a,d)=p*P(a,d-1)+q*P(a-1,d), P(a,0)=1 (a>=1), P(1,d>=1)=0
 *   S(a,d)=p*S(a,d-1)+q*S(a-1,d), S(a,0)=a-1, S(1,d>=1)=0   (S = E[toStr * 1cap])
 * capES = S/P (expected attacker strength after a capture). */
#define MAXS 160
static double CAPP[MAXS][MAXS];
static double CAPES[MAXS][MAXS];
static int CAP_READY = 0;

static void build_cap_tables(void) {
    double p = ATTACKER_WIN_P, q = 1.0 - ATTACKER_WIN_P;
    for (int a = 0; a < MAXS; a++) {
        CAPP[a][0] = (a >= 1) ? 1.0 : 0.0;
        CAPES[a][0] = (a >= 1) ? (double)(a - 1) : 0.0;
    }
    for (int d = 1; d < MAXS; d++) {
        CAPP[0][d] = 0.0; CAPES[0][d] = 0.0;
        CAPP[1][d] = 0.0; CAPES[1][d] = 0.0;
    }
    for (int a = 2; a < MAXS; a++) {
        for (int d = 1; d < MAXS; d++) {
            CAPP[a][d]  = p * CAPP[a][d-1]  + q * CAPP[a-1][d];
            CAPES[a][d] = p * CAPES[a][d-1] + q * CAPES[a-1][d];
        }
    }
    CAP_READY = 1;
}

static inline double capture_prob(int a, int d) {
    if (a < 1) return 0.0;
    if (d < 1) return 1.0;
    if (a >= MAXS) a = MAXS - 1;
    if (d >= MAXS) d = MAXS - 1;
    return CAPP[a][d];
}
static inline double exp_cap_strength(int a, int d) {
    if (a >= MAXS) a = MAXS - 1;
    if (d < 1) return (a >= 1) ? (double)(a - 1) : 0.0;
    if (d >= MAXS) d = MAXS - 1;
    double pp = CAPP[a][d];
    return pp > 0 ? CAPES[a][d] / pp : 0.0;
}

/* ---- ranked RED policy (C4-tuned), used as a strong rollout policy ---- */
typedef struct {
    double capture, weakTarget, margin, source, redAdj, merge, largestTouch;
    double enemyCount, eliminate, exposure, lowChancePenalty, strongTargetPenalty;
    double threshold;
} RankWeights;

static RankWeights RW = {  /* C4_RANKED_OPTIONS */
    .capture=41.626, .weakTarget=16.58, .margin=3.155, .source=9.863,
    .redAdj=34.636, .merge=75.442, .largestTouch=65.481, .enemyCount=13.635,
    .eliminate=195.996, .exposure=41.79, .lowChancePenalty=126.886,
    .strongTargetPenalty=4.498, .threshold=221.259,
};

void set_ranked_weights(const double *w) {
    RW.capture=w[0]; RW.weakTarget=w[1]; RW.margin=w[2]; RW.source=w[3];
    RW.redAdj=w[4]; RW.merge=w[5]; RW.largestTouch=w[6]; RW.enemyCount=w[7];
    RW.eliminate=w[8]; RW.exposure=w[9]; RW.lowChancePenalty=w[10];
    RW.strongTargetPenalty=w[11]; RW.threshold=w[12];
}

/* red component labels: label[i] = component index (-1 if not red), largest id */
static int LBL[MAXN];
static int LBL_SIZE[MAXN];
static int touch_mark[MAXN];   /* per-call scratch for "touching" set */
static int touch_stamp = 0;

static int red_labels(const int *owner) {
    for (int i = 0; i < N; i++) { LBL[i] = -1; LBL_SIZE[i] = 0; }
    int nlbl = 0;
    int stack[MAXN];
    for (int s = 0; s < N; s++) {
        if (owner[s] != 0 || LBL[s] != -1) continue;
        int top = 0, sz = 0;
        stack[top++] = s; LBL[s] = nlbl;
        while (top > 0) {
            int nid = stack[--top]; sz++;
            for (int k = ADJ_OFF[nid]; k < ADJ_OFF[nid+1]; k++) {
                int j = ADJ[k];
                if (owner[j] == 0 && LBL[j] == -1) { LBL[j] = nlbl; stack[top++] = j; }
            }
        }
        LBL_SIZE[nlbl] = sz;
        nlbl++;
    }
    int largest = -1;
    for (int i = 0; i < nlbl; i++) if (largest == -1 || LBL_SIZE[i] > LBL_SIZE[largest]) largest = i;
    return largest;
}

/* score a single RED attack move (frm->to) under the ranked weights. */
static double ranked_score(const int *owner, const int *strength, const int *c,
                           int largest, int i, int to) {
    int fs = strength[i], ts = strength[to];
    double pCap = capture_prob(fs, ts);
    double eStr = exp_cap_strength(fs, ts);
    int eStrI = (int)(eStr + 0.5); if (eStrI < 1) eStrI = 1;

    touch_stamp++;
    int mergeCount = 0, redAdj = 0, touchesLargest = 0;
    double exposure = 0.0;
    for (int m = ADJ_OFF[to]; m < ADJ_OFF[to+1]; m++) {
        int nb = ADJ[m];
        if (owner[nb] == 0) {
            redAdj++;
            int lb = LBL[nb];
            if (lb >= 0 && touch_mark[lb] != touch_stamp) {
                touch_mark[lb] = touch_stamp; mergeCount++;
                if (lb == largest) touchesLargest = 1;
            }
        } else if (nb != i && strength[nb] > eStr) {
            exposure += capture_prob(strength[nb], eStrI);
        }
    }
    int slb = LBL[i];
    if (slb >= 0 && touch_mark[slb] != touch_stamp) {
        touch_mark[slb] = touch_stamp; mergeCount++;
        if (slb == largest) touchesLargest = 1;
    }
    mergeCount -= 1; if (mergeCount < 0) mergeCount = 0;

    double margin = (double)(fs - ts);
    double weakTarget = 1.0 / (ts < 1 ? 1 : ts);
    double strongPen = (ts - 3 > 0) ? (ts - 3) : 0;
    double src = log2((double)(fs < 2 ? 2 : fs));

    double score = 0;
    score += pCap * RW.capture;
    score += weakTarget * RW.weakTarget;
    score += margin * RW.margin;
    score += src * RW.source;
    score += redAdj * RW.redAdj;
    score += mergeCount * RW.merge;
    if (touchesLargest) score += RW.largestTouch;
    score += c[owner[to]] * RW.enemyCount;
    if (c[owner[to]] == 1) score += RW.eliminate;
    score -= exposure * RW.exposure;
    double lowc = 0.45 - pCap; if (lowc < 0) lowc = 0;
    score -= lowc * RW.lowChancePenalty;
    score -= strongPen * RW.strongTargetPenalty;
    if (c[0] >= WIN_NODES - 1) score += 100000.0;
    return score;
}

/* fill acts[]/scores[] for all legal RED actions in legal_red() order (END last,
 * with score = threshold so it competes with attacks). Returns count. */
static int ranked_fill(const int *owner, const int *strength, int *acts, double *scores) {
    int c[NF]; counts(owner, c);
    int largest = red_labels(owner);
    int n = 0;
    for (int i = 0; i < N; i++) {
        if (owner[i] != 0 || strength[i] <= 1) continue;
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int to = ADJ[k];
            if (owner[to] == 0) continue;   /* attack enemies only (RED is owner 0) */
            acts[n] = (i << 8) | to;
            scores[n] = ranked_score(owner, strength, c, largest, i, to);
            n++;
        }
    }
    acts[n] = A_END;
    scores[n] = RW.threshold;   /* END competes at the stop threshold */
    n++;
    return n;
}

/* rollout temperature: 0 = deterministic argmax; >0 = softmax-sample the move. */
static double ROLL_TEMP = 0.0;
void set_roll_temp(double t) { ROLL_TEMP = t; }

/* best/sampled ranked RED move; returns frm<<8|to, or A_END (stop). */
static int ranked_best_move(const int *owner, const int *strength) {
    static int acts[MAXCHILD]; static double scores[MAXCHILD];
    int n = ranked_fill(owner, strength, acts, scores);
    if (ROLL_TEMP <= 0.0) {
        int best = n - 1; double bs = scores[n - 1];   /* END default */
        for (int k = 0; k < n - 1; k++) if (scores[k] > bs) { bs = scores[k]; best = k; }
        return acts[best];
    }
    /* softmax sample (numerically stable). +100000 near-win term still dominates. */
    double smax = scores[0];
    for (int k = 1; k < n; k++) if (scores[k] > smax) smax = scores[k];
    double sum = 0.0;
    static double w[MAXCHILD];
    for (int k = 0; k < n; k++) { w[k] = exp((scores[k] - smax) / ROLL_TEMP); sum += w[k]; }
    double r = RNG() * sum;
    for (int k = 0; k < n; k++) { r -= w[k]; if (r <= 0.0) return acts[k]; }
    return acts[n - 1];
}

/* ---- ensemble of rollout policies (rotate per rollout to cancel bias) ---- */
static RankWeights ENS[8];
static int ENS_N = 0;
void set_ensemble(const double *flat, int k) {   /* flat = k*13 doubles */
    ENS_N = (k > 8) ? 8 : k;
    for (int i = 0; i < ENS_N; i++) {
        const double *w = flat + i * 13;
        ENS[i].capture=w[0]; ENS[i].weakTarget=w[1]; ENS[i].margin=w[2]; ENS[i].source=w[3];
        ENS[i].redAdj=w[4]; ENS[i].merge=w[5]; ENS[i].largestTouch=w[6]; ENS[i].enemyCount=w[7];
        ENS[i].eliminate=w[8]; ENS[i].exposure=w[9]; ENS[i].lowChancePenalty=w[10];
        ENS[i].strongTargetPenalty=w[11]; ENS[i].threshold=w[12];
    }
}

/* ---- safety-aware ranked move (1-ply threat lookahead, ~modalScout) ---- */
/* RED's total incoming threat = sum over beatable RED border nodes of the
 * attacker's exact capture probability. Lower = safer. */
static double total_red_threat(const int *owner, const int *strength) {
    double t = 0.0;
    for (int n = 0; n < N; n++) {
        if (owner[n] == 0 || strength[n] <= 1) continue;
        for (int k = ADJ_OFF[n]; k < ADJ_OFF[n+1]; k++) {
            int j = ADJ[k];
            if (owner[j] == 0 && strength[n] > strength[j])
                t += capture_prob(strength[n], strength[j]);
        }
    }
    return t;
}

static double SAFETY_W = 45.0;      /* weight on threat reduction after the move */
static double REDGAIN_W = 28.0;     /* weight on capturing a node */
void set_safety_params(double sw, double rg) { SAFETY_W = sw; REDGAIN_W = rg; }

/* score each ranked move by ranked_score + SAFETY_W*(threat reduction after the
 * move's expected outcome + RED reinforce) + REDGAIN_W*(captured?). */
static int safety_best_move(const int *owner, const int *strength) {
    static int acts[MAXCHILD]; static double sc[MAXCHILD];
    int n = ranked_fill(owner, strength, acts, sc);
    int bo[MAXN], bs[MAXN];
    memcpy(bo, owner, N * sizeof(int)); memcpy(bs, strength, N * sizeof(int));
    reinforce(bo, bs, 0);
    double base_threat = total_red_threat(bo, bs);

    double best_final = sc[n - 1];   /* END competes at the ranked threshold */
    int best_act = A_END;
    int co[MAXN], cs[MAXN];
    for (int k = 0; k < n - 1; k++) {
        int frm = acts[k] >> 8, to = acts[k] & 0xFF;
        double pc = capture_prob(strength[frm], strength[to]);
        int cap = pc >= 0.5;
        memcpy(co, owner, N * sizeof(int)); memcpy(cs, strength, N * sizeof(int));
        cs[frm] = 1;
        if (cap) { co[to] = 0; cs[to] = (int)(exp_cap_strength(strength[frm], strength[to]) + 0.5); if (cs[to] < 1) cs[to] = 1; }
        reinforce(co, cs, 0);
        double thr = total_red_threat(co, cs);
        double fin = sc[k] + SAFETY_W * (base_threat - thr) + REDGAIN_W * (cap ? 1.0 : 0.0);
        if (fin > best_final) { best_final = fin; best_act = acts[k]; }
    }
    return best_act;
}

/* RED rollout policy: 0 = greedy bot-style, 1 = ranked, 2 = safety-aware ranked. */
static int RED_ROLLOUT_POLICY = 1;
void set_red_rollout_policy(int p) { RED_ROLLOUT_POLICY = p; }

/* heuristic priors: softmax of ranked scores as PUCT priors at every node. */
static int HEUR_PRIORS = 0;
static double PRIOR_BETA = 0.02;
void set_heur_priors(int on, double beta) { HEUR_PRIORS = on; PRIOR_BETA = beta; }

/* dice battle, frm attacks to */
static void resolve_battle(int *owner, int *strength, int frm, int to) {
    int a = strength[frm], d = strength[to];
    while (a > 1 && d > 0) {
        if (RNG() < ATTACKER_WIN_P) d--; else a--;
    }
    if (d == 0) {
        owner[to] = owner[frm];
        strength[to] = a - 1;
        strength[frm] = 1;
    } else {
        strength[frm] = a;
        strength[to] = d;
    }
}

/* best_bot_move: return packed (frm<<8|to)+1, or 0 if none.
 * tie-break: weakest defender; then strongest attacker; then lowest frm; lowest to. */
static int best_bot_move(const int *owner, const int *strength, int faction) {
    int bf=-1, bt=-1, bfs=0, bts=0; int found=0;
    for (int i = 0; i < N; i++) {
        if (owner[i] != faction || strength[i] <= 1) continue;
        int si = strength[i];
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int j = ADJ[k];
            if (owner[j] == faction || strength[j] >= si) continue;
            int dj = strength[j];
            int better = 0;
            if (!found) better = 1;
            else if (dj < bts) better = 1;
            else if (dj == bts && si > bfs) better = 1;
            else if (dj == bts && si == bfs && i < bf) better = 1;
            else if (dj == bts && si == bfs && i == bf && j < bt) better = 1;
            if (better) { bf=i; bt=j; bfs=si; bts=dj; found=1; }
        }
    }
    return found ? ((bf << 8) | bt) + 1 : 0;
}

/* reinforce faction's largest component (border round-robin). */
static int seen_buf[MAXN];
static int comp_buf[2 * MAXN];   /* [0..top) = DFS stack; [MAXN..) = collected nodes */
static int largest_buf[MAXN];
static int border_buf[MAXN];

static void reinforce(int *owner, int *strength, int faction) {
    /* Walk components in ascending start-id order; keep the first one whose size
     * is strictly greater than the best so far (matches Python's
     * `largest=comps[0]; if len>len(largest)` => first-encountered on ties). */
    for (int i = 0; i < N; i++) seen_buf[i] = 0;
    int chosen_n = 0;
    for (int s = 0; s < N; s++) {
        if (owner[s] != faction || seen_buf[s]) continue;
        int top = 0, csz = 0;
        comp_buf[top++] = s; seen_buf[s] = 1;
        while (top > 0) {
            int nid = comp_buf[--top];
            comp_buf[MAXN + csz] = nid;   /* collect nodes above the stack region */
            csz++;
            for (int k = ADJ_OFF[nid]; k < ADJ_OFF[nid+1]; k++) {
                int j = ADJ[k];
                if (!seen_buf[j] && owner[j] == faction) { seen_buf[j]=1; comp_buf[top++]=j; }
            }
        }
        if (csz > chosen_n) {
            for (int t = 0; t < csz; t++) largest_buf[t] = comp_buf[MAXN + t];
            chosen_n = csz;
        }
    }
    if (chosen_n == 0) return;

    /* border = sorted node ids in largest with an enemy/empty neighbor */
    int bn = 0;
    for (int t = 0; t < chosen_n; t++) {
        int nid = largest_buf[t];
        int is_border = 0;
        for (int k = ADJ_OFF[nid]; k < ADJ_OFF[nid+1]; k++) {
            if (owner[ADJ[k]] != faction) { is_border = 1; break; }
        }
        if (is_border) border_buf[bn++] = nid;
    }
    if (bn == 0) return;
    /* sort border ascending (insertion sort, small) */
    for (int a = 1; a < bn; a++) {
        int v = border_buf[a], b = a - 1;
        while (b >= 0 && border_buf[b] > v) { border_buf[b+1] = border_buf[b]; b--; }
        border_buf[b+1] = v;
    }
    int n_total = chosen_n;
    for (int i = 0; i < n_total; i++) strength[border_buf[i % bn]] += 1;
}

static void run_bot_turn(int *owner, int *strength, int faction) {
    int c[NF]; counts(owner, c);
    if (c[faction] == 0) return;
    int guard = 0;
    while (guard < 1000) {
        guard++;
        int mv = best_bot_move(owner, strength, faction);
        if (mv == 0) break;
        mv -= 1;
        resolve_battle(owner, strength, mv >> 8, mv & 0xFF);
        if (check_winner(owner) != -1) return;
    }
    reinforce(owner, strength, faction);
}

/* RED ends turn: reinforce(red) then all bot turns. Mutates board. */
void end_turn(int *owner, int *strength) {
    reinforce(owner, strength, 0);
    if (check_winner(owner) != -1) return;
    for (int b = 1; b <= 4; b++) {
        run_bot_turn(owner, strength, b);
        if (check_winner(owner) != -1) return;
    }
}

/* full greedy playout to terminal; RED plays bot-style. Returns 1 if RED wins.
 * Operates on a private copy so the caller's arrays are untouched. */
int rollout(const int *owner_in, const int *strength_in, int turns) {
    int owner[MAXN], strength[MAXN];
    memcpy(owner, owner_in, N * sizeof(int));
    memcpy(strength, strength_in, N * sizeof(int));
    int c[NF];
    for (;;) {
        int w = check_winner(owner);
        if (w != -1) return w == 0;
        counts(owner, c);
        if (c[0] == 0) return 0;
        /* RED turn (rollout policy: ranked C4 by default, else greedy bot) */
        int g = 0;
        while (g < 200) {
            int mv;
            if (RED_ROLLOUT_POLICY == 2) {
                mv = safety_best_move(owner, strength);
                if (mv == A_END) break;
            } else if (RED_ROLLOUT_POLICY == 1) {
                mv = ranked_best_move(owner, strength);
                if (mv == A_END) break;
            } else {
                mv = best_bot_move(owner, strength, 0);
                if (mv == 0) break;
                mv -= 1;
            }
            resolve_battle(owner, strength, mv >> 8, mv & 0xFF);
            if (check_winner(owner) != -1) break;
            g++;
        }
        w = check_winner(owner); if (w != -1) return w == 0;
        reinforce(owner, strength, 0);
        w = check_winner(owner); if (w != -1) return w == 0;
        for (int b = 1; b <= 4; b++) {
            run_bot_turn(owner, strength, b);
            if (check_winner(owner) != -1) break;
        }
        w = check_winner(owner); if (w != -1) return w == 0;
        turns++;
        if (turns > MAX_TURNS) {
            counts(owner, c);
            int mx = c[1];
            for (int f = 2; f < NF; f++) if (c[f] > mx) mx = c[f];
            return c[0] > mx;
        }
    }
}

/* average of `nroll` independent rollouts from this board (variance reduction
 * for a value estimate). Each rollout uses the private sim rng. */
double rollout_avg(const int *owner_in, const int *strength_in, int turns, int nroll) {
    int wins = 0;
    for (int r = 0; r < nroll; r++) wins += rollout(owner_in, strength_in, turns);
    return (double)wins / (double)nroll;
}

/* ===================== open-loop PUCT MCTS (pure UCT + rollout) ===========
 * Single-agent stochastic planning: bots fold into end_turn, dice are the only
 * randomness (private sim rng, re-sampled from root each simulation). Mirrors
 * mcts.py:mcts_search exactly (FPU = parent value, rollout leaf, uniform priors
 * unless root priors supplied). Actions: attack = frm*64+to, END = 4096.
 */
#include <stdlib.h>
#include <math.h>

#define PRI_END 16192       /* root_pri[] slot for END_TURN (attacks use frm<<8|to < 16192) */

typedef struct {
    int n_children;
    int child_off;     /* index into edge pools */
    int expanded;
    int terminal;
    double v;
} MNode;

static MNode  *NODES = NULL;
static int    *E_ACT = NULL;
static int    *E_CHILD = NULL;     /* node index of child, -1 = none */
static int    *E_N = NULL;
static double *E_W = NULL;
static double *E_P = NULL;
static long NODE_CAP = 0, EDGE_CAP = 0;
static long next_node = 0, next_edge = 0;

static int ensure_pools(long ncap, long ecap) {
    if (ncap > NODE_CAP) {
        NODES = (MNode*)realloc(NODES, ncap * sizeof(MNode));
        NODE_CAP = ncap;
        if (!NODES) return 0;
    }
    if (ecap > EDGE_CAP) {
        E_ACT   = (int*)realloc(E_ACT,   ecap * sizeof(int));
        E_CHILD = (int*)realloc(E_CHILD, ecap * sizeof(int));
        E_N     = (int*)realloc(E_N,     ecap * sizeof(int));
        E_W     = (double*)realloc(E_W,  ecap * sizeof(double));
        E_P     = (double*)realloc(E_P,  ecap * sizeof(double));
        EDGE_CAP = ecap;
        if (!E_ACT || !E_CHILD || !E_N || !E_W || !E_P) return 0;
    }
    return 1;
}

/* enumerate RED legal actions into buf; returns count (incl END_TURN). */
static int legal_red(const int *owner, const int *strength, int *buf) {
    int n = 0;
    for (int i = 0; i < N; i++) {
        if (owner[i] != 0 || strength[i] <= 1) continue;
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int j = ADJ[k];
            if (owner[j] != 0) buf[n++] = (i << 8) | j;
        }
    }
    buf[n++] = A_END;
    return n;
}

static int new_node(void) {
    if (next_node >= NODE_CAP) return -1;
    MNode *m = &NODES[next_node];
    m->n_children = 0; m->child_off = -1; m->expanded = 0; m->terminal = 0; m->v = 0.5;
    return (int)next_node++;
}

/* apply one RED action to (owner,strength); returns: 0 continue, 1 terminal.
 * sets *winner (0=red wins,1=loss) when terminal. mutates turns via *pturns. */
static int apply_red(int *owner, int *strength, int act, int *pturns, int *winner) {
    if (act == A_END) {
        end_turn(owner, strength);
        (*pturns)++;
        int w = check_winner(owner);
        int c[NF]; counts(owner, c);
        if (w != -1 || c[0] == 0) { *winner = (w == 0); return 1; }
        if (*pturns > MAX_TURNS) { *winner = 0; return 1; }
        return 0;
    } else {
        int frm = act >> 8, to = act & 0xFF;
        /* legality already guaranteed by enumeration; resolve */
        resolve_battle(owner, strength, frm, to);
        int w = check_winner(owner);
        int c[NF]; counts(owner, c);
        if (w != -1 || c[0] == 0) { *winner = (w == 0); return 1; }
        return 0;
    }
}

/* root_priors: optional length-(MAXN*64+1)-ish sparse not feasible; instead pass
 * priors indexed by action via a callback is overkill. We accept NULL (uniform)
 * or a dense array `pri` of length 4097 mapping action->prior (caller fills only
 * legal entries; we renormalize over legal). nroll = rollouts per leaf. */
int uct_search(const int *owner_in, const int *strength_in, int root_turns,
               int sims, double c_puct, int nroll,
               const double *root_pri, int *out_acts, int *out_visits) {
    /* size pools to the sim budget */
    long ncap = (long)sims * 24 + 4096;
    long ecap = ncap * 40;
    if (!ensure_pools(ncap, ecap)) return -1;
    next_node = 0; next_edge = 0;

    int root = new_node();
    int legal[MAXCHILD];
    int owner[MAXN], strength[MAXN];

    for (int sim = 0; sim < sims; sim++) {
        memcpy(owner, owner_in, N * sizeof(int));
        memcpy(strength, strength_in, N * sizeof(int));
        int turns = root_turns;
        int cur = root;
        /* path of (node, edge-index) for backup */
        static int path_eidx[16384]; int plen = 0;
        int leaf_value_set = 0; double leaf_value = 0.0;

        for (;;) {
            if (plen >= 16384) { leaf_value = NODES[cur].v; leaf_value_set = 1; break; }
            MNode *node = &NODES[cur];
            if (!node->expanded) {
                static double hscore[MAXCHILD];
                int nc;
                if (HEUR_PRIORS) nc = ranked_fill(owner, strength, legal, hscore);
                else             nc = legal_red(owner, strength, legal);
                if (next_edge + nc > EDGE_CAP) { leaf_value = node->v; leaf_value_set = 1; break; }
                node->child_off = (int)next_edge;
                node->n_children = nc;
                next_edge += nc;
                /* priors: heuristic softmax (every node), root_pri (root only), or uniform */
                double smax = -1e30;
                if (HEUR_PRIORS) for (int k = 0; k < nc; k++) if (hscore[k] > smax) smax = hscore[k];
                double psum = 0.0;
                for (int k = 0; k < nc; k++) {
                    int off = node->child_off + k;
                    E_ACT[off] = legal[k];
                    E_CHILD[off] = -1;
                    E_N[off] = 0;
                    E_W[off] = 0.0;
                    double p;
                    if (HEUR_PRIORS) {
                        p = exp(PRIOR_BETA * (hscore[k] - smax));
                    } else if (root_pri && cur == root) {
                        int idx = (legal[k] == A_END) ? PRI_END : legal[k];
                        p = root_pri[idx];
                    } else {
                        p = 1.0 / nc;
                    }
                    E_P[off] = p;
                    psum += p;
                }
                if (psum > 0) for (int k = 0; k < nc; k++) E_P[node->child_off + k] /= psum;
                /* leaf eval = rollout average (rotate ensemble policies if set) */
                double v = 0.0;
                for (int r = 0; r < nroll; r++) {
                    if (ENS_N > 0) RW = ENS[r % ENS_N];
                    v += rollout(owner, strength, turns);
                }
                v /= (double)nroll;
                node->expanded = 1;
                node->v = v;
                leaf_value = v; leaf_value_set = 1;
                break;
            }
            /* select best child (PUCT) */
            int nc = node->n_children;
            long total = 0;
            for (int k = 0; k < nc; k++) total += E_N[node->child_off + k];
            double sqrt_total = sqrt((double)total) + 1e-8;
            int best_k = 0; double best_u = -1e30;
            for (int k = 0; k < nc; k++) {
                int off = node->child_off + k;
                int n = E_N[off];
                double q = (n > 0) ? (E_W[off] / n) : node->v;
                double u = q + c_puct * E_P[off] * sqrt_total / (1 + n);
                if (u > best_u) { best_u = u; best_k = k; }
            }
            int off = node->child_off + best_k;
            path_eidx[plen] = off; plen++;
            int act = E_ACT[off];
            int winner = 0;
            int term = apply_red(owner, strength, act, &turns, &winner);
            if (term) {
                leaf_value = winner ? 1.0 : 0.0; leaf_value_set = 1;
                /* mark child terminal so it isn't re-expanded */
                if (E_CHILD[off] < 0) {
                    int cn = new_node();
                    if (cn >= 0) { NODES[cn].expanded = 1; NODES[cn].terminal = 1; NODES[cn].v = leaf_value; E_CHILD[off] = cn; }
                }
                break;
            }
            if (turns > MAX_TURNS) { leaf_value = 0.0; leaf_value_set = 1; break; }
            if (E_CHILD[off] < 0) {
                int cn = new_node();
                if (cn < 0) { leaf_value = NODES[cur].v; leaf_value_set = 1; break; }
                E_CHILD[off] = cn;
            }
            cur = E_CHILD[off];
        }
        /* backup */
        double val = leaf_value_set ? leaf_value : 0.5;
        for (int p = 0; p < plen; p++) {
            int off = path_eidx[p];
            E_N[off] += 1;
            E_W[off] += val;
        }
    }

    /* report root children visit counts */
    MNode *rn = &NODES[root];
    int nc = rn->n_children;
    for (int k = 0; k < nc; k++) {
        out_acts[k] = E_ACT[rn->child_off + k];
        out_visits[k] = E_N[rn->child_off + k];
    }
    return nc;
}

/* expose primitives for parity testing under a chosen rng */
void ext_resolve_battle(int *owner, int *strength, int frm, int to) {
    resolve_battle(owner, strength, frm, to);
}
void ext_reinforce(int *owner, int *strength, int faction) {
    reinforce(owner, strength, faction);
}
void ext_run_bot_turn(int *owner, int *strength, int faction) {
    run_bot_turn(owner, strength, faction);
}
int ext_best_bot_move(const int *owner, const int *strength, int faction) {
    return best_bot_move(owner, strength, faction);
}
int ext_check_winner(const int *owner) { return check_winner(owner); }
