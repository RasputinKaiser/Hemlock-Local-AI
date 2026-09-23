import sys, time
import mlx.core as mx

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
inds = mx.arange(8, dtype=mx.int32)
mx.eval(x, inds)
xf = x.reshape(-1)

# check bf16 unpack: bfloat2 type exists?
ktest = mx.fast.metal_kernel(
    name="t_bf2", input_names=["x"], output_names=["o"],
    source="""
        uint tid = thread_position_in_grid.x;
        uint u = ((const constant uint*)x)[tid];
        bfloat2 v = as_type<bfloat2>(u);
        o[tid * 2u] = (float)v.x;
        o[tid * 2u + 1u] = (float)v.y;
    """,
)
xx = mx.array([1.0, 2.0, 3.0, 4.0], dtype=mx.bfloat16)
o = ktest(inputs=[xx], grid=(2,1,1), threadgroup=(2,1,1),
          output_shapes=[(4,)], output_dtypes=[mx.float32])[0]
mx.eval(o)
print("bfloat2 unpack:", o.tolist())


def timeit(name, k, inputs, grid, outshape, n=300):
    def fn():
        return k(inputs=inputs, grid=grid, threadgroup=(256, 1, 1),
                 output_shapes=[outshape], output_dtypes=[mx.bfloat16])[0]
    for _ in range(5):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    t1 = time.perf_counter()
    mx.eval(rs)
    t2 = time.perf_counter()
    print(f"{name:34s} build {(t1-t0)/n*1e6:7.1f} eval {(t2-t1)/n*1e6:8.1f} us")


# E1: full up+gate rows, uint4 x loads (bfloat2 unpack), per-lane group refactor
kE1 = mx.fast.metal_kernel(
    name="bE1", input_names=["x", "w", "sc", "bi", "inds"], output_names=["h"],
    header="""
        inline float2 bf2(uint u) {
            bfloat2 v = as_type<bfloat2>(u);
            return float2((float)v.x, (float)v.y);
        }
    """,
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u; uint lane = tid % 32u;
        constexpr uint D = 2048u; constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        constexpr uint NG = D / 128u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        const device uint4* x4 = (const device uint4*)x;
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint* wu = w + up_row * WPR;
            const device uint* wg = wu + (ulong)M * WPR;
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            float qu = 0.0f, qg = 0.0f;
            uint widx = lane * 4u;
            for (uint t = 0u; t < 4u; ++t) {
                uint4 xa = x4[(widx + t) * 2u];
                uint4 xb = x4[(widx + t) * 2u + 1u];
                float2 f0 = bf2(xa.x), f1 = bf2(xa.y), f2 = bf2(xa.z), f3 = bf2(xa.w);
                float2 f4 = bf2(xb.x), f5 = bf2(xb.y), f6 = bf2(xb.z), f7 = bf2(xb.w);
                uint pu = wu[widx + t];
                uint pg = wg[widx + t];
                qu += (float)(pu & 3u) * f0.x; qu += (float)((pu >> 2u) & 3u) * f0.y;
                qu += (float)((pu >> 4u) & 3u) * f1.x; qu += (float)((pu >> 6u) & 3u) * f1.y;
                qu += (float)((pu >> 8u) & 3u) * f2.x; qu += (float)((pu >> 10u) & 3u) * f2.y;
                qu += (float)((pu >> 12u) & 3u) * f3.x; qu += (float)((pu >> 14u) & 3u) * f3.y;
                qu += (float)((pu >> 16u) & 3u) * f4.x; qu += (float)((pu >> 18u) & 3u) * f4.y;
                qu += (float)((pu >> 20u) & 3u) * f5.x; qu += (float)((pu >> 22u) & 3u) * f5.y;
                qu += (float)((pu >> 24u) & 3u) * f6.x; qu += (float)((pu >> 26u) & 3u) * f6.y;
                qu += (float)((pu >> 28u) & 3u) * f7.x; qu += (float)((pu >> 30u) & 3u) * f7.y;
                qg += (float)(pg & 3u) * f0.x; qg += (float)((pg >> 2u) & 3u) * f0.y;
                qg += (float)((pg >> 4u) & 3u) * f1.x; qg += (float)((pg >> 6u) & 3u) * f1.y;
                qg += (float)((pg >> 8u) & 3u) * f2.x; qg += (float)((pg >> 10u) & 3u) * f2.y;
                qg += (float)((pg >> 12u) & 3u) * f3.x; qg += (float)((pg >> 14u) & 3u) * f3.y;
                qg += (float)((pg >> 16u) & 3u) * f4.x; qg += (float)((pg >> 18u) & 3u) * f4.y;
                qg += (float)((pg >> 20u) & 3u) * f5.x; qg += (float)((pg >> 22u) & 3u) * f5.y;
                qg += (float)((pg >> 24u) & 3u) * f6.x; qg += (float)((pg >> 26u) & 3u) * f6.y;
                qg += (float)((pg >> 28u) & 3u) * f7.x; qg += (float)((pg >> 30u) & 3u) * f7.y;
            }
            qu += simd_shuffle_down(qu, 1u);
            qg += simd_shuffle_down(qg, 1u);
            float cu = 0.0f, cg = 0.0f;
            // group = lane/2 needs per-group x sums; approximate via full dot
            // (we fold bias by precomputed group sums is complex; keep per-group
            //  scale on the q-sum and a second pass for bias)
            if ((lane & 1u) == 0u) {
                uint g = lane >> 1;
                // bias needs sum(x in group) -- compute via reduction instead:
                cu = qu * (float)sc[sbu + g];
                cg = qg * (float)sc[sbg + g];
            }
            float accu = simd_sum(cu);
            float accg = simd_sum(cg);
            if (lane == 0u) {
                h[e_slot * M + i] = (bfloat16_t)(accu + accg);
            }
        }
    """,
)
# NOTE: E1 intentionally drops bias term (test-only) -- speed probe only
timeit("E1: uint4x + groupsum(noB)", kE1,
       [xf, ug.weight, ug.scales, ug.biases, inds],
       (256, (M//16)*8, 1), (K*M,))
