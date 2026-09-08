/* White-box math/search regressions. Run:
 * cc -O2 solver/math_gate.c -lm -o /tmp/nw-math-gate && /tmp/nw-math-gate
 */
#include <assert.h>
#include <stdio.h>
#define NW_VALIDATE_SEARCH
#include "fast_engine.c"

static void horizon(void) {
    int owner[30], strength[30], off[31] = {0}, adj[1] = {0};
    for (int i = 0; i < 30; i++) { owner[i] = i < 18 ? 0 : 1; strength[i] = 1; }
    set_topology(30, off, adj); /* disconnected stalemate; RED only has a plurality */
    assert(rollout(owner, strength, MAX_TURNS) == 0);
    int t = MAX_TURNS, w = -1;
    assert(apply_red(owner, strength, A_END, &t, &w) && w == 0);
    assert(sweep_certify(owner, strength, MAX_TURNS, 10, 0) > 0);
}

static double hits(void) { return 0.0; }
static void terminal_chance(void) {
    int off[] = {0, 1, 2}, adj[] = {1, 0};
    int owner[] = {0, 1}, strength[] = {1, 3};
    set_topology(2, off, adj);
    assert(uct_setup(owner, strength, 1, 10, 10, 2.5, 1) == 0);
    use_sim_rng(); uct_sim_once(); /* expand root, whose only action is END */
    RNG = hits; uct_sim_once();   /* green captures RED: one terminal sample */
    int edge = NODES[S_root].child_off;
    assert(E_N[edge] == 1 && E_W[edge] == 0);
    assert(E_CHILD[edge] < 0);   /* must not cache a terminal proof at a chance child */
    use_sim_rng();
}

static void action_union(void) {
    int owner[] = {0, 1, 2}, strength[] = {3, 1, 1};
    int off[] = {0, 1, 3, 4}, adj[] = {1, 0, 2, 1};
    set_topology(3, off, adj);
    assert(uct_setup(owner, strength, 1, 10, 10, 2.5, 1) == 0);
    int legal[MAXCHILD], available[MAXCHILD];
    MNode *node = &NODES[S_root];
    int nc = legal_red(owner, strength, legal);
    assert(sync_actions(node, legal, nc, available));
    int end = node->child_off + available[nc - 1];
    E_N[end] = 7; E_W[end] = 4; E_CHILD[end] = 42;
    /* Another outcome owns node 1 with a mobile stack, making 1->2 newly legal. */
    owner[1] = 0; strength[0] = 1; strength[1] = 2;
    nc = legal_red(owner, strength, legal);
    assert(sync_actions(node, legal, nc, available));
    assert(nc == 2 && node->n_children == 3);
    assert(E_ACT[node->child_off + available[0]] == ((1 << 8) | 2));
    end = node->child_off + available[1];
    assert(E_ACT[end] == A_END && E_N[end] == 7 && E_W[end] == 4 && E_CHILD[end] == 42);
    /* No mobile stack: only END is available even though the union has attacks. */
    strength[1] = 1;
    nc = legal_red(owner, strength, legal);
    assert(sync_actions(node, legal, nc, available));
    assert(nc == 1 && E_ACT[node->child_off + available[0]] == A_END);
}

static void streaming_and_grade(void) {
    int owner[MAXN], strength[MAXN], x[MAXN], y[MAXN];
    int acts[MAXCHILD], vis[MAXCHILD], acts2[MAXCHILD], vis2[MAXCHILD];
    double q[MAXCHILD], q2[MAXCHILD];
    new_game(42, owner, strength, x, y);
    uint32_t mb = get_rng_mb32();
    uct_set_grade(0); uct_set_value_stop(-1, 0, 2, 1); /* force an early stop */
    use_sim_rng(); set_sim_seed(123);
    int nc = uct_search(owner, strength, 1, 256, 2048, 2.5, 1, acts, vis, q);
    int done = uct_sims_done(); assert(done == 256);
    assert(uct_step(1000) && uct_sims_done() == done); /* completion is sticky */
    set_sim_seed(123); uct_begin(owner, strength, 1, 256, 2048, 2.5, 1);
    while (!uct_step(37)) {}
    assert(uct_report(acts2, vis2, q2) == nc && uct_sims_done() == done);
    for (int k = 0; k < nc; k++) assert(acts[k] == acts2[k] && vis[k] == vis2[k] && q[k] == q2[k]);
    uct_set_grade(1); set_sim_seed(123);
    uct_search(owner, strength, 1, 256, 2048, 2.5, 1, acts, vis, q);
    assert(uct_sims_done() == 2048); /* a high leader must not truncate grading */
    assert(get_rng_mb32() == mb);
    uct_set_grade(0); uct_set_value_stop(-1, 2, 2, 1 << 30);
    /* Zero rollouts is normalized instead of generating NaN. */
    uct_search(owner, strength, 1, 16, 16, 2.5, 0, acts, vis, q);
    for (int k = 0; k < nc; k++) assert(isfinite(q[k]) && q[k] >= 0 && q[k] <= 1);
    for (int i = 0; i < N; i++) owner[i] = 0;
    assert(uct_search(owner, strength, 1, 16, 16, 2.5, 1, acts, vis, q) == 0);
}

