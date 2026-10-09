"""시연용: 문서를 묶음으로 나눠 연결된 모든 기기에 SynthID 점수 계산을 맡긴다.

    py demo.py              # 문서 4,000개, 묶음 80개
    py demo.py --docs 20000
"""

import argparse
import random
import time
from pathlib import Path

from sparenode_client import nodes, run_job

ap = argparse.ArgumentParser()
ap.add_argument("--docs", type=int, default=4000)
ap.add_argument("--per-chunk", type=int, default=50)
ap.add_argument("--tokens", type=int, default=512)
a = ap.parse_args()

rnd = random.Random(0)
keys = [rnd.randrange(-2**31, 2**31) for _ in range(30)]
docs = [[rnd.randrange(151_000) for _ in range(a.tokens)] for _ in range(a.docs)]
inputs = [{"docs": docs[i:i + a.per_chunk], "keys": keys, "ngram": 5}
          for i in range(0, len(docs), a.per_chunk)]

print("연결된 기기:", ", ".join(f"{n['name']}({n['cores']}코어)" for n in nodes()) or "없음")
code = (Path(__file__).parent / "tasks" / "synthid_score.js").read_text(encoding="utf-8")
t0 = time.time()
scores = [s for chunk in run_job(code, inputs, name="SynthID 점수") for s in chunk]
dt = time.time() - t0
print(f"문서 {len(scores)}개 · {dt:.2f}초 · {len(scores) * a.tokens / dt:,.0f} token/s · 평균 점수 {sum(scores) / len(scores):.4f}")
