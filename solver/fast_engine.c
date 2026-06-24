/* fast_engine.c — Network Wars engine + C-UCT search (the single source of truth).
 *
 * One implementation of the whole game: board generation + deal, the four
 * deterministic bots, the power-ratio battle, reinforcement, win check, and an
 * open-loop PUCT/MCTS player for RED. Python (fastnw.py) and the browser
 * (solver/server.py) are thin clients over this; there is no second port.
 *
 * Board state = owner[N] (0=red, 1..4=bots), strength[N]; functions mutate the
 * caller-provided int arrays in place. Topology (adjacency) is set per game via
 * set_topology() — or built in C by new_game(), which also fills owner/strength.
 *
 * Two RNG sources, selected by the RNG function pointer:
 *   - mulberry32 (set_rng_mb32): the real seeded game stream — bit-identical to
 *     the old network_wars.py / game.js mulberry32. Used for board-gen and for
 *     playing out the real iOS-faithful game.
 *   - splitmix64 (set_sim_seed): a private, seed-free stream for MCTS rollouts so
 *     the search never sees the real game's dice (no seed exploitation).
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
/* SINGLE-SHOT power-ratio (fitted iOS) battle — the simplest model that best
 * explains the live capture data. One Bernoulli decides capture vs repel:
 *   P(capture) = a^PR_G / (a^PR_G + PR_C * d^PR_G)
 * Survivors are deterministic (both within OCR noise of the live data):
 *   capture: occupier = max(1, a - d), source = 1
 *   repel:   source   = 1,            defender remnant = max(0, d - a + 1)
 * MLE on 7,222 live red-attacker battles: G=3.40, C=1.26 (AIC 5941 vs the old
 * iterated k=0.62 model's 6077; nails the contested +1 margin 76% vs 74% obs).
 * See solver/BATTLE_FUNCTION.md / iphone_data/refit_emergent.py. */
#define PR_G  3.40
#define PR_C  1.26
static inline double pr_cap(int a, int d) {
    if (a < 1) return 0.0;
    if (d < 1) return 1.0;
    double ag = pow((double)a, PR_G), dg = pow((double)d, PR_G);
    return ag / (ag + PR_C * dg);
}
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

/* ---- mulberry32 (real seeded game stream; bit-identical to the old JS/Py) ---- */
static uint32_t MB = 0;
void set_rng_mb32(uint32_t seed) { MB = seed; }
uint32_t get_rng_mb32(void) { return MB; }   /* read the stream position back out */
static double mb32(void) {
    MB = (MB + 0x6D2B79F5u);
    uint32_t t = (MB ^ (MB >> 15)) * (MB | 1u);
    t = (t + ((t ^ (t >> 7)) * (t | 61u))) ^ t;
    return (double)((t ^ (t >> 14))) / 4294967296.0;
}

/* ---- private seed-free rng (splitmix64) for MCTS rollouts ---- */
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

/* active rng: mb32 for the real game, sm_rand for search rollouts. */
static double (*RNG)(void) = sm_rand;
void use_mb32_rng(void) { RNG = mb32; }
void use_sim_rng(void) { RNG = sm_rand; }

/* ---- board generation (mulberry32; bit-identical to the old Python/JS) ----
 * 6x7 king-adjacency lattice -> connectivity-preserving vertex removal to 30
 * nodes -> clustered ownership growth -> the iOS deal (every faction totals 20,
 * one of 4 fixed templates). Consumes the mb32 stream in the exact same order as
 * network_wars.build_board, so new_game(seed) reproduces that board bit-for-bit
 * and leaves MB advanced for the real-game battle stream that follows. */
#define GRID_ROWS 7
#define GRID_COLS 6
#define CELLS (GRID_ROWS * GRID_COLS)   /* 42 */
#define TARGET_NODES 30
#define OWNER_SCATTER 0.6

/* 4 fixed deal templates (6 per-faction strengths summing to 20) + cumulative prob */
static const int DEAL_TMPL[4][6] = {
    {1, 1, 1, 5, 6, 6},
    {1, 1, 1, 1, 8, 8},
    {1, 1, 4, 4, 5, 5},
    {1, 3, 4, 4, 4, 4},
};
static const double DEAL_CUM[4] = {0.385, 0.712, 0.934, 1.0};  /* 0.385,+0.327,+0.222,+0.066 */

/* Fisher-Yates over the mb32 stream, matching Python's shuffle() exactly. */
static void bg_shuffle(int *a, int n) {
    for (int i = n - 1; i > 0; i--) {
        int j = (int)(mb32() * (i + 1));
        int t = a[i]; a[i] = a[j]; a[j] = t;
    }
}

