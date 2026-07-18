/* fast_engine.c — Network Wars engine + C-UCT search (the single source of truth).
 *
 * One implementation of the whole game: board generation + deal, the four
 * deterministic bots, the fair-coin-attrition battle, reinforcement, win check,
 * and an open-loop PUCT/MCTS player for RED. Python (fastnw.py) and the browser
 * (solver/server.py) are thin clients over this; there is no second port.
 *
 * Board state = owner[N] (0=red, 1..4=bots), strength[N]; functions mutate the
 * caller-provided int arrays in place. Topology (adjacency) is set per game via
 * set_topology() — or built in C by new_game(), which also fills owner/strength.
 *
 * Two RNG sources, selected by the RNG function pointer:
 *   - mulberry32 (set_rng_mb32): the real seeded game stream. Used for board-gen
 *     and for playing out the real iOS-faithful game.
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
/* REAL battle — decompiled bit-exact from the shipped iOS app (Xamarin/Mono
 * ARM64; see solver/REAL_BATTLE_DECOMPILED.md and ipa_decompile/). It is ITERATED
 * FAIR-COIN ATTRITION with NO fitted parameters and NO separate survivor draw:
 *   - the atomic op is killflip(team) = teamRandom.Next(2) = a FAIR coin (p=0.5);
 *   - two guarded attacker "pre-fires" (each: coin -> defender loses one),
 *   - then a symmetric loop: every round the attacker's coin can drop a defender
 *     and the defender's coin can drop an attacker, until d==0 or a==1;
 *   - CAPTURE iff a>1 && d==0: occupier = a-1, source keeps exactly 1;
 *     REPEL otherwise: source ground down to 1, defender keeps its remnant d.
 * Survivors are whatever the coin war leaves — the attrition loop *is* the
 * survivor distribution (no beta-binomial). resolve_battle() below is the exact
 * loop; the search's CAPP/CAPES tables are the exact DP of that loop. */
#define A_END (-1)          /* action sentinel: distinct from any frm<<8|to (>=0) */
#define MAXCHILD 512        /* max legal RED actions at one node */
#define UCT_CHECK_EVERY 256 /* adaptive-stop: re-check root visit margin this often */

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
static const double DEAL_CUM[4] = {0.392, 0.722, 0.923, 1.0};  /* 0.392,+0.330,+0.201,+0.077; MLE over 2163 live faction-deals */

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
 * The EXACT DP of resolve_battle's iterated fair-coin loop.
 * Main-loop tables (no pre-fires), for a>1,d>0:
 *   CP[a][d] = P(capture)          = ( CP[a-1][d-1]+CP[a][d-1]+CP[a-1][d] ) / 3
 *   CS[a][d] = E[occupier*1{cap}]  = ( CS[a-1][d-1]+CS[a][d-1]+CS[a-1][d] ) / 3
 * (the /3 conditions the two coins on at-least-one-hit; the no-hit case just
 *  repeats the state). Boundaries: CP[a][0]=CS bases at (a>1); a==1 -> 0.
 * The occupier is the terminal a-1, so CS bases CS[a][0]=a-1.
 * CAPP/CAPES then fold in the two guarded attacker pre-fires on d (a fixed).
 * capES = CAPES/CAPP (expected occupier strength after a capture). */
#define MAXS 160
static double CAPP[MAXS][MAXS];
static double CAPES[MAXS][MAXS];
static int CAP_READY = 0;

