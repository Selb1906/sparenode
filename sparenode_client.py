"""SpareNode 클라이언트 - 노트북 AI(또는 스크립트)가 작업을 나눠 맡길 때 사용.

파이썬에서:
    from sparenode_client import run_job
    out = run_job(js_code, inputs)      # inputs의 각 원소가 한 묶음, 결과도 같은 순서

명령줄에서:
    py sparenode_client.py run tasks/synthid_score.js inputs.json -o out.json
    py sparenode_client.py nodes

작업 코드(JS)는 `function run(input) { ... return output; }` 하나를 정의하면 된다.
input/output은 JSON으로 주고받을 수 있는 값이어야 한다.
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

TOKEN_FILE = Path.home() / ".sparenode" / "token"
DEFAULT_URL = "http://localhost:8765"


def _req(url, token, method="GET", body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _token(token):
    return token or TOKEN_FILE.read_text(encoding="utf-8").strip()


def nodes(url=DEFAULT_URL, token=None):
    return _req(f"{url}/api/nodes", _token(token))


def run_job(code, inputs, name="작업", url=DEFAULT_URL, token=None, verbose=True):
    """작업을 제출하고 끝날 때까지 기다려 결과 목록을 돌려준다."""
    token = _token(token)
    job = _req(f"{url}/api/jobs", token, "POST", {"name": name, "code": code, "inputs": inputs})
    t0 = time.time()
    while True:
        job = _req(f"{url}/api/jobs/{job['id']}?wait=30", token)
        if verbose:
            print(f"\r{name}: {job['done']}/{job['total']}  {time.time() - t0:.1f}초", end="", file=sys.stderr)
        if job["status"] != "running":
            break
    if verbose:
        print(f"\n분담: {job['by_node']}", file=sys.stderr)
    if job["errors"]:
        raise RuntimeError(f"실패한 묶음이 있습니다: {job['errors'][:3]}")
    return job["results"]


def main():
    ap = argparse.ArgumentParser(description="SpareNode 작업 제출")
    ap.add_argument("--url", default=DEFAULT_URL)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="작업 실행")
    r.add_argument("code", help="작업 JS 파일")
    r.add_argument("inputs", help="입력 JSON 파일 (목록, 원소 하나가 묶음 하나)")
    r.add_argument("-o", "--out", help="결과 저장 파일")
    sub.add_parser("nodes", help="연결된 기기 목록")
    a = ap.parse_args()

    if a.cmd == "nodes":
        for n in nodes(a.url):
            print(f"{n['name']:<20} {n['cores']:>3}코어  처리 {n['done']}  {'벤치마크 중' if n['paused'] else ''}")
        return
    code = Path(a.code).read_text(encoding="utf-8")
    inputs = json.loads(Path(a.inputs).read_text(encoding="utf-8"))
    out = run_job(code, inputs, name=Path(a.code).stem, url=a.url)
    text = json.dumps(out, ensure_ascii=False)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
