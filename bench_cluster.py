"""분산 처리 측정: 지금 연결된 기기들에 같은 작업을 맡기고 시간·분담을 저장한다.

    py bench_cluster.py --label 폰만
    py bench_cluster.py --label 노트북+폰 --docs 200000
결과는 results/cluster-<label>.json 에 저장된다.
"""

import argparse
import json
import random
import time
from pathlib import Path

from sparenode_client import nodes, run_job

ap = argparse.ArgumentParser()
ap.add_argument("--label", required=True)
ap.add_argument("--docs", type=int, default=2_000_000)
ap.add_argument("--per-chunk", type=int, default=20_000)
ap.add_argument("--tokens", type=int, default=512)
a = ap.parse_args()

here = Path(__file__).parent
rnd = random.Random(0)
keys = [rnd.randrange(-2**31, 2**31) for _ in range(30)]
inputs = [{"seed": i, "docs": a.per_chunk, "tokens": a.tokens, "keys": keys, "ngram": 5}
          for i in range(a.docs // a.per_chunk)]
code = (here / "tasks" / "synthid_seeded.js").read_text(encoding="utf-8")

who = nodes()
t0 = time.time()
out = run_job(code, inputs, name=f"SynthID {a.label}")
dt = time.time() - t0
by_node = {}
after = {n["id"]: n for n in nodes()}
result = {
    "label": a.label,
    "docs": a.docs,
    "tokens_per_doc": a.tokens,
    "chunks": len(inputs),
    "seconds": round(dt, 3),
    "tokens_per_sec": round(a.docs * a.tokens / dt),
    "nodes": [{"name": n["name"], "cores": n["cores"],
               "chunks": after.get(n["id"], n)["done"] - n["done"]} for n in who],
    "mean_score": sum(o["mean"] for o in out) / len(out),
    "at": time.strftime("%Y-%m-%d %H:%M:%S"),
}
(here / "results").mkdir(exist_ok=True)
(here / "results" / f"cluster-{a.label}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
