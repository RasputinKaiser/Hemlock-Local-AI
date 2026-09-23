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
ug = sw.up_gate_proj

D, M, K = 2048, 512, 8
x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16)
inds = mx.array([3, 17, 42, 77, 100, 150, 201, 255], dtype=mx.int32)
mx.eval(x, inds)
xf = x.reshape(-1)

HDR = """
    inline float2 bf2(uint u) {
        bfloat2 v = as_type<bfloat2>(u);
        return float2((float)v.x, (float)v.y);
    }
    // 16 code extracts + fma into acc, independent shifts
    #define DQ16(P, ACC, XV) { \
        ACC += (float)((P) & 3u) * XV[0]; \
        ACC += (float)(((P) >> 2u) & 3u) * XV[1]; \
        ACC += (float)(((P) >> 4u) & 3u) * XV[2]; \
        ACC += (float)(((P) >> 6u) & 3u) * XV[3]; \
        ACC += (float)(((P) >> 8u) & 3u) * XV[4]; \
        ACC += (float)(((P) >> 10u) & 3u) * XV[5]; \
        ACC += (float)(((P) >> 12u) & 3u) * XV[6]; \
        ACC += (float)(((P) >> 14u) & 3u) * XV[7]; \
        ACC += (float)(((P) >> 16u) & 3u) * XV[8]; \
        ACC += (float)(((P) >> 18u) & 3u) * XV[9]; \
        ACC += (float)(((P) >> 20u) & 3u) * XV[10]; \
        ACC += (float)(((P) >> 22u) & 3u) * XV[11]; \
        ACC += (float)(((P) >> 24u) & 3u) * XV[12]; \
        ACC += (float)(((P) >> 26u) & 3u) * XV[13]; \
        ACC += (float)(((P) >> 28u) & 3u) * XV[14]; \
        ACC += (float)(((P) >> 30u) & 3u) * XV[15]; }
    #define XLOAD(WIDX, XV) { \
        uint4 xa = x4[(WIDX) * 2u]; \
        uint4 xb = x4[(WIDX) * 2u + 1u]; \
        float2 f0 = bf2(xa.x); float2 f1 = bf2(xa.y); \
        float2 f2 = bf2(xa.z); float2 f3 = bf2(xa.w); \
        float2 f4 = bf2(xb.x); float2 f5 = bf2(xb.y); \
        float2 f6 = bf2(xb.z); float2 f7 = bf2(xb.w); \
        XV[0]=f0.x; XV[1]=f0.y; XV[2]=f1.x; XV[3]=f1.y; \
        XV[4]=f2.x; XV[5]=f2.y; XV[6]=f3.x; XV[7]=f3.y; \
        XV[8]=f4.x; XV[9]=f4.y; XV[10]=f5.x; XV[11]=f5.y; \
        XV[12]=f6.x; XV[13]=f6.y; XV[14]=f7.x; XV[15]=f7.y; }
"""

# v5: each sg computes TWO outputs (up_i,gate_i and up_i8,gate_i8); x slice
# loaded once per word position, used by all 4 rows.
k1 = mx.fast.metal_kernel(
    name="v5_upgate",
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
        constexpr uint WPR = D / 16u;   // 128
        constexpr uint NG = D / 128u;   // 16
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        const device uint4* x4 = (const device uint4*)x;
        uint i0 = blk * 16u + sg;
        uint i1 = i0 + 8u;
        ulong r_up0 = (ulong)e * 2u * M + i0;
        ulong r_up1 = (ulong)e * 2u * M + i1;
        const device uint4* w_up0 = (const device uint4*)(w + r_up0 * WPR);
        const device uint4* w_up1 = (const device uint4*)(w + r_up1 * WPR);
        const device uint4* w_g0 = w_up0 + (ulong)M * (WPR / 4u);
        const device uint4* w_g1 = w_up1 + (ulong)M * (WPR / 4u);
        ulong sb_up0 = r_up0 * NG, sb_up1 = r_up1 * NG;
        ulong sb_g0 = sb_up0 + (ulong)M * NG, sb_g1 = sb_up1 + (ulong)M * NG;

        uint g = lane >> 1;
        float su0 = (float)sc[sb_up0 + g], bu0 = (float)bi[sb_up0 + g];
        float su1 = (float)sc[sb_up1 + g], bu1 = (float)bi[sb_up1 + g];
        float sg0 = (float)sc[sb_g0 + g], bg0 = (float)bi[sb_g0 + g];
        float sg1 = (float)sc[sb_g1 + g], bg1 = (float)bi[sb_g1 + g];

        float cu0 = 0.f, cg0 = 0.f, cu1 = 0.f, cg1 = 0.f;
        uint4 pu0 = w_up0[lane], pu1 = w_up1[lane];
        uint4 pg0 = w_g0[lane], pg1 = w_g1[lane];
        uint wu0[4] = {pu0.x, pu0.y, pu0.z, pu0.w};
        uint wu1[4] = {pu1.x, pu1.y, pu1.z, pu1.w};
        uint wg0[4] = {pg0.x, pg0.y, pg0.z, pg0.w};
        uint wg1[4] = {pg1.x, pg1.y, pg1.z, pg1.w};
        for (uint t = 0u; t < 4u; ++t) {
            uint widx = lane * 4u + t;
            float xv[16];
            XLOAD(widx, xv)
            float xs = xv[0]+xv[1]+xv[2]+xv[3]+xv[4]+xv[5]+xv[6]+xv[7]
                     + xv[8]+xv[9]+xv[10]+xv[11]+xv[12]+xv[13]+xv[14]+xv[15];
            float qa = 0.f, qb = 0.f, qc = 0.f, qd = 0.f;
            DQ16(wu0[t], qa, xv)
            DQ16(wg0[t], qb, xv)
            DQ16(wu1[t], qc, xv)
            DQ16(wg1[t], qd, xv)
            cu0 += su0 * qa + bu0 * xs;
            cg0 += sg0 * qb + bg0 * xs;
            cu1 += su1 * qc + bu1 * xs;
            cg1 += sg1 * qd + bg1 * xs;
        }
        float au0 = simd_sum(cu0), ag0 = simd_sum(cg0);
        float au1 = simd_sum(cu1), ag1 = simd_sum(cg1);
        if (lane == 0u) {
            float g0v = metal::min(ag0, 7.0f);
            float u0v = metal::clamp(au0, -7.0f, 7.0f);
            float g1v = metal::min(ag1, 7.0f);
            float u1v = metal::clamp(au1, -7.0f, 7.0f);
            h[e_slot * M + i0] = (bfloat16_t)(g0v / (1.f + metal::exp(-g0v)) * u0v);
            h[e_slot * M + i1] = (bfloat16_t)(g1v / (1.f + metal::exp(-g1v)) * u1v);
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
print("k1v5 maxdiff:", float(mx.abs(h[:M].astype(mx.float32) - h_ref).max()))

timeit("k1 v5", lambda: k1(
    inputs=[xf, ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1), threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16])[0])
