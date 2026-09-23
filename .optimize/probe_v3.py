import sys, time
import mlx.core as mx
import mlx.nn as nn

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.utils import load

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True},
    trust_remote_code=True,
)
sw = model.model.layers[0].mlp.switch_mlp
ug, dn = sw.up_gate_proj, sw.down_proj

D, M, K, gs = 2048, 512, 8, 128
x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16)
h_in = mx.random.normal((8, 512), dtype=mx.bfloat16)
inds = mx.array([3, 17, 42, 77, 100, 150, 201, 255], dtype=mx.int32)
scores = mx.array([0.2, 0.15, 0.1, 0.15, 0.1, 0.1, 0.1, 0.1], dtype=mx.float32)
mx.eval(x, h_in, inds, scores)
xf = x.reshape(-1)

# ---------------- kernel 1 v3 ----------------
k1 = mx.fast.metal_kernel(
    name="v3_upgate",
    input_names=["x", "w", "sc", "bi", "inds"],
    output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u;
        uint lane = tid % 32u;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;   // 128
        constexpr uint NG = D / 128u;   // 16
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];

        // transposed x staging: element of lane l at local index j -> bank l
        threadgroup float xs[64 * 32];
        threadgroup float xg[NG];
        for (uint idx = tid; idx < D; idx += 256u) {
            uint l = idx / 64u;
            uint j = idx % 64u;
            xs[j * 32u + l] = (float)x[idx];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (tid < NG) {
            // group g = lanes 2g,2g+1 all j
            float s = 0.0f;
            for (uint j = 0u; j < 64u; ++j)
                s += xs[j * 32u + 2u * tid] + xs[j * 32u + 2u * tid + 1u];
            xg[tid] = s;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);

        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint4* wu = (const device uint4*)(w + up_row * WPR);
            const device uint4* wg = (const device uint4*)(w + (up_row + M) * WPR);
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            uint4 pu = wu[lane];   // words lane*4..lane*4+3
            uint4 pg = wg[lane];
            float qu = 0.0f, qg = 0.0f;
            {
                uint pw = pu.x, gw = pg.x;
                const threadgroup float* xe = xs + lane;
                for (uint c = 0u; c < 16u; ++c) {
                    float xv = xe[(0u * 16u + c) * 32u];
                    qu += (float)(pw & 3u) * xv; pw >>= 2u;
                    qg += (float)(gw & 3u) * xv; gw >>= 2u;
                }
            }
            {
                uint pw = pu.y, gw = pg.y;
                const threadgroup float* xe = xs + lane;
                for (uint c = 0u; c < 16u; ++c) {
                    float xv = xe[(1u * 16u + c) * 32u];
                    qu += (float)(pw & 3u) * xv; pw >>= 2u;
                    qg += (float)(gw & 3u) * xv; gw >>= 2u;
                }
            }
            {
                uint pw = pu.z, gw = pg.z;
                const threadgroup float* xe = xs + lane;
                for (uint c = 0u; c < 16u; ++c) {
                    float xv = xe[(2u * 16u + c) * 32u];
                    qu += (float)(pw & 3u) * xv; pw >>= 2u;
                    qg += (float)(gw & 3u) * xv; gw >>= 2u;
                }
            }
            {
                uint pw = pu.w, gw = pg.w;
                const threadgroup float* xe = xs + lane;
                for (uint c = 0u; c < 16u; ++c) {
                    float xv = xe[(3u * 16u + c) * 32u];
                    qu += (float)(pw & 3u) * xv; pw >>= 2u;
                    qg += (float)(gw & 3u) * xv; gw >>= 2u;
                }
            }
            qu += simd_shuffle_down(qu, 1u);
            qg += simd_shuffle_down(qg, 1u);
            float cu = 0.0f, cg = 0.0f;
            if ((lane & 1u) == 0u) {
                uint g = lane >> 1;
                cu = qu * (float)sc[sbu + g] + (float)bi[sbu + g] * xg[g];
                cg = qg * (float)sc[sbg + g] + (float)bi[sbg + g] * xg[g];
            }
            float accu = simd_sum(cu);
            float accg = simd_sum(cg);
            if (lane == 0u) {
                float gv = metal::min(accg, 7.0f);
                float uv = metal::clamp(accu, -7.0f, 7.0f);
                h[e_slot * M + i] = (bfloat16_t)(gv / (1.0f + metal::exp(-gv)) * uv);
            }
        }
    """,
)

# ---------------- kernel 2 v3 ----------------
k2 = mx.fast.metal_kernel(
    name="v3_down",
    input_names=["h", "w", "sc", "bi", "inds", "scores"],
    output_names=["out"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u;   // expert slot
        uint lane = tid % 32u;
        constexpr uint K = 8u;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = M / 16u;   // 32
        constexpr uint NG = M / 128u;   // 4
        constexpr uint ROWS = 8u;
        uint j0 = tgid * ROWS;
        uint e = (uint)inds[sg];

        // transposed h staging: h[sg][lane*16+j] -> ht[sg][j*32+lane]
        threadgroup float ht[K * 512];
        threadgroup float hg[K * NG];
        for (uint idx = tid; idx < K * 512u; idx += 256u) {
            uint e2 = idx / 512u;
            uint r = idx % 512u;
            uint l = r / 16u;
            uint j = r % 16u;
            ht[e2 * 512u + j * 32u + l] = (float)h[idx];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (tid < K * NG) {
            uint e2 = tid / NG;
            uint g = tid % NG;
            float s = 0.0f;
            for (uint l = 0u; l < 8u; ++l)
                for (uint j = 0u; j < 16u; ++j)
                    s += ht[e2 * 512u + j * 32u + g * 8u + l];
            hg[tid] = s;
        }
        threadgroup float pe[ROWS][K];
        threadgroup_barrier(mem_flags::mem_threadgroup);

        for (uint r = 0u; r < ROWS; ++r) {
            uint j = j0 + r;
            ulong row = (ulong)e * D + j;
            uint p = w[row * WPR + lane];   // lane = word index
            ulong sb = row * NG;
            float ql = 0.0f;
            const threadgroup float* he = ht + sg * 512u + lane;
            for (uint c = 0u; c < 16u; ++c) {
                ql += (float)(p & 3u) * he[c * 32u];
                p >>= 2u;
            }
            // octet reduction (group = lane/8)
            ql += simd_shuffle_down(ql, 4u);
            ql += simd_shuffle_down(ql, 2u);
            ql += simd_shuffle_down(ql, 1u);
            float contrib = 0.0f;
            if ((lane & 7u) == 0u) {
                uint g = lane >> 3;
                contrib = ql * (float)sc[sb + g] + (float)bi[sb + g] * hg[sg * NG + g];
            }
            float acc = simd_sum(contrib);
            if (lane == 0u) pe[r][sg] = acc;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (tid < ROWS) {
            float o = 0.0f;
            for (uint kk = 0u; kk < K; ++kk) o += pe[tid][kk] * scores[kk];
            out[j0 + tid] = (bfloat16_t)o;
        }
    """,
)


