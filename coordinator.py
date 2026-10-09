"""SpareNode 코디네이터 - 노트북에서 실행.

기기(노드)들이 WebSocket으로 접속해 오면, 제출된 작업(job)을 묶음(chunk)으로
나눠 빈 코어가 있는 기기에 자동으로 보내고 결과를 모은다.
외부 패키지 없이 파이썬 표준 라이브러리만 사용한다.

실행:
    py coordinator.py                # 0.0.0.0:8765
    py coordinator.py --port 9000
    py coordinator.py --adb          # USB로 연결한 안드로이드 폰에서 localhost로 접속 가능하게

같은 포트에서 하는 일:
    GET  /                 앱 화면 (같은 Wi-Fi의 기기가 브라우저로 열면 바로 노드가 됨)
    WS   /ws               노드 접속
    POST /api/jobs         작업 제출 (sparenode_client.py가 사용)
    GET  /api/jobs/<id>    진행 상황·결과
    GET  /api/nodes        연결된 기기 목록
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import socket
import struct
import subprocess
import time
import uuid
from collections import deque
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

APP_DIR = Path(__file__).resolve().parent
TOKEN_FILE = Path.home() / ".sparenode" / "token"

# 앱 화면으로 내보내는 파일 (그 외 파일은 절대 내보내지 않음)
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/style.css": "style.css",
    "/app.js": "app.js",
    "/bench-worker.js": "bench-worker.js",
    "/task-worker.js": "task-worker.js",
    "/service-worker.js": "service-worker.js",
    "/manifest.json": "manifest.json",
    "/icons/icon-192.png": "icons/icon-192.png",
    "/icons/icon-512.png": "icons/icon-512.png",
    "/icons/apple-touch-icon.png": "icons/apple-touch-icon.png",
    "/favicon.ico": "icons/icon-192.png",
}

MAX_BODY = 256 * 1024 * 1024
MAX_FRAME = 64 * 1024 * 1024
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NODE_TIMEOUT = 45  # 이 시간 동안 소식이 없으면 연결 끊긴 것으로 처리
CHUNK_TIMEOUT = 300  # 묶음 하나가 이보다 오래 걸리면 다른 기기에 다시 배정
MAX_ATTEMPTS = 3


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- 상태


class Node:
    def __init__(self, ws, info):
        self.ws = ws
        self.id = str(info.get("id") or uuid.uuid4())
        self.name = str(info.get("name") or "이름 없는 기기")[:40]
        self.cores = max(1, min(int(info.get("cores") or 1), 64))
        self.platform = str(info.get("platform") or "")[:40]
        self.paused = False
        self.bench = {}  # 기기가 알려 준 벤치마크 결과
        self.inflight = {}  # (job_id, chunk_id) -> 보낸 시각
        self.tasks_sent = set()
        self.done = 0
        self.busy_ms = 0.0
        self.joined = time.time()
        self.last_seen = time.time()

    def free_slots(self):
        return 0 if self.paused else self.cores - len(self.inflight)

    def summary(self):
        return {
            "id": self.id,
            "name": self.name,
            "cores": self.cores,
            "platform": self.platform,
            "paused": self.paused,
            "running": len(self.inflight),
            "done": self.done,
            "bench": self.bench,
        }


class Job:
    def __init__(self, name, code, inputs):
        self.id = uuid.uuid4().hex[:12]
        self.task_id = hashlib.sha256(code.encode()).hexdigest()[:16]
        self.name = name
        self.code = code
        self.inputs = inputs
        self.results = [None] * len(inputs)
        self.finished = [False] * len(inputs)
        self.attempts = [0] * len(inputs)
        self.pending = deque(range(len(inputs)))
        self.done_count = 0
        self.errors = []
        self.by_node = {}  # 노드 이름 -> 처리한 묶음 수
        self.created = time.time()
        self.ended = None
        self.status = "running" if inputs else "done"
        if not inputs:
            self.ended = self.created
        self.event = asyncio.Event()
        if not inputs:
            self.event.set()

    def summary(self, with_results=False):
        end = self.ended or time.time()
        out = {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "total": len(self.inputs),
            "done": self.done_count,
            "elapsed": round(end - self.created, 3),
            "by_node": self.by_node,
            "errors": self.errors[:20],
        }
        if with_results:
            out["results"] = self.results
        return out


class Coordinator:
    def __init__(self, token):
        self.token = token
        self.nodes = {}  # id -> Node
        self.jobs = {}  # id -> Job (최근 것만 보관)
        self.job_order = deque()

    # ---- 인증
    def check(self, given):
        return bool(given) and hmac.compare_digest(str(given), self.token)

    # ---- 작업 제출
    def submit(self, name, code, inputs):
        job = Job(name, code, inputs)
        self.jobs[job.id] = job
        self.job_order.append(job.id)
        while len(self.job_order) > 50:
            old = self.job_order.popleft()
            if self.jobs.get(old) and self.jobs[old].status != "running":
                del self.jobs[old]
            else:
                self.job_order.append(old)
                break
        log(f"작업 제출: {name} ({len(inputs)}묶음) id={job.id}")
        self.dispatch()
        return job

    # ---- 분배: 빈 코어가 있는 기기에 대기 중인 묶음을 보낸다
    def dispatch(self):
        running = [self.jobs[j] for j in self.job_order if j in self.jobs and self.jobs[j].status == "running"]
        if not running:
            return
        for node in list(self.nodes.values()):
            while node.free_slots() > 0:
                job = next((j for j in running if j.pending), None)
                if job is None:
                    return
                cid = job.pending.popleft()
                if job.finished[cid]:
                    continue
                if job.task_id not in node.tasks_sent:
                    node.ws.send_json({"type": "task", "taskId": job.task_id, "code": job.code})
                    node.tasks_sent.add(job.task_id)
                node.inflight[(job.id, cid)] = time.time()
                job.attempts[cid] += 1
                node.ws.send_json({
                    "type": "chunk",
                    "jobId": job.id,
                    "chunkId": cid,
                    "taskId": job.task_id,
                    "input": job.inputs[cid],
                })

    def requeue(self, node, reason):
        for (jid, cid) in list(node.inflight):
            job = self.jobs.get(jid)
            if job and job.status == "running" and not job.finished[cid]:
                job.pending.appendleft(cid)
        if node.inflight:
            log(f"{node.name}: 처리 중이던 {len(node.inflight)}묶음 재배정 ({reason})")
        node.inflight.clear()

    # ---- 노드가 보낸 메시지
    def on_result(self, node, msg):
        key = (msg.get("jobId"), msg.get("chunkId"))
        node.inflight.pop(key, None)
        job = self.jobs.get(key[0])
        cid = key[1]
        if not job or job.status != "running" or not isinstance(cid, int) or not 0 <= cid < len(job.inputs):
            return
        if msg["type"] == "result":
            node.done += 1
            node.busy_ms += float(msg.get("ms") or 0)
            if not job.finished[cid]:
                job.finished[cid] = True
                job.results[cid] = msg.get("output")
                job.done_count += 1
                job.by_node[node.name] = job.by_node.get(node.name, 0) + 1
        else:
            err = str(msg.get("error"))[:500]
            if job.attempts[cid] < MAX_ATTEMPTS:
                job.pending.append(cid)
            else:
                job.errors.append({"chunk": cid, "node": node.name, "error": err})
                job.finished[cid] = True
                job.done_count += 1
            log(f"{node.name}: 묶음 {cid} 실패 - {err}")
        if job.done_count == len(job.inputs):
            job.status = "failed" if job.errors else "done"
            job.ended = time.time()
            job.event.set()
            log(f"작업 완료: {job.name} {job.ended - job.created:.2f}초 {job.by_node}")

    def status_message(self):
        jobs = [self.jobs[j].summary() for j in list(self.job_order)[-5:] if j in self.jobs]
        return {"type": "status", "nodes": [n.summary() for n in self.nodes.values()], "jobs": jobs}

    def broadcast_status(self):
        msg = self.status_message()
        for node in self.nodes.values():
            node.ws.send_json(msg)

    async def housekeeping(self):
        while True:
            await asyncio.sleep(2)
            now = time.time()
            for node in list(self.nodes.values()):
                if now - node.last_seen > NODE_TIMEOUT:
                    log(f"{node.name}: 응답 없음, 연결 정리")
                    node.ws.close()
                    continue
                for key, sent in list(node.inflight.items()):
                    if now - sent > CHUNK_TIMEOUT:
                        node.inflight.pop(key)
                        job = self.jobs.get(key[0])
                        if job and job.status == "running" and not job.finished[key[1]]:
                            job.pending.append(key[1])
            self.dispatch()
            self.broadcast_status()


# ---------------------------------------------------------------- WebSocket (RFC 6455 최소 구현)


class WebSocket:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.closed = False

    def _send_frame(self, opcode, payload):
        if self.closed:
            return
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        try:
            self.writer.write(head + payload)
        except Exception:
            self.closed = True

    def send_json(self, obj):
        self._send_frame(0x1, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())

    def close(self):
        if not self.closed:
            self._send_frame(0x8, b"")
            self.closed = True
            try:
                self.writer.close()
            except Exception:
                pass

    async def recv(self):
        """텍스트 메시지 하나를 돌려준다. 연결이 끝나면 None."""
        buf, first_op = b"", None
        while True:
            try:
                b1, b2 = await self.reader.readexactly(2)
                n = b2 & 0x7F
                if n == 126:
                    (n,) = struct.unpack(">H", await self.reader.readexactly(2))
                elif n == 127:
                    (n,) = struct.unpack(">Q", await self.reader.readexactly(8))
                if n > MAX_FRAME:
                    self.close()
                    return None
                mask = await self.reader.readexactly(4) if b2 & 0x80 else None
                data = await self.reader.readexactly(n)
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                self.closed = True
                return None
            if mask:
                data = _unmask(data, mask)
            op = b1 & 0x0F
            if op == 0x8:
                self.close()
                return None
            if op == 0x9:
                self._send_frame(0xA, data)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2):
                first_op, buf = op, data
            elif op == 0x0:
                buf += data
                if len(buf) > MAX_FRAME:
                    self.close()
                    return None
            if b1 & 0x80 and first_op is not None:
                return buf.decode("utf-8", errors="replace")


def _unmask(data, mask):
    # 바이트마다 XOR하는 대신 큰 정수 하나로 한 번에 푼다 (큰 메시지에서 훨씬 빠름)
    n = len(data)
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")


# ---------------------------------------------------------------- HTTP


async def read_request(reader):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        return None
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, _ = lines[0].split(" ", 2)
    except ValueError:
        return None
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    body = b""
    length = int(headers.get("content-length") or 0)
    if length > MAX_BODY:
        return {"method": method, "too_big": True, "headers": headers, "target": target}
    if length:
        body = await reader.readexactly(length)
    return {"method": method, "target": target, "headers": headers, "body": body}


def respond(writer, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
    reason = {200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
              404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large"}.get(status, "OK")
    if isinstance(body, (dict, list)):
        body = json.dumps(body, ensure_ascii=False).encode()
    elif isinstance(body, str):
        body = body.encode()
    head = [f"HTTP/1.1 {status} {reason}", f"Content-Type: {ctype}", f"Content-Length: {len(body)}",
            "Connection: close", "Cache-Control: no-cache",
            # GitHub Pages에서 설치한 앱이 localhost 코디네이터에 접속할 수 있게
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Headers: Authorization, Content-Type",
            "Access-Control-Allow-Private-Network: true"]
    head += extra or []
    writer.write(("\r\n".join(head) + "\r\n\r\n").encode() + body)


def bearer(req, query):
    auth = req["headers"].get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (query.get("token") or [None])[0]


async def handle(coord, reader, writer):
    req = await read_request(reader)
    if req is None:
        writer.close()
        return
    url = urlsplit(req["target"])
    path, query = url.path, parse_qs(url.query)
    try:
        if req.get("too_big"):
            respond(writer, 413, {"error": "요청이 너무 큽니다"})
        elif path == "/ws" and req["headers"].get("upgrade", "").lower() == "websocket":
            await serve_node(coord, req, reader, writer)
            return
        elif req["method"] == "OPTIONS":
            respond(writer, 204)
        elif path == "/api/info":
            # 앱이 '여기가 코디네이터인지' 확인할 때 사용 (토큰 불필요, 비밀 정보 없음)
            respond(writer, 200, {"sparenode": True, "version": 1})
        elif path.startswith("/api/"):
            await serve_api(coord, req, path, query, writer)
        elif req["method"] == "GET" and path in STATIC_FILES:
            f = APP_DIR / STATIC_FILES[path]
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if f.suffix == ".js":
                ctype = "text/javascript; charset=utf-8"
            elif f.suffix in (".html", ".css", ".json"):
                ctype += "; charset=utf-8"
            respond(writer, 200, f.read_bytes(), ctype)
        else:
            respond(writer, 404, {"error": "없는 주소"})
        await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve_api(coord, req, path, query, writer):
    if not coord.check(bearer(req, query)):
        respond(writer, 401, {"error": "토큰이 맞지 않습니다"})
        return
    if path == "/api/nodes" and req["method"] == "GET":
        respond(writer, 200, [n.summary() for n in coord.nodes.values()])
    elif path == "/api/jobs" and req["method"] == "POST":
        try:
            data = json.loads(req["body"])
            code, inputs = data["code"], data["inputs"]
            assert isinstance(code, str) and isinstance(inputs, list)
        except Exception:
            respond(writer, 400, {"error": "code(문자열)와 inputs(목록)가 필요합니다"})
            return
        job = coord.submit(str(data.get("name") or "작업")[:80], code, inputs)
        respond(writer, 201, job.summary())
    elif path.startswith("/api/jobs/") and req["method"] == "GET":
        job = coord.jobs.get(path.rsplit("/", 1)[-1])
        if not job:
            respond(writer, 404, {"error": "없는 작업"})
            return
        wait = float((query.get("wait") or ["0"])[0])
        if wait > 0 and job.status == "running":
            try:
                await asyncio.wait_for(job.event.wait(), timeout=min(wait, 60))
            except asyncio.TimeoutError:
                pass
        respond(writer, 200, job.summary(with_results=job.status != "running"))
    else:
        respond(writer, 404, {"error": "없는 API"})


async def serve_node(coord, req, reader, writer):
    key = req["headers"].get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
    ws = WebSocket(reader, writer)

    first = await ws.recv()
    try:
        hello = json.loads(first or "{}")
    except json.JSONDecodeError:
        hello = {}
    if hello.get("type") != "hello" or not coord.check(hello.get("token")):
        ws.send_json({"type": "error", "message": "토큰이 맞지 않습니다"})
        await writer.drain()
        ws.close()
        return

    node = Node(ws, hello.get("node") or {})
    old = coord.nodes.get(node.id)
    if old:  # 같은 기기가 다시 접속하면 이전 연결 정리
        coord.requeue(old, "재접속")
        old.ws.close()
    coord.nodes[node.id] = node
    log(f"접속: {node.name} ({node.cores}코어, {node.platform})")
    ws.send_json({"type": "welcome", "nodeId": node.id})
    coord.dispatch()
    coord.broadcast_status()

    try:
        while True:
            raw = await ws.recv()
            if raw is None:
                break
            node.last_seen = time.time()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind in ("result", "fail"):
                coord.on_result(node, msg)
            elif kind == "pause":
                node.paused = True
                coord.requeue(node, "벤치마크 중")
            elif kind == "resume":
                node.paused = False
            elif kind == "bench":
                if isinstance(msg.get("results"), dict):
                    node.bench = msg["results"]
                    coord.broadcast_status()
            elif kind == "ping":
                ws.send_json({"type": "pong"})
            coord.dispatch()
            await writer.drain()
    finally:
        if coord.nodes.get(node.id) is node:
            del coord.nodes[node.id]
            coord.requeue(node, "연결 끊김")
            log(f"연결 끊김: {node.name}")
            coord.dispatch()
            coord.broadcast_status()
        ws.close()


# ---------------------------------------------------------------- 실행


def load_token():
    if TOKEN_FILE.exists():
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if tok:
            return tok
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    tok = secrets.token_urlsafe(16)
    TOKEN_FILE.write_text(tok, encoding="utf-8")
    return tok


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and not ip.startswith("169.254."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def find_adb():
    found = shutil.which("adb")
    if found:
        return found
    for base in [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"),
                 r"E:\AndroidSDK", os.path.expandvars(r"%LOCALAPPDATA%\Android\Sdk")]:
        if base:
            p = Path(base) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
            if p.exists():
                return str(p)
    return None


def adb_reverse(port):
    adb = find_adb()
    if not adb:
        log("adb를 찾지 못했습니다 (Android SDK platform-tools 필요)")
        return
    r = subprocess.run([adb, "reverse", f"tcp:{port}", f"tcp:{port}"], capture_output=True, text=True)
    if r.returncode == 0:
        log(f"USB 폰 연결됨: 폰에서 localhost:{port} → 이 노트북")
    else:
        log(f"adb reverse 실패: {(r.stderr or r.stdout).strip()} (폰의 USB 디버깅을 켜 주세요)")


async def main():
    ap = argparse.ArgumentParser(description="SpareNode 코디네이터")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--adb", action="store_true", help="USB 안드로이드 폰에 adb reverse 설정")
    ap.add_argument("--new-token", action="store_true", help="접속 토큰을 새로 만든다")
    args = ap.parse_args()

    if args.new_token and TOKEN_FILE.exists():
        TOKEN_FILE.unlink()
    coord = Coordinator(load_token())
    server = await asyncio.start_server(lambda r, w: handle(coord, r, w), args.host, args.port,
                                        limit=1024 * 1024)
    asyncio.create_task(coord.housekeeping())

    log(f"SpareNode 코디네이터 시작 (포트 {args.port})")
    log(f"접속 토큰: {coord.token}   (저장 위치: {TOKEN_FILE})")
    log(f"이 노트북에서 노드로 참여: http://localhost:{args.port}/?token={coord.token}")
    for ip in lan_ips():
        log(f"같은 Wi-Fi 기기:          http://{ip}:{args.port}/?token={coord.token}")
    if args.adb:
        adb_reverse(args.port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
