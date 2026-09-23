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

D, M, K = 2048, 512, 8
x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16)
h_in = mx.random.normal((8, 512), dtype=mx.bfloat16)
inds = mx.array([3, 17, 42, 77, 100, 150, 201, 255], dtype=mx.int32)
scores = mx.array([0.2, 0.15, 0.1, 0.15, 0.1, 0.1, 0.1, 0.1], dtype=mx.float32)
mx.eval(x, h_in, inds, scores)
xf = x.reshape(-1)

# k1 v4: word-local affine (no tg mem, no barriers), uint4 x loads
k1 = mx.fast.metal_kernel(
    name="v4_upgate",
    input_names=["x", "w", "sc", "bi", "inds"],
    output_names=["h"],
    header="""
        inline float2 bf2(uint u) {
            bfloat2 v = as_type<bfloat2>(u);
            return float2((float)v.x, (float)v.y);
        }
    """,
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
        const device uint4* x4 = (const device uint4*)x;

        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint4* wu = (const device uint4*)(w + up_row * WPR);
            const device uint4* wg = (const device uint4*)(w + (up_row + M) * WPR);
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            float cu = 0.0f, cg = 0.0f;
            // lane covers words lane*4..lane*4+3 -> group lane/2
            {
                uint g = lane >> 1;
                float s_u = (float)sc[sbu + g];
                float b_u = (float)bi[sbu + g];
                float s_g = (float)sc[sbg + g];
                float b_g = (float)bi[sbg + g];
                uint4 pu = wu[lane];
                uint4 pg = wg[lane];
                uint pwu[4] = {pu.x, pu.y, pu.z, pu.w};
                uint pwg[4] = {pg.x, pg.y, pg.z, pg.w};
                for (uint t = 0u; t < 4u; ++t) {
                    uint widx = lane * 4u + t;
                    uint4 xa = x4[widx * 2u];
                    uint4 xb = x4[widx * 2u + 1u];
                    float xv[16];
                    xv[0] = bf2(xa.x).x;  xv[1] = bf2(xa.x).y;
                    xv[2] = bf2(xa.y).x;  xv[3] = bf2(xa.y).y;
                    xv[4] = bf2(xa.z).x;  xv[5] = bf2(xa.z).y;
                    xv[6] = bf2(xa.w).x;  xv[7] = bf2(xa.w).y;
                    xv[8] = bf2(xb.x).x;  xv[9] = bf2(xb.x).y;
                    xv[10] = bf2(xb.y).x; xv[11] = bf2(xb.y).y;
                    xv[12] = bf2(xb.z).x; xv[13] = bf2(xb.z).y;
                    xv[14] = bf2(xb.w).x; xv[15] = bf2(xb.w).y;
                    float qu = 0.0f, qg = 0.0f, xs = 0.0f;
                    uint pu2 = pwu[t];
                    uint pg2 = pwg[t];
                    for (uint c = 0u; c < 16u; ++c) {
                        xs += xv[c];
                        qu += (float)(pu2 & 3u) * xv[c]; pu2 >>= 2u;
                        qg += (float)(pg2 & 3u) * xv[c]; pg2 >>= 2u;
                    }
                    cu += s_u * qu + b_u * xs;
                    cg += s_g * qg + b_g * xs;
                }
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

e = int(inds[0])
wdeq = mx.dequantize(ug.weight[e], ug.scales[e], ug.biases[e],
                     group_size=128, bits=2).astype(mx.float32)
xdot = wdeq @ x.reshape(-1).astype(mx.float32)
h_ref = nn.silu(mx.minimum(xdot[M:], 7.0)) * mx.clip(xdot[:M], -7.0, 7.0)
mx.eval(h, h_ref)
print("k1v4 maxdiff:", float(mx.abs(h[:M].astype(mx.float32) - h_ref).max()))

timeit("k1 v4", lambda: k1(
    inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1), threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16])[0])

# k2 v4: same trick, no tg staging
k2 = mx.fast.metal_kernel(
    name="v4_down",
    input_names=["h", "w", "sc", "bi", "inds", "scores"],
    output_names=["out"],
    header="""
        inline float2 bf2(uint u) {
            bfloat2 v = as_type<bfloat2>(u);
            return float2((float)v.x, (float)v.y);
        }
    """,
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
        const device uint4* h4 = (const device uint4*)(h + sg * M);
        threadgroup float pe[ROWS][K];
        for (uint r = 0u; r < ROWS; ++r) {
            uint j = j0 + r;
            ulong row = (ulong)e * D + j;
            uint p = w[row * WPR + lane];
            ulong sb = row * NG;
            // lane's word = elements lane*16..+15 -> h4[lane*2, lane*2+1]
            uint4 ha = h4[lane * 2u];
            uint4 hb = h4[lane * 2u + 1u];
            float hv[16];
            hv[0] = bf2(ha.x).x;  hv[1] = bf2(ha.x).y;
            hv[2] = bf2(ha.y).x;  hv[3] = bf2(ha.y).y;
            hv[4] = bf2(ha.z).x;  hv[5] = bf2(ha.z).y;
            hv[6] = bf2(ha.w).x;  hv[7] = bf2(ha.w).y;
            hv[8] = bf2(hb.x).x;  hv[9] = bf2(hb.x).y;
            hv[10] = bf2(hb.y).x; hv[11] = bf2(hb.y).y;
            hv[12] = bf2(hb.z).x; hv[13] = bf2(hb.z).y;
            hv[14] = bf2(hb.w).x; hv[15] = bf2(hb.w).y;
            float ql = 0.0f, hs = 0.0f;
            for (uint c = 0u; c < 16u; ++c) {
                hs += hv[c];
                ql += (float)(p & 3u) * hv[c]; p >>= 2u;
            }
            // per-lane affine: lane's word sits wholly in group lane/8
            uint g = lane >> 3;
            float contrib = ql * (float)sc[sb + g] + hs * (float)bi[sb + g];
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

h2 = h_in
out = k2(inputs=[h2, dn.weight, dn.scales, dn.biases, inds, scores],
         grid=(256, D // 8, 1), threadgroup=(256, 1, 1),
         output_shapes=[(D,)], output_dtypes=[mx.bfloat16])[0]
acc = mx.zeros((D,), dtype=mx.float32)
for s_i in range(8):
    e = int(inds[s_i])
    wdeq = mx.dequantize(dn.weight[e], dn.scales[e], dn.biases[e],
                         group_size=128, bits=2).astype(mx.float32)
    acc = acc + scores[s_i] * (wdeq @ h2[s_i].astype(mx.float32))
mx.eval(out, acc)
print("k2v4 maxdiff:", float(mx.abs(out.astype(mx.float32) - acc).max()))

timeit("k2 v4", lambda: k2(
    inputs=[h2, dn.weight, dn.scales, dn.biases, inds, scores],
    grid=(256, D // 8, 1), threadgroup=(256, 1, 1),
    output_shapes=[(D,)], output_dtypes=[mx.bfloat16])[0])
