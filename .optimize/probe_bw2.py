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
inner = model.model
sw = inner.layers[0].mlp.switch_mlp
ug, dn = sw.up_gate_proj, sw.down_proj

D, M, K, gs = 2048, 512, 8, 128
x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16)
inds = mx.arange(8, dtype=mx.int32)
mx.eval(x, inds)
xf = x.reshape(-1)

HDR = """
#define DQ16(P, ACC, X0, X1, X2, X3) { \
    ACC += (float)((P) & 3u) * (X0).x; \
    ACC += (float)(((P) >> 2u) & 3u) * (X0).y; \
    ACC += (float)(((P) >> 4u) & 3u) * (X0).z; \
    ACC += (float)(((P) >> 6u) & 3u) * (X0).w; \
    ACC += (float)(((P) >> 8u) & 3u) * (X1).x; \
    ACC += (float)(((P) >> 10u) & 3u) * (X1).y; \
    ACC += (float)(((P) >> 12u) & 3u) * (X1).z; \
    ACC += (float)(((P) >> 14u) & 3u) * (X1).w; \
    ACC += (float)(((P) >> 16u) & 3u) * (X2).x; \
    ACC += (float)(((P) >> 18u) & 3u) * (X2).y; \
    ACC += (float)(((P) >> 20u) & 3u) * (X2).z; \
    ACC += (float)(((P) >> 22u) & 3u) * (X2).w; \
    ACC += (float)(((P) >> 24u) & 3u) * (X3).x; \
    ACC += (float)(((P) >> 26u) & 3u) * (X3).y; \
    ACC += (float)(((P) >> 28u) & 3u) * (X3).z; \
    ACC += (float)(((P) >> 30u) & 3u) * (X3).w; }
"""

k2 = mx.fast.metal_kernel(
    name="probe_v2",
    input_names=["x", "w", "sc", "bi", "inds"],
    output_names=["h"],
    header=HDR,
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u;
        uint lane = tid % 32u;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        constexpr uint NG = D / 128u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];

        threadgroup float xs[D];
        threadgroup float xg[NG];
        for (uint j = tid; j < D; j += 256u) xs[j] = (float)x[j];
        threadgroup_barrier(mem_flags::mem_threadgroup);
        if (tid < NG) {
            float s = 0.0f;
            for (uint j = 0u; j < 128u; ++j) s += xs[tid * 128u + j];
            xg[tid] = s;
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
        const threadgroup float4* xs4 = (const threadgroup float4*)xs;

        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint* wu = w + up_row * WPR;
            const device uint* wg = wu + (ulong)M * WPR;
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            float qu = 0.0f, qg = 0.0f;
            uint widx = lane * 4u;
            {
                float4 x0 = xs4[widx * 4u];
                float4 x1 = xs4[widx * 4u + 1u];
                float4 x2 = xs4[widx * 4u + 2u];
                float4 x3 = xs4[widx * 4u + 3u];
                uint pu = wu[widx];
                uint pg = wg[widx];
                DQ16(pu, qu, x0, x1, x2, x3)
                DQ16(pg, qg, x0, x1, x2, x3)
            }
            {
                float4 x0 = xs4[(widx + 1u) * 4u];
                float4 x1 = xs4[(widx + 1u) * 4u + 1u];
                float4 x2 = xs4[(widx + 1u) * 4u + 2u];
                float4 x3 = xs4[(widx + 1u) * 4u + 3u];
                uint pu = wu[widx + 1u];
                uint pg = wg[widx + 1u];
                DQ16(pu, qu, x0, x1, x2, x3)
                DQ16(pg, qg, x0, x1, x2, x3)
            }
            {
                float4 x0 = xs4[(widx + 2u) * 4u];
                float4 x1 = xs4[(widx + 2u) * 4u + 1u];
                float4 x2 = xs4[(widx + 2u) * 4u + 2u];
                float4 x3 = xs4[(widx + 2u) * 4u + 3u];
                uint pu = wu[widx + 2u];
                uint pg = wg[widx + 2u];
                DQ16(pu, qu, x0, x1, x2, x3)
                DQ16(pg, qg, x0, x1, x2, x3)
            }
            {
                float4 x0 = xs4[(widx + 3u) * 4u];
                float4 x1 = xs4[(widx + 3u) * 4u + 1u];
                float4 x2 = xs4[(widx + 3u) * 4u + 2u];
                float4 x3 = xs4[(widx + 3u) * 4u + 3u];
                uint pu = wu[widx + 3u];
                uint pg = wg[widx + 3u];
                DQ16(pu, qu, x0, x1, x2, x3)
                DQ16(pg, qg, x0, x1, x2, x3)
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


h = k2(
    inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1),
    threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16],
)[0]
w = ug.weight; sc = ug.scales; bi = ug.biases
e = int(inds[0])
wdeq = mx.dequantize(w[e], sc[e], bi[e], group_size=128, bits=2).astype(mx.float32)
xdot = wdeq @ x.reshape(-1).astype(mx.float32)
up = xdot[:M]; gate = xdot[M:]
h_ref = nn.silu(mx.minimum(gate, 7.0)) * mx.clip(up, -7.0, 7.0)
mx.eval(h, h_ref)
print("v2 maxdiff:", float(mx.abs(h[:M].astype(mx.float32) - h_ref).max()))

timeit("v2 grouped+vec", lambda: k2(
    inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1),
    threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16],
)[0])