/* DFS connectivity over the live grid cells, excluding `excluded`. */
static int bg_still_connected(const int *al, const int gadj[][8], const int *gdeg,
                              int nalive, int excluded) {
    int start = -1;
    for (int g = 0; g < CELLS; g++) if (al[g] && g != excluded) { start = g; break; }
    if (start < 0) return 0;
    int seen[CELLS]; for (int i = 0; i < CELLS; i++) seen[i] = 0;
    int stack[CELLS], top = 0, cnt = 0;
    stack[top++] = start; seen[start] = 1;
    while (top > 0) {
        int g = stack[--top]; cnt++;
        for (int k = 0; k < gdeg[g]; k++) {
            int nb = gadj[g][k];
            if (nb != excluded && al[nb] && !seen[nb]) { seen[nb] = 1; stack[top++] = nb; }
        }
    }
    return cnt == nalive - 1;
}

/* Build a fresh game from `seed`. Fills owner[N], strength[N], x[N], y[N] and sets
 * the engine topology (ADJ/ADJ_OFF). Switches the active RNG to mb32 (seeded) so
 * the caller can play out the real seeded game. Returns N (= 30). */
int new_game(uint32_t seed, int *owner, int *strength, int *x, int *y) {
    MB = seed;            /* seed the real mulberry32 stream */
    RNG = mb32;

    /* grid king-lattice adjacency, append order identical to network_wars */
    int gadj[CELLS][8], gdeg[CELLS];
    for (int i = 0; i < CELLS; i++) gdeg[i] = 0;
    #define GLINK(u, v) do { gadj[u][gdeg[u]++] = (v); gadj[v][gdeg[v]++] = (u); } while (0)
    for (int r = 0; r < GRID_ROWS; r++) {
        for (int c = 0; c < GRID_COLS; c++) {
            int a = r * GRID_COLS + c;
            if (c + 1 < GRID_COLS) GLINK(a, r * GRID_COLS + (c + 1));
            if (r + 1 < GRID_ROWS) {
                GLINK(a, (r + 1) * GRID_COLS + c);
                if (c - 1 >= 0)        GLINK(a, (r + 1) * GRID_COLS + (c - 1));
                if (c + 1 < GRID_COLS) GLINK(a, (r + 1) * GRID_COLS + (c + 1));
            }
        }
    }
    #undef GLINK

    /* remove random vertices, keeping the rest connected, down to TARGET_NODES */
    int al[CELLS]; for (int i = 0; i < CELLS; i++) al[i] = 1;
    int nalive = CELLS;
    while (nalive > TARGET_NODES) {
        int cand[CELLS], m = 0;
        for (int i = 0; i < CELLS; i++) if (al[i]) cand[m++] = i;   /* ascending */
        bg_shuffle(cand, m);
        int removed = 0;
        for (int ci = 0; ci < m; ci++) {
            int gid = cand[ci];
            if (bg_still_connected(al, gadj, gdeg, nalive, gid)) {
                al[gid] = 0; nalive--; removed = 1; break;
            }
        }
        if (!removed) break;
    }

    /* reindex survivors to 0..N-1 (ascending), carry grid coords */
    int surv[CELLS], newid[CELLS];
    for (int i = 0; i < CELLS; i++) newid[i] = -1;
    int n = 0;
    for (int g = 0; g < CELLS; g++) if (al[g]) { surv[n] = g; newid[g] = n; n++; }
    N = n;
    for (int i = 0; i < N; i++) { x[i] = surv[i] % GRID_COLS; y[i] = surv[i] / GRID_COLS; }

    /* adjacency in network_wars link order: survivors ascending x neighbor order,
     * deduped; for each new link append both directions. */
    int tadj[MAXN][16], tdeg[MAXN];
    for (int i = 0; i < N; i++) tdeg[i] = 0;
    static char seenlink[MAXN][MAXN];
    for (int i = 0; i < N; i++) for (int j = 0; j < N; j++) seenlink[i][j] = 0;
    for (int si = 0; si < N; si++) {
        int g = surv[si], a = si;
        for (int k = 0; k < gdeg[g]; k++) {
            int nb = gadj[g][k];
            if (!al[nb]) continue;
            int b = newid[nb];
            int lo = a < b ? a : b, hi = a < b ? b : a;
            if (seenlink[lo][hi]) continue;
            seenlink[lo][hi] = 1;
            tadj[lo][tdeg[lo]++] = hi;
            tadj[hi][tdeg[hi]++] = lo;
        }
    }
    int off = 0;
    for (int i = 0; i < N; i++) {
        ADJ_OFF[i] = off;
        for (int k = 0; k < tdeg[i]; k++) ADJ[off++] = tadj[i][k];
    }
    ADJ_OFF[N] = off;
    build_cap_tables();

    /* ownership: clustered territorial growth (OWNER_SEEDS=1, OWNER_SCATTER) */
    int own[MAXN]; for (int i = 0; i < N; i++) own[i] = -1;
    int cnt[NF]; for (int f = 0; f < NF; f++) cnt[f] = 0;
    int pool[MAXN]; for (int i = 0; i < N; i++) pool[i] = i;
    bg_shuffle(pool, N);
    int p = 0;
    for (int f = 0; f < NF; f++) { own[pool[p++]] = f; cnt[f]++; }   /* one seed per faction */
    int guard = 0;
    for (;;) {
        int need = 0; for (int f = 0; f < NF; f++) if (cnt[f] < 6) need = 1;
        if (!need || guard++ >= 10000) break;
        int forder[NF] = {0, 1, 2, 3, 4};
        bg_shuffle(forder, NF);
        for (int fi = 0; fi < NF; fi++) {
            int f = forder[fi];
            if (cnt[f] >= 6) continue;
            int freebuf[MAXN], nfree = 0;
            for (int i = 0; i < N; i++) if (own[i] == -1) freebuf[nfree++] = i;
            int pick;
            if (mb32() < OWNER_SCATTER) {
                pick = freebuf[(int)(mb32() * nfree)];
            } else {
                int border[MAXN], nb = 0;
                for (int i = 0; i < N; i++) {
                    if (own[i] != f) continue;
                    for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
                        int nbn = ADJ[k];
                        if (own[nbn] != -1) continue;
                        int dup = 0; for (int t = 0; t < nb; t++) if (border[t] == nbn) { dup = 1; break; }
                        if (!dup) border[nb++] = nbn;
                    }
                }
                pick = nb > 0 ? border[(int)(mb32() * nb)] : freebuf[(int)(mb32() * nfree)];
            }
            own[pick] = f; cnt[f]++;
        }
    }

    /* iOS deal: each faction's 6 nodes get a shuffled template summing to 20 */
    for (int i = 0; i < N; i++) strength[i] = 1;
    for (int f = 0; f < NF; f++) {
        int owned[MAXN], no = 0;
        for (int i = 0; i < N; i++) if (own[i] == f) owned[no++] = i;   /* ascending id */
        double r = mb32();
        int ti = 3; for (int t = 0; t < 4; t++) if (r < DEAL_CUM[t]) { ti = t; break; }
        int vals[6]; for (int j = 0; j < 6; j++) vals[j] = DEAL_TMPL[ti][j];
        bg_shuffle(vals, 6);
        for (int j = 0; j < no && j < 6; j++) strength[owned[j]] = vals[j];
    }

    for (int i = 0; i < N; i++) owner[i] = own[i];
    return N;
}

