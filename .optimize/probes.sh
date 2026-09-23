# label | repetitions | command
# Maple speed probes run against a dedicated server on 127.0.0.1:8081.
maple-decode-tps | 3 | python3 dream-chat/scripts/maple_bench.py --url http://127.0.0.1:8081 --mode decode
maple-prefill-ttft | 3 | python3 dream-chat/scripts/maple_bench.py --url http://127.0.0.1:8081 --mode prefill