static CapEstimate reference_cap_estimate(int a, int d) {
    size_t width = (size_t)d + 1;
    double *rows = calloc(4 * width, sizeof(double));
    assert(rows);
    double *prev_p = rows, *next_p = rows + width;
    double *prev_s = rows + 2 * width, *next_s = rows + 3 * width;
    for (int aa = 2; aa <= a; aa++) {
        next_p[0] = 1.0; next_s[0] = aa - 1;
        for (int dd = 1; dd <= d; dd++) {
            next_p[dd] = (prev_p[dd-1] + next_p[dd-1] + prev_p[dd]) / 3.0;
            next_s[dd] = (prev_s[dd-1] + next_s[dd-1] + prev_s[dd]) / 3.0;
        }
        double *tmp = prev_p; prev_p = next_p; next_p = tmp;
        tmp = prev_s; prev_s = next_s; next_s = tmp;
    }
    double pp = 0.0, ps = 0.0;
    for (int c1 = 0; c1 < 2; c1++) for (int c2 = 0; c2 < 2; c2++) {
        int dd = d - c1 - c2; if (dd < 0) dd = 0;
        pp += 0.25 * prev_p[dd]; ps += 0.25 * prev_s[dd];
    }
    free(rows);
    return (CapEstimate){a, d, pp, pp > 0 ? ps / pp : 0.0};
}

static void battle_tables(void) {
    build_cap_tables();
    free(CAP_EXT_P); free(CAP_EXT_S); CAP_EXT_P = CAP_EXT_S = NULL;
    CAP_EXT_A = 1; CAP_EXT_D = 0;
    memset(CAP_LARGE, 0, sizeof(CAP_LARGE));
    assert(fabs(capture_prob(2, 1) - 5.0 / 6.0) < 1e-12);
    for (int a = 2; a < MAXS; a += 13) for (int d = 1; d < MAXS; d += 17) {
        CapEstimate e = large_cap_estimate(a, d);
        assert(fabs(e.p - CAPP[a][d]) < 1e-12);
        assert(fabs(e.strength - CAPES[a][d]) < 1e-10);
    }
    // Grow each dimension separately and together, revisit old cells, and cross
    // the bounded cache into the original two-row fallback. Exact, not tolerance.
    const int pairs[][2] = {{160,1}, {180,200}, {400,160}, {160,400}, {511,511},
        {700,900}, {1023,1023}, {160,200}, {1024,160}, {160,1024}, {1400,1100}};
    for (unsigned i = 0; i < sizeof(pairs)/sizeof(pairs[0]); i++) {
        int a = pairs[i][0], d = pairs[i][1];
        CapEstimate actual = large_cap_estimate(a, d);
        CapEstimate expected = reference_cap_estimate(a, d);
        assert(actual.p == expected.p && actual.strength == expected.strength);
    }
    assert(capture_prob(400, 160) > .999999);
    assert(capture_prob(160, 400) < .000001);
    assert(exp_cap_strength(400, 0) == 399);
    assert(exp_cap_strength(400, 1) > 397);
}

static void sampled_legality(void) {
    int owner[MAXN], strength[MAXN], x[MAXN], y[MAXN];
    int acts[MAXCHILD], vis[MAXCHILD]; double q[MAXCHILD];
    for (int seed = 1; seed <= 40; seed++) {
        new_game(seed, owner, strength, x, y);
        for (int turn = 1; turn <= 3 && check_winner(owner) < 0; turn++) {
            use_sim_rng(); set_sim_seed(123);
            int nc = uct_search(owner, strength, turn, 1500, 1500, 2.5, 1, acts, vis, q);
            for (int k = 0; k < nc; k++) assert(isfinite(q[k]) && q[k] >= 0 && q[k] <= 1);
            end_turn(owner, strength);
        }
    }
}

int main(void) {
    horizon(); terminal_chance(); action_union(); streaming_and_grade();
    battle_tables(); sampled_legality();
    assert(capture_prob(1, 0) == 0 && capture_prob(2, 0) == 1);
    puts("PASS: horizon outcomes, chance terminals, sampled legal action union, streaming, grading budget, finite Q, terminal roots, large-stack DP, sampled legality");
}