/* dump the current adjacency (CSR) for clients/parity tests; returns N. */
int get_adj(int *out_off, int *out_list) {
    for (int i = 0; i <= N; i++) out_off[i] = ADJ_OFF[i];
    int tot = ADJ_OFF[N];
    for (int i = 0; i < tot; i++) out_list[i] = ADJ[i];
    return N;
}

/* emit undirected links as (a,b) pairs with a<b into out[2*L]; returns L. */
int get_links(int *out) {
    int L = 0;
    for (int i = 0; i < N; i++)
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int j = ADJ[k];
            if (i < j) { out[2*L] = i; out[2*L+1] = j; L++; }
        }
    return L;
}

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
    if (CAP_READY) return;   /* single-shot closed form; build once */
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
            CAPP[a][d]  = pr_cap(a, d);
            /* deterministic occupier strength after a capture = max(1, a-d);
             * CAPES holds P*E[str] so exp_cap_strength returns it directly. */
            int occ = a - d; if (occ < 1) occ = 1;
            CAPES[a][d] = CAPP[a][d] * (double)occ;
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

/* ---- ranked RED policy (C1-tuned), the single rollout policy ----
 * The tuned C1 weight vector is baked in. Order: capture, weakTarget, margin,
 * source, redAdj, merge, largestTouch, enemyCount, eliminate, exposure,
 * lowChancePenalty, strongTargetPenalty, threshold. */
typedef struct {
    double capture, weakTarget, margin, source, redAdj, merge, largestTouch;
    double enemyCount, eliminate, exposure, lowChancePenalty, strongTargetPenalty;
    double threshold;
} RankWeights;

