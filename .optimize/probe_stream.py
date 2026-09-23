import sys, time
import mlx.core as mx

# Raw streaming bandwidth: read a big buffer with different per-thread loads.
w = mx.zeros((64 * 1024 * 1024,), dtype=mx.uint32)  # 256MB
mx.eval(w)

HDR = ""


def mk(name, body):
    return mx.fast.metal_kernel(
        name=name, input_names=["w"], output_names=["o"], source=body)


k_scalar = mk("s_scalar", """
    uint tid = thread_position_in_grid.x;
    uint acc = 0u;
    for (uint i = 0u; i < 64u; ++i) acc += w[tid * 64u + i];
    if (acc == 0xdeadbeefu) o[0] = 1.0f;
""")

k_u4 = mk("s_u4", """
    uint tid = thread_position_in_grid.x;
    const device uint4* w4 = (const device uint4*)w;
    uint acc = 0u;
    for (uint i = 0u; i < 16u; ++i) {
        uint4 v = w4[tid * 16u + i];
        acc += v.x + v.y + v.z + v.w;
    }
    if (acc == 0xdeadbeefu) o[0] = 1.0f;
""")

# strided: thread reads w[tid + i*N] - coalesced across lanes
k_stride = mk("s_stride", """
    uint tid = thread_position_in_grid.x;
    uint n = threads_per_grid.x;
    uint acc = 0u;
    for (uint i = 0u; i < 64u; ++i) acc += w[tid + i * n];
    if (acc == 0xdeadbeefu) o[0] = 1.0f;
""")

k_stride4 = mk("s_stride4", """
    uint tid = thread_position_in_grid.x;
    uint n = threads_per_grid.x;
    const device uint4* w4 = (const device uint4*)w;
    uint acc = 0u;
    for (uint i = 0u; i < 16u; ++i) {
        uint4 v = w4[tid + i * n];
        acc += v.x + v.y + v.z + v.w;
    }
    if (acc == 0xdeadbeefu) o[0] = 1.0f;
""")


def timeit(name, k, nthreads, n=50):
    def fn():
        return k(inputs=[w], grid=(nthreads, 1, 1), threadgroup=(256, 1, 1),
                 output_shapes=[(1,)], output_dtypes=[mx.float32])[0]
    for _ in range(3):
        fn()
    r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    mx.eval(rs)
    dt = (time.perf_counter() - t0) / n
    print(f"{name:28s} {dt*1e6:8.1f} us  -> {256e6/dt/1e9:6.0f} GB/s")


timeit("scalar x64", k_scalar, 1024 * 1024)
timeit("uint4 x16", k_u4, 1024 * 1024)
timeit("strided scalar x64", k_stride, 1024 * 1024)
timeit("strided uint4 x16", k_stride4, 1024 * 1024)
