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


# A: read weights only, write row checksum (no x, no dequant)
kA = mx.fast.metal_kernel(
    name="bA", input_names=["w", "inds"], output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u; uint lane = tid % 32u;
        constexpr uint D = 2048u; constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            const device uint* wu = w + ((ulong)e * 2u * M + i) * WPR;
            uint acc = 0u;
            for (uint t = 0u; t < 4u; ++t) acc += wu[lane * 4u + t];
            acc = simd_sum(acc);
            if (lane == 0u && acc == 0xdeadbeefu) h[e_slot * M + i] = (bfloat16_t)1.0f;
        }
    """,
)
timeit("A: w-read only", kA, [ug.weight, inds], (256, (M//16)*8, 1), (K*M,))

# B: w-read + x dot, NO dequant (treat words as floats via bitcast add)
kB = mx.fast.metal_kernel(
    name="bB", input_names=["x", "w", "inds"], output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u; uint lane = tid % 32u;
        constexpr uint D = 2048u; constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            const device uint* wu = w + ((ulong)e * 2u * M + i) * WPR;
            float acc = 0.0f;
            for (uint t = 0u; t < 4u; ++t) {
                uint widx = lane * 4u + t;
                uint p = wu[widx];
                for (uint c = 0u; c < 16u; ++c)
                    acc += (float)(p & 3u) * (float)x[widx * 16u + c];
            }
            acc = simd_sum(acc);
            if (lane == 0u) h[e_slot * M + i] = (bfloat16_t)acc;
        }
    """,
)
timeit("B: +x dot noextract", kB, [x.reshape(-1), ug.weight, inds],
       (256, (M//16)*8, 1), (K*M,))

# C: same but x in threadgroup mem
kC = mx.fast.metal_kernel(
    name="bC", input_names=["x", "w", "inds"], output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u; uint lane = tid % 32u;
        constexpr uint D = 2048u; constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        threadgroup float xs[D];
        for (uint j = tid; j < D; j += 256u) xs[j] = (float)x[j];
        threadgroup_barrier(mem_flags::mem_threadgroup);
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            const device uint* wu = w + ((ulong)e * 2u * M + i) * WPR;
            float acc = 0.0f;
            for (uint t = 0u; t < 4u; ++t) {
                uint widx = lane * 4u + t;
                uint p = wu[widx];
                for (uint c = 0u; c < 16u; ++c)
                    acc += (float)(p & 3u) * xs[widx * 16u + c];
            }
            acc = simd_sum(acc);
            if (lane == 0u) h[e_slot * M + i] = (bfloat16_t)acc;
        }
    """,
)
timeit("C: tg-x + dot", kC, [x.reshape(-1), ug.weight, inds],
       (256, (M//16)*8, 1), (K*M,))

# D: full dequant (scale/bias) on one row only per sg
kD = mx.fast.metal_kernel(
    name="bD", input_names=["x", "w", "sc", "bi", "inds"], output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u; uint lane = tid % 32u;
        constexpr uint D = 2048u; constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        constexpr uint GPW = 8u; constexpr uint NG = 16u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong row = (ulong)e * 2u * M + i;
            const device uint* wu = w + row * WPR;
            ulong sb = row * NG;
            float acc = 0.0f;
            for (uint t = 0u; t < 4u; ++t) {
                uint widx = lane * 4u + t;
                uint g = widx / GPW;
                float s = (float)sc[sb + g];
                float b = (float)bi[sb + g];
                uint p = wu[widx];
                for (uint c = 0u; c < 16u; ++c)
                    acc += ((float)((p >> (2u*c)) & 3u) * s + b)
                           * (float)x[widx * 16u + c];
            }
            acc = simd_sum(acc);
            if (lane == 0u) h[e_slot * M + i] = (bfloat16_t)acc;
        }
    """,
)
timeit("D: full dequant 1row", kD,
       [x.reshape(-1), ug.weight, ug.scales, ug.biases, inds],
       (256, (M//16)*8, 1), (K*M,))