static const RankWeights RW = {  /* C1 */
    .capture=44.687, .weakTarget=69.885, .margin=9.789, .source=1.754,
    .redAdj=59.153, .merge=114.472, .largestTouch=77.164, .enemyCount=9.322,
    .eliminate=0, .exposure=60.487, .lowChancePenalty=140.411,
    .strongTargetPenalty=0, .threshold=220.775,
};

/* Bot policy hook — retained for client API compatibility but now INERT: the
 * shipped bot (best_bot_move) is attacker-strength-first with random tie-breaks
 * baked in, so the old stochastic tie-break probe modes no longer apply. */
static int BOT_POLICY_MODE = 0;
static double BOT_POLICY_EPS = 0.0;

void set_bot_policy(int mode, double eps) {
    BOT_POLICY_MODE = mode;
    BOT_POLICY_EPS = eps;
}

/* red component labels: label[i] = component index (-1 if not red) */
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

/* best ranked RED move (deterministic argmax); returns frm<<8|to, or A_END. */
static int ranked_best_move(const int *owner, const int *strength) {
    int c[NF]; counts(owner, c);
    int largest = red_labels(owner);
    int best_act = A_END;
    double best = RW.threshold;   /* END competes at the stop threshold */
    for (int i = 0; i < N; i++) {
        if (owner[i] != 0 || strength[i] <= 1) continue;
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int to = ADJ[k];
            if (owner[to] == 0) continue;   /* attack enemies only (RED is owner 0) */
            double s = ranked_score(owner, strength, c, largest, i, to);
            if (s > best) { best = s; best_act = (i << 8) | to; }
        }
    }
    return best_act;
}

/* dice battle, frm attacks to — fitted iOS power-ratio mechanic */
static void resolve_battle(int *owner, int *strength, int frm, int to) {
    int a = strength[frm], d = strength[to];
    if (RNG() < pr_cap(a, d)) {       /* capture: occupier = max(1, a-d) */
        owner[to] = owner[frm];
        int occ = a - d; if (occ < 1) occ = 1;
        strength[to] = occ;
        strength[frm] = 1;
    } else {                          /* repel: defender gutted by the attack */
        strength[frm] = 1;
        int rem = d - a + 1;
        strength[to] = rem > 0 ? rem : 0;
    }
}

/* resolve_battle variant that records the per-round flip sequence + outcome meta,
 * for the browser battle animation. out_flips[i] = 1 (defender lost a unit) or 0
 * (attacker lost a unit); *out_len = number of flips. out_meta = {captured,
 * fromStart, toStart, fromStrength, toStrength}. Uses the active RNG. */
void resolve_battle_logged(int *owner, int *strength, int frm, int to,
                           int *out_flips, int *out_len, int *out_meta) {
    int a0 = strength[frm], d0 = strength[to];
    int captured = (RNG() < pr_cap(a0, d0)) ? 1 : 0;
    int def_loss, atk_loss;
    if (captured) {
        owner[to] = owner[frm];
        int occ = a0 - d0; if (occ < 1) occ = 1;
        strength[to] = occ;
        strength[frm] = 1;
        def_loss = d0;                 /* defender wiped */
        atk_loss = a0 - occ - 1;       /* troops lost reaching the node */
    } else {
        strength[frm] = 1;
        int rem = d0 - a0 + 1; if (rem < 0) rem = 0;
        strength[to] = rem;
        def_loss = d0 - rem;
        atk_loss = a0 - 1;             /* source gutted to 1 */
    }
    /* synthesize a flip sequence consistent with the survivors (cosmetic only):
     * defender losses (1) then attacker losses (0). */
    int nf = 0;
    for (int i = 0; i < def_loss && nf < 2 * MAXS; i++) out_flips[nf++] = 1;
    for (int i = 0; i < atk_loss && nf < 2 * MAXS; i++) out_flips[nf++] = 0;
    *out_len = nf;
    out_meta[0] = captured;
    out_meta[1] = a0;
    out_meta[2] = d0;
    out_meta[3] = strength[frm];
    out_meta[4] = strength[to];
}