static void build_cap_tables(void) {
    if (CAP_READY) return;
    static double CP[MAXS][MAXS], CS[MAXS][MAXS];
    for (int a = 0; a < MAXS; a++) {
        CP[a][0] = (a > 1) ? 1.0 : 0.0;
        CS[a][0] = (a > 1) ? (double)(a - 1) : 0.0;
    }
    for (int d = 1; d < MAXS; d++) {
        CP[0][d] = CS[0][d] = 0.0;
        CP[1][d] = CS[1][d] = 0.0;
    }
    for (int a = 2; a < MAXS; a++)
        for (int d = 1; d < MAXS; d++) {
            CP[a][d] = (CP[a-1][d-1] + CP[a][d-1] + CP[a-1][d]) / 3.0;
            CS[a][d] = (CS[a-1][d-1] + CS[a][d-1] + CS[a-1][d]) / 3.0;
        }
    /* fold in the two guarded attacker pre-fires (each: coin drops d if d>0) */
    for (int a = 0; a < MAXS; a++)
        for (int d = 0; d < MAXS; d++) {
            if (a <= 1) { CAPP[a][d] = CAPES[a][d] = 0.0; continue; }
            double pp = 0.0, ps = 0.0;
            for (int c1 = 0; c1 < 2; c1++)
                for (int c2 = 0; c2 < 2; c2++) {
                    int dd = d;
                    if (dd > 0 && c1) dd--;
                    if (dd > 0 && c2) dd--;
                    pp += 0.25 * CP[a][dd];
                    ps += 0.25 * CS[a][dd];
                }
            CAPP[a][d] = pp;
            CAPES[a][d] = ps;   /* already P*E[occupier]: matches exp_cap_strength */
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

/* dice battle, frm attacks to — the REAL decompiled iOS mechanic (fair coins).
 * Bit-exact to Utils.doAttack/doAttackConsole (see REAL_BATTLE_DECOMPILED.md):
 * two guarded attacker pre-fires, then a symmetric fair-coin exchange, keep-1. */
static void resolve_battle(int *owner, int *strength, int frm, int to) {
    int a = strength[frm], d = strength[to];
    if (d > 0 && a > 1 && RNG() < 0.5) d--;             /* attacker pre-fire 1 */
    if (d > 0 && a > 1 && RNG() < 0.5) d--;             /* attacker pre-fire 2 */
    while (d > 0 && a > 1) {
        if (RNG() < 0.5) d--;                           /* attacker coin -> defender loses one */
        if (RNG() < 0.5) a--;                           /* defender coin -> attacker loses one */
    }
    if (a > 1 && d == 0) {           /* capture: occupier = a-1, source keeps 1 */
        owner[to] = owner[frm];
        strength[to] = a - 1;
        strength[frm] = 1;
    } else {                         /* repel: source ground to 1, defender keeps remnant */
        strength[frm] = 1;
        strength[to] = d;
    }
}

/* resolve_battle variant that records the per-round flip sequence + outcome meta,
 * for the browser battle animation. out_flips[i] = 1 (defender lost a unit) or 0
 * (attacker lost a unit); *out_len = number of flips. out_meta = {captured,
 * fromStart, toStart, fromStrength, toStrength}. Uses the active RNG. */
void resolve_battle_logged(int *owner, int *strength, int frm, int to,
                           int *out_flips, int *out_len, int *out_meta) {
    int a0 = strength[frm], d0 = strength[to];
    int a = a0, d = d0, nf = 0;
    /* the TRUE per-round loss sequence (each real coin that lands a hit):
     * 1 = defender lost a unit, 0 = attacker lost a unit. */
    if (d > 0 && a > 1 && RNG() < 0.5) { d--; if (nf < 2 * MAXS) out_flips[nf++] = 1; }
    if (d > 0 && a > 1 && RNG() < 0.5) { d--; if (nf < 2 * MAXS) out_flips[nf++] = 1; }
    while (d > 0 && a > 1) {
        if (RNG() < 0.5) { d--; if (nf < 2 * MAXS) out_flips[nf++] = 1; }
        if (RNG() < 0.5) { a--; if (nf < 2 * MAXS) out_flips[nf++] = 0; }
    }
    int captured = (a > 1 && d == 0) ? 1 : 0;
    if (captured) {
        owner[to] = owner[frm];
        strength[to] = a - 1;
        strength[frm] = 1;
    } else {
        strength[frm] = 1;
        strength[to] = d;
    }
    *out_len = nf;
    out_meta[0] = captured;
    out_meta[1] = a0;
    out_meta[2] = d0;
    out_meta[3] = strength[frm];
    out_meta[4] = strength[to];
}

/* BOT TURN — decompiled from the shipped iOS app (OpponentAIOriginal.opponentMove
 * + OpponentAIBase.getSmallestEnemy/okAttack; asm in ipa_decompile/re/ai/).
 * One pass over the islands owned at TURN START, strongest first; each island
 * opens an attack CHAIN: attack its smallest adjacent enemy, and on capture the
 * chain FOLLOWS the moved stack (the occupier keeps attacking its own smallest
 * adjacent enemy) until a repel or okAttack fails. A stack is never revisited,
 * and attacks that open up later in the turn are not taken. okAttack =
 * attacker >= 2 and strictly bigger than the defender. Ties (equal-strength
 * islands, equal-strength targets) are deterministic in the real game (stable
 * sort over the player's island list / adjacency order); here: node id
 * ascending / adjacency order — no RNG.
 *
 * The cursor packs into an int32 buffer (BOT_ST_LEN) so thin clients can replay
 * a turn attack-by-attack: st[0]=island count, st[1]=list index,
 * st[2]=last attack's target (the chain head candidate; -1 between chains),
 * st[3..]=islands sorted strength-desc. bot_turn_next() must be called with the
 * previous attack already resolved: it continues the chain iff we now own st[2]. */
#define BOT_ST_LEN (MAXN + 3)

/* smallest adjacent enemy of `node` (strict <, first-found wins ties), or -1. */
static int smallest_adjacent_enemy(const int *owner, const int *strength,
                                   int node, int faction) {
    int best = -1, bs = 0;
    for (int k = ADJ_OFF[node]; k < ADJ_OFF[node+1]; k++) {
        int j = ADJ[k];
        if (owner[j] == faction) continue;
        if (best < 0 || strength[j] < bs) { best = j; bs = strength[j]; }
    }
    return best;
}

void bot_turn_begin(const int *owner, const int *strength, int faction, int *st) {
    int n = 0;
    for (int i = 0; i < N; i++)
        if (owner[i] == faction) st[3 + n++] = i;
    /* stable insertion sort, strength descending (ties stay node-id ascending) */
    for (int a = 1; a < n; a++) {
        int v = st[3 + a], b = a - 1;
        while (b >= 0 && strength[st[3 + b]] < strength[v]) { st[3+b+1] = st[3+b]; b--; }
        st[3 + b + 1] = v;
    }
    st[0] = n; st[1] = 0; st[2] = -1;
}

/* next attack as packed (frm<<8|to)+1, or 0 when the turn's attacks are done. */
int bot_turn_next(const int *owner, const int *strength, int faction, int *st) {
    int cur = st[2];
    if (cur >= 0 && owner[cur] == faction) {        /* captured -> chain continues */
        int tgt = smallest_adjacent_enemy(owner, strength, cur, faction);
        if (tgt >= 0 && strength[cur] >= 2 && strength[cur] > strength[tgt]) {
            st[2] = tgt;
            return ((cur << 8) | tgt) + 1;
        }
    }
    st[2] = -1;
    while (st[1] < st[0]) {
        int isl = st[3 + st[1]++];
        int tgt = smallest_adjacent_enemy(owner, strength, isl, faction);
        if (tgt >= 0 && strength[isl] >= 2 && strength[isl] > strength[tgt]) {
            st[2] = tgt;
            return ((isl << 8) | tgt) + 1;
        }
    }
    return 0;
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
    int st[BOT_ST_LEN];
    bot_turn_begin(owner, strength, faction, st);
    for (;;) {
        int mv = bot_turn_next(owner, strength, faction, st);
        if (mv == 0) break;
        mv -= 1;
        int to = mv & 0xFF;
        resolve_battle(owner, strength, mv >> 8, to);
        /* only a capture (this faction now owns `to`) can change the winner. */
        if (owner[to] == faction && check_winner(owner) != -1) return;
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
            int to = mv & 0xFF;
            resolve_battle(owner, strength, mv >> 8, to);
            /* only a capture (red now owns `to`) can change the winner; a repel
             * leaves all ownership — and thus the win-check — unchanged. */
            if (owner[to] == 0 && check_winner(owner) != -1) break;
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
    long total_n;      /* cached sum of child visits (== times selected through) */
    double v;
} MNode;

static MNode  *NODES = NULL;
static int    *E_ACT = NULL;
static int    *E_CHILD = NULL;     /* node index of child, -1 = none */
static int    *E_CHILD2 = NULL;    /* repel-outcome child (chance-split mode), -1 = none */
static int    *E_N = NULL;
static double *E_W = NULL;
static double *E_P = NULL;
static long NODE_CAP = 0, EDGE_CAP = 0;
static long next_node = 0, next_edge = 0;

/* Chance-split tree: an attack edge's child is keyed on the SAMPLED battle
 * outcome (capture -> E_CHILD, repel -> E_CHILD2) instead of funnelling both
 * outcomes into one node. Edge stats (E_N/E_W, used by PUCT) stay
 * action-level, so selection still ranks actions by their outcome-averaged
 * value; only the subtree below is outcome-coherent (the follow-up plan after
 * a capture doesn't share a node with the plan after a repel). END keeps one
 * child (the bot-turn chance space is too big to key). Adopted 2026-07-02
 * after the SEARCH_VARIANTS.md study: non-negative everywhere (~+0.4pt ns),
 * zero per-sim cost, and merged-outcome trees were shown to carry real bias
 * (the reuse experiment lost 12pt off that incoherence). */

static int ensure_pools(long ncap, long ecap) {
    if (ncap > NODE_CAP) {
        NODES = (MNode*)realloc(NODES, ncap * sizeof(MNode));
        NODE_CAP = ncap;
        if (!NODES) return 0;
    }
    if (ecap > EDGE_CAP) {
        E_ACT    = (int*)realloc(E_ACT,    ecap * sizeof(int));
        E_CHILD  = (int*)realloc(E_CHILD,  ecap * sizeof(int));
        E_CHILD2 = (int*)realloc(E_CHILD2, ecap * sizeof(int));
        E_N      = (int*)realloc(E_N,      ecap * sizeof(int));
        E_W      = (double*)realloc(E_W,   ecap * sizeof(double));
        E_P      = (double*)realloc(E_P,   ecap * sizeof(double));
        EDGE_CAP = ecap;
        if (!E_ACT || !E_CHILD || !E_CHILD2 || !E_N || !E_W || !E_P) return 0;
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
    m->n_children = 0; m->child_off = -1; m->expanded = 0; m->terminal = 0;
    m->total_n = 0; m->v = 0.5;
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

/* ---- search context: shared by the one-shot uct_search and the streaming
 * uct_begin/uct_step/uct_report API, so both run the IDENTICAL sim + early-stop
 * (the chunked path just reads intermediate stats between sims). ---- */
static int    S_root;
static int    S_root_turns;
static double S_cpuct;
static int    S_nroll;
static int    S_min_sims, S_max_sims;
static int    S_sims;                          /* sims completed so far */
static int    S_owner0[MAXN], S_strength0[MAXN];

/* ---- grading mode (uct_set_grade) — accurate COMPARISON across the root moves,
 * instead of fastest-possible best-move pick. Plain UCT is a best-arm allocator:
 * the winner's Q converges deep while every other root child is starved, so its Q
 * is contaminated by early sims (taken before the search found the good follow-up
 * in that subtree) and leans on the pessimistic C1 rollout — gaps vs best are
 * systematically INFLATED. Used for blunder analysis / grading human play, where
 * the played move is often NOT the search's pick and its Q must mean something.
 * Three changes, all root-level and opt-in (mode 0 = off = bit-identical search):
 *   1. min-visit floor: any root child below GRADE_FLOOR_FRAC of the uniform
 *      share is selected before PUCT gets to choose (deterministic — no extra
 *      RNG draws), so every move's subtree gets real tree-correction.
 *   2. early stops: visit-margin / deep-think / value-GAP stops are disabled
 *      (they fire exactly on the contested positions grading cares about); only
 *      the decisive value stop (leader <= lo or >= hi => position is decided,
 *      every move ties, the review's dead-filter drops it anyway) still fires.
 *   3. second-half Q (mode 1): root Qs are reported from sims AFTER the halfway
 *      snapshot only, discarding the burn-in contamination. Mode 2 keeps the
 *      floor+stops but reports cumulative Q (A/B probe for grade_eval.py). */
#define GRADE_FLOOR_FRAC 0.35   /* each root child gets >= this x uniform share */
#define GRADE_MIN_HALF   16     /* below this many post-snapshot visits, fall back */
static int    GRADE = 0;
static int    GS_done = 0;               /* halfway snapshot taken this search */
static int    GS_N[MAXCHILD];
static double GS_W[MAXCHILD];
void uct_set_grade(int mode) { GRADE = mode; }

/* run exactly one simulation against the persistent tree; increments S_sims. */
static void uct_sim_once(void) {
    int legal[MAXCHILD];
    int owner[MAXN], strength[MAXN];
    static int path_eidx[16384];
    memcpy(owner, S_owner0, N * sizeof(int));
    memcpy(strength, S_strength0, N * sizeof(int));
    int turns = S_root_turns;
    int cur = S_root;
    int plen = 0;
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
                E_CHILD2[off] = -1;
                E_N[off] = 0;
                E_W[off] = 0.0;
                E_P[off] = 1.0 / nc;     /* uniform priors */
            }
            /* leaf eval = rollout average */
            double v = 0.0;
            for (int r = 0; r < S_nroll; r++) v += rollout(owner, strength, turns);
            v /= (double)S_nroll;
            node->expanded = 1;
            node->v = v;
            leaf_value = v; leaf_value_set = 1;
            break;
        }
        /* select best child (PUCT). total == sum of child visits from prior
         * sims; cached on the node (each pass-through adds exactly one). */
        int nc = node->n_children;
        long total = node->total_n;
        int best_k = -1;
        /* grading mode: root min-visit floor — top up the most-starved root child
         * whenever it falls under its share, so every move's Q stays comparable. */
        if (GRADE && cur == S_root && nc > 1) {
            long need = (long)(GRADE_FLOOR_FRAC * (double)total / nc);
            int mk = 0, mn = E_N[node->child_off];
            for (int k = 1; k < nc; k++) {
                int n = E_N[node->child_off + k];
                if (n < mn) { mn = n; mk = k; }
            }
            if (mn < need) best_k = mk;
        }
        if (best_k < 0) {
            double sqrt_total = sqrt((double)total) + 1e-8;
            double best_u = -1e30;
            best_k = 0;
            for (int k = 0; k < nc; k++) {
                int off = node->child_off + k;
                int n = E_N[off];
                double q = (n > 0) ? (E_W[off] / n) : node->v;
                double u = q + S_cpuct * E_P[off] * sqrt_total / (1 + n);
                if (u > best_u) { best_u = u; best_k = k; }
            }
        }
        int off = node->child_off + best_k;
        node->total_n++;        /* this pass adds one visit through this node */
        path_eidx[plen] = off; plen++;
        int act = E_ACT[off];
        int winner = 0;
        int term = apply_red(owner, strength, act, &turns, &winner);
        /* chance-split: an attack's child is keyed on the sampled outcome so the
         * subtree below is outcome-coherent. Repel leaves `to` enemy-owned. */
        int *slot = &E_CHILD[off];
        if (act != A_END && owner[act & 0xFF] != 0)
            slot = &E_CHILD2[off];
        if (term) {
            leaf_value = winner ? 1.0 : 0.0; leaf_value_set = 1;
            if (*slot < 0) {
                int cn = new_node();
                if (cn >= 0) { NODES[cn].expanded = 1; NODES[cn].terminal = 1; NODES[cn].v = leaf_value; *slot = cn; }
            }
            break;
        }
        if (turns > MAX_TURNS) { leaf_value = 0.0; leaf_value_set = 1; break; }
        if (*slot < 0) {
            int cn = new_node();
            if (cn < 0) { leaf_value = NODES[cur].v; leaf_value_set = 1; break; }
            *slot = cn;
        }
        cur = *slot;
    }
    /* backup */
    double val = leaf_value_set ? leaf_value : 0.5;
    for (int p = 0; p < plen; p++) {
        int off = path_eidx[p];
        E_N[off] += 1;
        E_W[off] += val;
    }
    S_sims++;
}

/* Optional value-based early stop — OFF by default, so uct_search and the gates
 * keep the strict (move-identical) visit-margin behavior. Enable via
 * uct_set_value_stop to "settle on a clear winner": once the leading move has
 * >= min_vis visits AND its RED win-prob is decisive (<= lo or >= hi) OR it
 * dominates the runner-up by >= gap, stop early. Rollout value is most accurate
 * at decided extremes (memory rollout-policy-accuracy), so the decisive case is
 * the safe one; gap is the riskier midgame case — keep it conservative. */
static double VS_LO = -1.0, VS_HI = 2.0, VS_GAP = 2.0;   /* disabled: never fire */
static int    VS_MINVIS = 1 << 30;
void uct_set_value_stop(double lo, double hi, double gap, int min_vis) {
    VS_LO = lo; VS_HI = hi; VS_GAP = gap; VS_MINVIS = min_vis;
}

/* Optional "deep-think" relative-margin early stop — OFF by default. Unlike the
 * absolute visit-margin (b1-b2 > remaining), which scales with the ceiling and so
 * spends ~half a high ceiling on EVERY position, this fires as soon as the leading
 * root move DOMINATES the runner-up by a fixed ratio (b1 >= ratio*b2) — independent
 * of the ceiling. So a decided position stops at the floor (cheap) while a genuinely
 * contested one (b1 ~= b2) never satisfies it and runs to the high ceiling = deep
 * search exactly where the move is unresolved. Keys on MOVE dominance, not win-prob
 * (probe finding: value-drift does NOT predict where deeper search changes the
 * outcome; move-choice instability does). Enable via uct_set_deepthink. */
static double DT_RATIO = 0.0;          /* 0 disabled */
static int    DT_MINVIS = 1 << 30;
static double DT_BEHIND = 2.0;         /* leader win-prob >= this => not behind => stop (2.0 = off) */
void uct_set_deepthink(double ratio, int min_vis, double behind) {
    DT_RATIO = ratio; DT_MINVIS = min_vis; DT_BEHIND = behind;
}

/* early-stop test: stop when the move is locked by visit-margin (runner-up can't
 * catch the leader in the sims remaining — move-identical) or, if value-stop is
 * enabled, when the leader is a clear winner by win-prob. */
static int uct_should_stop(void) {
    MNode *rn0 = &NODES[S_root];
    if (!rn0->expanded) return 0;
    int rnc0 = rn0->n_children, off0 = rn0->child_off;
    long b1 = -1, b2 = -1; int b1k = -1, b2k = -1;
    for (int k = 0; k < rnc0; k++) {
        long n = E_N[off0 + k];
        if (n > b1) { b2 = b1; b2k = b1k; b1 = n; b1k = k; }
        else if (n > b2) { b2 = n; b2k = k; }
    }
    /* grading mode: never stop on move dominance (that fires exactly on the
     * contested positions grading needs full budget for); stop only when the
     * position itself is decided (leader's win-prob past the decisive band). */
    if (GRADE) {
        if (rnc0 <= 1) return 1;
        if (b1 >= VS_MINVIS && b1k >= 0) {
            double q1 = E_W[off0 + b1k] / (double)b1;
            if (q1 <= VS_LO || q1 >= VS_HI) return 1;
        }
        return 0;
    }
    long remaining = (long)S_max_sims - S_sims;
    if (rnc0 <= 1 || b1 - b2 > remaining) return 1;     /* visit-margin (move-identical) */
    if (DT_RATIO > 0.0 && b1 >= DT_MINVIS) {             /* deep-think gating */
        if (b1 >= DT_RATIO * (double)(b2 + 1)) return 1;         /* move dominates -> stop cheap */
        double q1 = E_W[off0 + b1k] / (double)b1;                /* leader RED win-prob */
        if (q1 >= DT_BEHIND) return 1;         /* red NOT behind -> no need to grind, stop cheap */
        /* else: move contested AND red behind (comeback position) -> keep searching to ceiling */
    }
    if (b1 >= VS_MINVIS && b1k >= 0) {                  /* value-based "clear winner" */
        double q1 = E_W[off0 + b1k] / (double)b1;       /* leader's RED win-prob */
        if (q1 <= VS_LO || q1 >= VS_HI) return 1;        /* decided outcome */
        if (b2k >= 0 && b2 >= VS_MINVIS) {
            double q2 = E_W[off0 + b2k] / (double)b2;
            if (q1 - q2 >= VS_GAP) return 1;             /* leader dominates in value */
        }
    }
    return 0;
}

/* set up pools + root for a fresh search; returns 0 ok, -1 on pool alloc fail.
 * NOTE (2026-07-01 study): never warm-start this search from a previous tree —
 * within-turn subtree reuse measured −12pt without outcome-keying and ≤0 with
 * it (see SEARCH_VARIANTS.md). Cold trees are unbiased. */
static int uct_setup(const int *owner_in, const int *strength_in, int root_turns,
                     int min_sims, int max_sims, double c_puct, int nroll) {
    if (min_sims < 1) min_sims = 1;
    if (max_sims < min_sims) max_sims = min_sims;
    /* Measured peak usage: ~1.0 nodes/sim, ~7-8 edges/node. Size pools to
     * max_sims with ~1.5x/12x headroom; any overflow degrades gracefully
     * (new_node() returns -1, edge-cap hit falls back to a leaf). */
    long ncap = (long)max_sims + max_sims / 2 + 4096;
    long ecap = ncap * 12;
    if (!ensure_pools(ncap, ecap)) return -1;
    next_node = 0; next_edge = 0;
    S_root = new_node();
    S_root_turns = root_turns;
    S_cpuct = c_puct; S_nroll = nroll;
    S_min_sims = min_sims; S_max_sims = max_sims;
    S_sims = 0;
    GS_done = 0;
    memcpy(S_owner0,    owner_in,    N * sizeof(int));
    memcpy(S_strength0, strength_in, N * sizeof(int));
    return 0;
}

/* read the root children into out_* (acts=frm<<8|to or A_END, visits, Q=winexp). */
static int uct_collect(int *out_acts, int *out_visits, double *out_q) {
    MNode *rn = &NODES[S_root];
    int nc = rn->n_children;
    for (int k = 0; k < nc; k++) {
        int off = rn->child_off + k;
        out_acts[k] = E_ACT[off];
        out_visits[k] = E_N[off];
        if (out_q) {
            double q = (E_N[off] > 0) ? (E_W[off] / E_N[off]) : rn->v;
            if (GRADE == 1 && GS_done) {
                int dn = E_N[off] - GS_N[k];
                if (dn >= GRADE_MIN_HALF) q = (E_W[off] - GS_W[k]) / dn;
            }
            out_q[k] = q;
        }
    }
    return nc;
}

/* ---- streaming API: drive the search in chunks so the UI can visualize root
 * stats converging. uct_begin() then repeatedly uct_step()+uct_report() until
 * uct_step returns 1. Shares uct_sim_once/uct_should_stop with uct_search, so a
 * chunked run reaches the exact same terminal state as the one-shot. ---- */
int uct_begin(const int *owner_in, const int *strength_in, int root_turns,
              int min_sims, int max_sims, double c_puct, int nroll) {
    return uct_setup(owner_in, strength_in, root_turns, min_sims, max_sims, c_puct, nroll);
}
/* run up to `budget` more sims; returns 1 when finished (early-stop locked or
 * max_sims reached), else 0. Early-stop checked every UCT_CHECK_EVERY sims past
 * min_sims — same cadence as the one-shot, so totals match regardless of chunking. */
int uct_step(int budget) {
    long target = (long)S_sims + budget;
    if (target > S_max_sims) target = S_max_sims;
    while (S_sims < target) {
        uct_sim_once();                 /* increments S_sims */
        /* grading mode: snapshot root stats at halfway so uct_collect can report
         * burn-in-free second-half Qs. Selection never reads the snapshot, so the
         * tree itself is identical with or without it. */
        if (GRADE == 1 && !GS_done && S_sims >= (S_max_sims + 1) / 2) {
            MNode *rn = &NODES[S_root];
            if (rn->expanded) {
                for (int k = 0; k < rn->n_children; k++) {
                    GS_N[k] = E_N[rn->child_off + k];
                    GS_W[k] = E_W[rn->child_off + k];
                }
                GS_done = 1;
            }
        }
        if (S_sims >= S_min_sims && S_sims < S_max_sims
                && S_sims % UCT_CHECK_EVERY == 0 && uct_should_stop())
            return 1;
    }
    return S_sims >= S_max_sims ? 1 : 0;
}
int uct_report(int *out_acts, int *out_visits, double *out_q) {
    return uct_collect(out_acts, out_visits, out_q);
}
int uct_sims_done(void) { return S_sims; }

/* Run the C UCT search from (owner_in, strength_in). Reports the root's legal
 * children: out_acts[k] (frm<<8|to, or A_END), out_visits[k], out_q[k] (backed-up
 * RED win-prob = winexp). Returns child count, or -1 on pool alloc failure.
 * nroll = rollouts averaged per leaf.
 *
 * Adaptive budget: always runs at least min_sims, then stops as soon as the
 * best root move's visit lead over the runner-up exceeds the sims left to
 * max_sims (the runner-up can no longer catch it, so the argmax-visits pick is
 * already locked — identical to running to max_sims). Pass min_sims==max_sims
 * for a fixed budget. So it "thinks harder" only while the top two stay close.
 * Implemented as the streaming path run to completion in one step, so the
 * one-shot and chunked searches are bit-identical. */
int uct_search(const int *owner_in, const int *strength_in, int root_turns,
               int min_sims, int max_sims, double c_puct, int nroll,
               int *out_acts, int *out_visits, double *out_q) {
    if (uct_setup(owner_in, strength_in, root_turns, min_sims, max_sims, c_puct, nroll) < 0)
        return -1;
    while (!uct_step(S_max_sims)) { }   /* run to completion (early-stop or max) */
    return uct_collect(out_acts, out_visits, out_q);
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
int ext_check_winner(const int *owner) { return check_winner(owner); }
