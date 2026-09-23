import sys, time
import mlx.core as mx

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")
from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache

model, tokenizer = load(
    "/Users/ianzvirbulis/Models/Hemlock/maple-2bit-mlx",
    tokenizer_config={"trust_remote_code": True},
    model_config={"use_flash_head": True},
    trust_remote_code=True,
)
inner = model.model
sw = inner.layers[0].mlp.switch_mlp
ug, dn = sw.up_gate_proj, sw.down_proj
print("ug.weight", ug.weight.shape, ug.weight.dtype, "contig")

D, M, K, gs = 2048, 512, 8, 128

# Kernel A: pure weight-streaming read — one tg per expert-row-block,
# lanes stride words, accumulate raw packed ints. Upper bound on speed.
kread = mx.fast.metal_kernel(
    name="probe_rd",
    input_names=["w", "inds"],
    output_names=["out"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        // each tg covers 32 rows of one expert
        uint e = (uint)inds[tgid / (M / 32u)];
        uint row0 = (tgid % (M / 32u)) * 32u;
        const device uint* base = w + ((ulong)e * 2u * M + row0) * WPR;
        uint acc = 0u;
        for (uint r = 0u; r < 32u; ++r) {
            for (uint widx = tid; widx < WPR; widx += 256u)
                acc += base[r * WPR + widx];
        }
        if (acc == 0xdeadbeefu) out[0] = 1.0f;
    """,
)

x = mx.random.normal((1, 1, 2048), dtype=mx.bfloat16)
inds = mx.arange(8, dtype=mx.int32)
mx.eval(x, inds)


def timeit(name, fn, n=300):
    for _ in range(5):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    t1 = time.perf_counter()
    mx.eval(rs)
    t2 = time.perf_counter()
    gb = 8 * M * D * 2 / 8  # 8 experts x M rows x D elems x 2bit
    print(f"{name:30s} build {(t1-t0)/n*1e6:7.1f} eval {(t2-t1)/n*1e6:8.1f} us  -> {gb/(t2-t1)/n/1e3:.0f} GB/s eff")


timeit("read 8ex x 512rows(up)", lambda: kread(
    inputs=[ug.weight, inds],
    grid=(256, (M // 32) * 8, 1),
    threadgroup=(256, 1, 1),
    output_shapes=[(1,)], output_dtypes=[mx.float32],
)[0])

# Kernel B: same but dequant + x dot (no tg staging) — x read from device
kdeq = mx.fast.metal_kernel(
    name="probe_deq",
    input_names=["x", "w", "sc", "bi", "inds"],
    output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u;
        uint lane = tid % 32u;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        constexpr uint WPL = WPR / 32u;
        constexpr uint GPW = 128u / 16u;
        constexpr uint NG = D / 128u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint* wu = w + up_row * WPR;
            const device uint* wg = wu + (ulong)M * WPR;
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            float accu = 0.0f, accg = 0.0f;
            for (uint t = 0u; t < WPL; ++t) {
                uint widx = lane * WPL + t;
                uint g = widx / GPW;
                float s_u = (float)sc[sbu + g];
                float b_u = (float)bi[sbu + g];
                float s_g = (float)sc[sbg + g];
                float b_g = (float)bi[sbg + g];
                uint pu = wu[widx];
                uint pg = wg[widx];
                for (uint c = 0u; c < 16u; ++c) {
                    float xu = (float)x[widx * 16u + c];
                    accu += ((float)((pu >> (2u * c)) & 3u) * s_u + b_u) * xu;
                    accg += ((float)((pg >> (2u * c)) & 3u) * s_g + b_g) * xu;
                }
            }
            accu = simd_sum(accu);
            accg = simd_sum(accg);
            if (lane == 0u) {
                float gv = metal::min(accg, 7.0f);
                float uv = metal::clamp(accu, -7.0f, 7.0f);
                h[e_slot * M + i] = (bfloat16_t)(gv / (1.0f + metal::exp(-gv)) * uv);
            }
        }
    """,
)
timeit("deq gemv no-tgx", lambda: kdeq(
    inputs=[x.reshape(-1), ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1),
    threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16],
)[0])

# Kernel C: tg staging but VECTOR loads (uint4 = 4 words per load)
kvec = mx.fast.metal_kernel(
    name="probe_vec",
    input_names=["x", "w", "sc", "bi", "inds"],
    output_names=["h"],
    source="""
        uint tid = thread_position_in_threadgroup.x;
        uint tgid = threadgroup_position_in_grid.y;
        uint sg = tid / 32u;
        uint lane = tid % 32u;
        constexpr uint D = 2048u;
        constexpr uint M = 512u;
        constexpr uint WPR = D / 16u;
        constexpr uint GPW = 128u / 16u;
        constexpr uint NG = D / 128u;
        uint e_slot = tgid / (M / 16u);
        uint blk = tgid % (M / 16u);
        uint e = (uint)inds[e_slot];
        for (uint o = 0u; o < 2u; ++o) {
            uint i = blk * 16u + o * 8u + sg;
            ulong up_row = (ulong)e * 2u * M + i;
            const device uint4* wu = (const device uint4*)(w + up_row * WPR);
            const device uint4* wg = (const device uint4*)(w + (up_row + M) * WPR);
            ulong sbu = up_row * NG;
            ulong sbg = sbu + (ulong)M * NG;
            float accu = 0.0f, accg = 0.0f;
            // 128 words/row, uint4 -> 32 vec words, one per lane
            {
                uint g = (lane * 4u) / GPW;
                float s_u = (float)sc[sbu + g];
                float b_u = (float)bi[sbu + g];
                float s_g = (float)sc[sbg + g];
                float b_g = (float)bi[sbg + g];
                uint4 pu = wu[lane];
                uint4 pg = wg[lane];
                uint pua[4] = {pu.x, pu.y, pu.z, pu.w};
                uint pga[4] = {pg.x, pg.y, pg.z, pg.w};
                for (uint t = 0u; t < 4u; ++t) {
                    uint widx = lane * 4u + t;
                    for (uint c = 0u; c < 16u; ++c) {
                        float xu = (float)x[widx * 16u + c];
                        accu += ((float)((pua[t] >> (2u * c)) & 3u) * s_u + b_u) * xu;
                        accg += ((float)((pga[t] >> (2u * c)) & 3u) * s_g + b_g) * xu;
                    }
                }
            }
            accu = simd_sum(accu);
            accg = simd_sum(accg);
            if (lane == 0u) {
                float gv = metal::min(accg, 7.0f);
                float uv = metal::clamp(accu, -7.0f, 7.0f);
                h[e_slot * M + i] = (bfloat16_t)(gv / (1.0f + metal::exp(-gv)) * uv);
            }
        }
    """,
)
timeit("deq gemv uint4", lambda: kvec(
    inputs=[x.reshape(-1), ug.weight, ug.scales, ug.biases, inds],
    grid=(256, (M // 16) * 8, 1),
    threadgroup=(256, 1, 1),
    output_shapes=[(K * M,)], output_dtypes=[mx.bfloat16],
)[0])