/* best_bot_move: return packed (frm<<8|to)+1, or 0 if none. */
static int best_bot_move(const int *owner, const int *strength, int faction) {
    /* Attacker-strength-first (matches observed iOS bot): pick the STRONGEST
     * owned node that has any legal target; for that strength tier take the
     * WEAKEST reachable defender (== biggest margin once the attacker is fixed);
     * break remaining ties at random. So 7->6 fires before 5->1. */
    int rf[MAXN * 8], rt[MAXN * 8], rn=0;
    int best_a=0, best_d=0; int found=0;
    for (int i = 0; i < N; i++) {
        if (owner[i] != faction || strength[i] <= 1) continue;
        int si = strength[i];
        for (int k = ADJ_OFF[i]; k < ADJ_OFF[i+1]; k++) {
            int j = ADJ[k];
            if (owner[j] == faction || strength[j] >= si) continue;
            int dj = strength[j];
            if (rn < MAXN * 8) { rf[rn] = i; rt[rn] = j; rn++; }
            if (!found || si > best_a || (si == best_a && dj < best_d)) {
                best_a = si; best_d = dj; found = 1;
            }
        }
    }
    if (!found) return 0;
    /* collect every move at the (strongest-attacker, weakest-defender) tier */
    int pf[MAXN * 8], pt[MAXN * 8], pn = 0;
    for (int r = 0; r < rn; r++) {
        if (strength[rf[r]] == best_a && strength[rt[r]] == best_d) {
            pf[pn] = rf[r]; pt[pn] = rt[r]; pn++;
        }
    }
    int idx = 0;
    if (pn > 1) {
        idx = (int)(RNG() * pn);
        if (idx < 0) idx = 0;
        if (idx >= pn) idx = pn - 1;
    }
    return ((pf[idx] << 8) | pt[idx]) + 1;
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

/* full playout to terminal; RED plays the ranked C1 policy. Returns 1 if RED wins.
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
        /* RED turn (ranked C1 policy) */
        int g = 0;
        while (g < 200) {
            int mv = ranked_best_move(owner, strength);
            if (mv == A_END) break;
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

/* ===================== open-loop PUCT MCTS (pure UCT + rollout) ===========
 * Single-agent stochastic planning: bots fold into end_turn, dice are the only
 * randomness (private sim rng, re-sampled from root each simulation). Uniform
 * priors, rollout leaf. Actions: attack = frm<<8|to, END = A_END.
 */
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
 * sets *winner (1=red wins, 0=loss) when terminal. mutates turns via *pturns. */
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
        resolve_battle(owner, strength, frm, to);
        int w = check_winner(owner);
        int c[NF]; counts(owner, c);
        if (w != -1 || c[0] == 0) { *winner = (w == 0); return 1; }
        return 0;
    }
}

/* Run the C UCT search from (owner_in, strength_in). Reports the root's legal
 * children: out_acts[k] (frm<<8|to, or A_END), out_visits[k], out_q[k] (backed-up
 * RED win-prob = winexp). Returns child count, or -1 on pool alloc failure.
 * nroll = rollouts averaged per leaf. */
int uct_search(const int *owner_in, const int *strength_in, int root_turns,
               int sims, double c_puct, int nroll,
               int *out_acts, int *out_visits, double *out_q) {
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
        static int path_eidx[16384]; int plen = 0;
        int leaf_value_set = 0; double leaf_value = 0.0;

        for (;;) {
            if (plen >= 16384) { leaf_value = NODES[cur].v; leaf_value_set = 1; break; }
            MNode *node = &NODES[cur];
            /* terminal node cached by a prior sim: treat as leaf (never select). */
            if (node->terminal) { leaf_value = node->v; leaf_value_set = 1; break; }
            if (!node->expanded) {
                int nc = legal_red(owner, strength, legal);
                if (next_edge + nc > EDGE_CAP) { leaf_value = node->v; leaf_value_set = 1; break; }
                node->child_off = (int)next_edge;
                node->n_children = nc;
                next_edge += nc;
                for (int k = 0; k < nc; k++) {
                    int off = node->child_off + k;
                    E_ACT[off] = legal[k];
                    E_CHILD[off] = -1;
                    E_N[off] = 0;
                    E_W[off] = 0.0;
                    E_P[off] = 1.0 / nc;     /* uniform priors */
                }
                /* leaf eval = rollout average */
                double v = 0.0;
                for (int r = 0; r < nroll; r++) v += rollout(owner, strength, turns);
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

    /* report root children visit counts + backed-up Q */
    MNode *rn = &NODES[root];
    int nc = rn->n_children;
    for (int k = 0; k < nc; k++) {
        int off = rn->child_off + k;
        out_acts[k] = E_ACT[off];
        out_visits[k] = E_N[off];
        if (out_q) out_q[k] = (E_N[off] > 0) ? (E_W[off] / E_N[off]) : rn->v;
    }
    return nc;
}

/* expose primitives for the Python client + parity/regression testing */
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