def timeit(name, fn, n=300):
    for _ in range(5):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    t1 = time.perf_counter()
    mx.eval(rs)
    t2 = time.perf_counter()
    print(f"{name:30s} build {(t1-t0)/n*1e6:7.1f} eval {(t2-t1)/n*1e6:8.1f} us")


h = k1(inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
       grid=(256, (M // 16) * 8, 1), threadgroup=(256, 1, 1),
       output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16])[0]

# correctness of k1
e = int(inds[0])
wdeq = mx.dequantize(ug.weight[e], ug.scales[e], ug.biases[e],
                     group_size=128, bits=2).astype(mx.float32)
xdot = wdeq @ x.reshape(-1).astype(mx.float32)
h_ref = nn.silu(mx.minimum(xdot[M:], 7.0)) * mx.clip(xdot[:M], -7.0, 7.0)
mx.eval(h, h_ref)
print("k1 maxdiff:", float(mx.abs(h[:M].astype(mx.float32) - h_ref).max()))

out = k2(inputs=[h, dn.weight, dn.scales, dn.biases, inds, scores],
         grid=(256, D // 8, 1), threadgroup=(256, 1, 1),
         output_shapes=[(D,)], output_dtypes=[mx.bfloat16])[0]

# correctness of k2: reference = sum_e scores[e] * deq(w_e) @ h_e
acc = mx.zeros((D,), dtype=mx.float32)
for s_i in range(8):
    e = int(inds[s_i])
    wdeq = mx.dequantize(dn.weight[e], dn.scales[e], dn.biases[e],
                         group_size=128, bits=2).astype(mx.float32)
    acc = acc + scores[s_i] * (wdeq @ h[s_i * M:(s_i + 1) * M].astype(mx.float32))
mx.eval(out, acc)
print("k2 maxdiff:", float(mx.abs(out.astype(mx.float32) - acc).max()))

timeit("k1 v3", lambda: k1(
    inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1), threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16])[0])
timeit("k2 v3", lambda: k2(
    inputs=[h, dn.weight, dn.scales, dn.biases, inds, scores],
    grid=(256, D // 8, 1), threadgroup=(256, 1, 1),
    output_shapes=[(D,)], output_dtypes=[mx.bfloat16])[0])
