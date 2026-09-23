import sys, time
import mlx.core as mx

sys.path.insert(0, "/Users/ianzvirbulis/Code/Hemlock")

# Does metal_kernel copy big inputs? Kernel that reads only w[0].
k = mx.fast.metal_kernel(
    name="probe_one",
    input_names=["w"],
    output_names=["out"],
    source="""
        uint tid = thread_position_in_grid.x;
        if (tid == 0u) out[0] = (float)w[0];
    """,
)

w_small = mx.zeros((1024,), dtype=mx.uint32)
w_big = mx.zeros((256, 1024, 128), dtype=mx.uint32)  # 128MB, contiguous
mx.eval(w_small, w_big)

# and a non-contiguous big view
w_big_nc = mx.zeros((512, 1024, 128), dtype=mx.uint32)[::2]
mx.eval(w_big_nc)


def timeit(name, w, n=100):
    def fn():
        return k(inputs=[w], grid=(32, 1, 1), threadgroup=(32, 1, 1),
                 output_shapes=[(1,)], output_dtypes=[mx.float32])[0]
    for _ in range(5):
        r = fn()
    mx.eval(r)
    t0 = time.perf_counter()
    rs = [fn() for _ in range(n)]
    t1 = time.perf_counter()
    mx.eval(rs)
    t2 = time.perf_counter()
    print(f"{name:24s} build {(t1-t0)/n*1e6:7.1f} us  eval {(t2-t1)/n*1e6:9.1f} us")


timeit("small (4KB)", w_small)
timeit("big contiguous (128MB)", w_big)
timeit("big noncontig view", w_big_nc)
