/* Focused gameplay gate. Run:
 * cc -O2 solver/rules_gate.c -lm -o /tmp/nw-rules-gate && /tmp/nw-rules-gate
 * Source evidence and intentional approximations: RULES_AUDIT.md. */
#include <assert.h>
#include <stdio.h>
#include "fast_engine.c"

static void topology(int n, const int edges[][2], int count) {
    int off[MAXN+1], adj[MAXN*8], p = 0;
    for (int i = 0; i < n; i++) {
        off[i] = p;
        for (int j = 0; j < count; j++) {
            if (edges[j][0] == i) adj[p++] = edges[j][1];
            if (edges[j][1] == i) adj[p++] = edges[j][0];
        }
    }
    off[n] = p;
    set_topology(n, off, adj);
}
static int linked(int a, int b) {
    for (int k = ADJ_OFF[a]; k < ADJ_OFF[a+1]; k++) if (ADJ[k] == b) return 1;
    return 0;
}
static int triple(int a, int b, int c) {
    return linked(a,b) + linked(a,c) + linked(b,c) >= 2;
}

static void openings(void) {
    int o[MAXN], s[MAXN], x[MAXN], y[MAXN], observed[6] = {0};
    for (int seed = 0; seed < 10000; seed++) {
        assert(new_game(seed,o,s,x,y) == 30);
        for (int f = 0; f < NF; f++) {
            int big[5], b = 0, total = 0, num = 0;
            for (int i = 0; i < N; i++) if (o[i] == f) {
                total += s[i]; num++;
                if (s[i] > 1) { assert(b < 5); big[b++] = i; }
            }
            assert(num == 6 && total == 20 && b >= 2 && b <= 5);
            observed[b]++;
            if (b == 3) assert(triple(big[0],big[1],big[2]));
            if (b == 4) {
                /* splitArmies(4,18) groups [5,5] and [4,4]. */
                for (int i = 0; i < 4; i++) {
                    int partner = 0;
                    for (int j = 0; j < 4; j++)
                        if (i != j && s[big[i]] == s[big[j]] && linked(big[i],big[j])) partner = 1;
                    assert(partner);
                }
            }
            if (b == 5) {
                /* A connected [4,4,4] triple plus an adjacent [4,3] pair. */
                int valid = 0;
                for (int i = 0; i < 5; i++) for (int j = i+1; j < 5; j++) {
                    if (s[big[i]] + s[big[j]] != 7 || !linked(big[i],big[j])) continue;
                    int rest[3], r = 0;
                    for (int k = 0; k < 5; k++) if (k != i && k != j) rest[r++] = big[k];
                    if (triple(rest[0],rest[1],rest[2])) valid = 1;
                }
                assert(valid);
            }
        }
    }
    for (int i = 2; i <= 5; i++) assert(observed[i] > 0);
}

static void reinforcement(void) {
    const int edges[][2] = {{0,1},{1,2},{2,3},{3,4},{4,5},{5,6}};
    topology(7,edges,6);
    int o[] = {0,0,0,0,1,0,1}, s[] = {1,1,1,1,1,1,1};
    reinforce(o,s,0);
    assert(s[0] == 1 && s[1] == 1 && s[2] == 1 && s[3] == 5 && s[5] == 1);

    /* A disconnected, borderless largest component still supplies a budget
     * of three to the smaller component's sole border node. */
    const int isolated[][2] = {{0,1},{1,2},{3,4},{4,5}};
    topology(6,isolated,4);
    int o2[] = {0,0,0,0,0,1}, s2[] = {1,1,1,1,1,1};
    reinforce(o2,s2,0);
    assert(s2[0] == 1 && s2[1] == 1 && s2[2] == 1 && s2[3] == 1 && s2[4] == 4);
    reinforce(o2,s2,4); /* eliminated faction */
    assert(s2[4] == 4);

    const int line[][2] = {{0,1},{1,2},{2,3},{3,4}};
    topology(5,line,4);
    int o3[] = {1,0,0,0,1}, s3[] = {1,1,1,1,1};
    reinforce(o3,s3,0);
    assert(s3[1] == 3 && s3[2] == 1 && s3[3] == 2); /* three split 2+1 */
}

static double hit(void) { return 0.0; }
static void battles_and_bots(void) {
    const int line[][2] = {{0,1},{1,2},{2,3},{3,4}};
    topology(5,line,4);
    int o[] = {1,0,0,0,2}, s[] = {6,1,1,1,1}, st[BOT_ST_LEN];
    RNG = hit;
    bot_turn_begin(o,s,1,st);
    for (int from = 0; from < 4; from++) {
        int m = bot_turn_next(o,s,1,st) - 1;
        assert(m == ((from << 8) | (from+1)));
        resolve_battle(o,s,from,from+1);
        assert(s[from] == 1 && o[from+1] == 1 && s[from+1] == 5-from);
    }
    assert(bot_turn_next(o,s,1,st) == 0);

    /* Bots require a strictly weaker enemy; humans may attack equal/larger. */
    o[0] = 1; o[1] = 0; s[0] = s[1] = 5;
    bot_turn_begin(o,s,1,st);
    assert(bot_turn_next(o,s,1,st) == 0);
    assert(ext_attack_legal(o,s,1,0));

    int old_o[5], old_s[5], flips[320], len, meta[5];
    memcpy(old_o,o,sizeof(o)); memcpy(old_s,s,sizeof(s));
    use_mb32_rng(); set_rng_mb32(19);
    const int invalid[][2] = {{-1,0},{0,5},{0,0},{0,2},{2,3},{3,4}};
    for (int k = 0; k < 6; k++) {
        int from = invalid[k][0], to = invalid[k][1];
        assert(!ext_attack_legal(o,s,from,to));
        ext_resolve_battle(o,s,from,to);
        resolve_battle_logged(o,s,from,to,flips,&len,meta);
        assert(len == 0 && meta[0] == -1 && get_rng_mb32() == 19);
        assert(!memcmp(o,old_o,sizeof(o)) && !memcmp(s,old_s,sizeof(s)));
    }

    /* Simultaneous last casualties leave an owned zero-army defender, which
     * can be captured by the next legal attack without spending any coins. */
    const int pair[][2] = {{0,1}};
    topology(2,pair,1);
    int oz[] = {0,1}, sz[] = {2,0};
    ext_resolve_battle(oz,sz,0,1);
    assert(oz[1] == 0 && sz[0] == 1 && sz[1] == 1 && get_rng_mb32() == 19);
}

static void terminal(void) {
    const int edge[][2] = {{0,24}};
    topology(30,edge,1);
    int o[30], s[30], saved[30];
    for (int i = 0; i < 30; i++) { o[i] = i < 24 ? 0 : 1; s[i] = 2; }
    memcpy(saved,s,sizeof(s));
    assert(check_winner(o) == 0);
    end_turn(o,s);
    assert(!memcmp(saved,s,sizeof(s)));
    o[23] = 1; assert(check_winner(o) == -1);
}

int main(void) {
    openings(); reinforcement(); battles_and_bots(); terminal();
    puts("RULES-GATE: PASS (10,000 openings, reinforcement, attacks, bots, terminal states)");
}
