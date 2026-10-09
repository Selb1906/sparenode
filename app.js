// SpareNode - 2단계: 벤치마크 실행과 결과 저장.
// 계산은 bench-worker.js를 CPU 코어 수만큼 띄워 나눠 맡기고,
// 결과와 작업 기록은 localStorage에 저장해 새로고침해도 남게 한다.

const $ = (id) => document.getElementById(id);
const STORE_RESULTS = 'sparenode.results';
const STORE_LOG = 'sparenode.log';
const LOG_MAX = 100;

const BENCH = {
  b1: { name: 'B1 SynthID 점수 계산', unit: 'token/s' },
  b2: { name: 'B2 구간 탐지', unit: 'doc/s' },
};

const CORES = Math.min(navigator.hardwareConcurrency || 4, 32);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

// ---------- 저장소 (사생활 보호 모드 등에서 막혀도 화면은 동작하게) ----------
function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 저장 실패는 무시: 이번 화면에서는 계속 보임 */
  }
}

let results = load(STORE_RESULTS, {});
let logs = load(STORE_LOG, []);

// ---------- 작업 기록 ----------
function renderLog() {
  const ol = $('log');
  ol.replaceChildren();
  if (logs.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<time>--:--:--</time>아직 기록이 없습니다.';
    ol.append(li);
    return;
  }
  for (const { t, msg } of logs) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = new Date(t).toTimeString().slice(0, 8);
    li.append(time, msg);
    ol.append(li);
  }
}

function log(msg) {
  logs.unshift({ t: Date.now(), msg });
  logs = logs.slice(0, LOG_MAX);
  save(STORE_LOG, logs);
  renderLog();
}

$('clearLog').addEventListener('click', () => {
  logs = [];
  save(STORE_LOG, logs);
  renderLog();
});

// ---------- 결과 표시 ----------
function renderResult(bench) {
  const cell = $('res-' + bench);
  const r = results[bench];
  cell.classList.remove('running');
  if (!r) {
    cell.textContent = '—';
    return;
  }
  const meta = [`${r.workers}코어`, `${r.seconds}초`];
  if (r.sustain != null) meta.push(`유지 ${r.sustain}%`);
  if (r.batteryDrop != null) meta.push(`배터리 −${r.batteryDrop}%`);
  cell.innerHTML = '';
  cell.append(compact.format(r.rate));
  const small = document.createElement('small');
  small.textContent = meta.join(' · ');
  cell.append(small);
}

// ---------- 이 기기 정보 ----------
$('specCores').textContent =
  navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency}개` : '알 수 없음';

// deviceMemory는 Chrome만 제공하고, 개인정보 보호로 최대 8GB까지만 알려 준다
$('specMem').textContent =
  navigator.deviceMemory ? `${navigator.deviceMemory}GB 이상` : '알 수 없음';

if (!('gpu' in navigator)) {
  $('specGpu').textContent = window.isSecureContext ? '미지원' : '미지원 (https 필요)';
} else {
  navigator.gpu.requestAdapter()
    .then((adapter) => { $('specGpu').textContent = adapter ? '사용 가능' : '어댑터 없음'; })
    .catch(() => { $('specGpu').textContent = '오류'; });
}

let battery = null;
if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    battery = b;
    const show = () => {
      $('specBattery').textContent =
        `${Math.round(b.level * 100)}%${b.charging ? ' 충전 중' : ''}`;
    };
    show();
    b.addEventListener('levelchange', show);
    b.addEventListener('chargingchange', show);
  }).catch(() => {});
}

// ---------- 화면 꺼짐 방지 (벤치마크 측정 중, 코디네이터 연결 중) ----------
// 화면이 꺼지면 브라우저가 계산을 멈추므로, 필요한 동안만 화면을 켜 둔다.
let wakeLock = null;
const wakeReasons = new Set();

function showWake() {
  let text;
  if (!('wakeLock' in navigator)) text = window.isSecureContext ? '미지원' : '사용 불가 (https 필요)';
  else if (wakeLock) text = '켜짐';
  else text = '측정·연결 중에만 켜짐';
  $('specWake').textContent = text;
}

async function syncWake() {
  const need = wakeReasons.size > 0 && document.visibilityState === 'visible';
  try {
    if (need && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; showWake(); });
    } else if (!wakeReasons.size && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
  showWake();
}

function holdScreen(reason, on) {
  if (on) wakeReasons.add(reason);
  else wakeReasons.delete(reason);
  return syncWake();
}

// 다른 앱을 봤다 돌아오면 브라우저가 풀어 둔 화면 켜짐을 다시 요청
document.addEventListener('visibilitychange', syncWake);

// ---------- 벤치마크 실행 ----------
// 워커를 코어 수만큼 띄우고, 라운드 보고를 시간 구간별로 모아
// 평균 처리량과 유지율(마지막 구간 ÷ 첫 구간)을 계산한다.
function runBench(bench, seconds) {
  return new Promise((resolve, reject) => {
    const workers = [];
    const bucketMs = Math.max(1000, (seconds * 1000) / 10); // 전체를 10구간으로
    const buckets = [];
    let total = 0, finished = 0;
    const t0 = performance.now();

    const stopAll = () => workers.forEach((w) => w.terminate());

    for (let i = 0; i < CORES; i++) {
      let w;
      try {
        w = new Worker('bench-worker.js');
      } catch (err) {
        stopAll();
        reject(err);
        return;
      }
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'round') {
          total += m.units;
          const b = Math.floor((performance.now() - t0) / bucketMs);
          buckets[b] = (buckets[b] || 0) + m.units;
        } else if (m.type === 'done') {
          if (++finished === CORES) {
            const elapsed = (performance.now() - t0) / 1000;
            stopAll();
            resolve({ total, elapsed, buckets, bucketMs });
          }
        } else if (m.type === 'error') {
          stopAll();
          reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        e.preventDefault();
        stopAll();
        reject(new Error(e.message || '워커를 불러오지 못했습니다'));
      };
      workers.push(w);
      w.postMessage({ bench, seconds, seed: 1000 + i });
    }
  });
}

function sustainRatio(buckets, seconds) {
  // 짧은 측정에서는 발열 영향이 안 보이므로 1분 이상일 때만 계산.
  // 첫 구간(워커 시작·JIT 예열)과 마지막 구간(덜 찰 수 있음)은 제외한다.
  if (seconds < 60) return null;
  const mid = buckets.slice(1, -1).filter((v) => v > 0);
  if (mid.length < 2) return null;
  return Math.round((mid[mid.length - 1] / mid[0]) * 100);
}

let running = false;
const benchButtons = document.querySelectorAll('[data-bench]');

function setRunning(on, bench) {
  running = on;
  $('runAll').disabled = on;
  $('duration').disabled = on;
  benchButtons.forEach((btn) => {
    btn.disabled = on;
    const active = on && btn.dataset.bench === bench;
    btn.classList.toggle('running', active);
    btn.textContent = active ? '실행 중' : '실행';
  });
  $('runAll').classList.toggle('running', on);
}

async function measure(bench) {
  const seconds = Number($('duration').value);
  const cell = $('res-' + bench);
  setRunning(true, bench);
  cell.textContent = '측정 중…';
  cell.classList.add('running');
  log(`${BENCH[bench].name} 시작 (${CORES}코어, ${seconds}초)`);

  const batteryStart = battery && !battery.charging ? battery.level : null;
  await holdScreen('bench', true);
  node.pause(true);

  try {
    const r = await runBench(bench, seconds);
    const batteryDrop = batteryStart != null && battery && !battery.charging
      ? Math.max(0, Math.round((batteryStart - battery.level) * 100))
      : null;
    results[bench] = {
      rate: r.total / r.elapsed,
      unit: BENCH[bench].unit,
      workers: CORES,
      seconds,
      sustain: sustainRatio(r.buckets, seconds),
      batteryDrop,
      at: Date.now(),
    };
    save(STORE_RESULTS, results);
    renderResult(bench);
    node.reportBench();
    log(`${BENCH[bench].name} 완료: ${compact.format(results[bench].rate)} ${BENCH[bench].unit}`);
  } catch (err) {
    renderResult(bench);
    log(`${BENCH[bench].name} 실패: ${err.message}`);
    if (location.protocol === 'file:') $('fileWarn').hidden = false;
  } finally {
    await holdScreen('bench', false);
    node.pause(false);
    setRunning(false);
  }
}

benchButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!running) measure(btn.dataset.bench);
  });
});

$('runAll').addEventListener('click', async () => {
  if (running) return;
  for (const bench of Object.keys(BENCH)) await measure(bench);
});

// ---------- 작업 노드: 코디네이터에 자동 접속해 받은 작업을 버튼 없이 처리 ----------
// 코디네이터가 보낸 작업 코드를 task-worker.js(코어 수만큼)에서 실행하고 결과만 돌려준다.
const STORE_NODE = 'sparenode.node';

function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android 폰';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Mac/i.test(ua)) return 'Mac';
  return '기기';
}

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'n-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const node = (() => {
  const cfg = Object.assign({ url: '', token: '', name: guessName(), auto: true, id: newId() }, load(STORE_NODE, {}));
  save(STORE_NODE, cfg);

  let ws = null;
  let state = 'off'; // off | connecting | online | retry
  let userClosed = false;
  let authFailed = false;
  let retryDelay = 2000;
  let retryTimer = null;
  let pingTimer = null;
  let paused = false;

  const tasks = new Map(); // taskId -> code
  const queue = []; // 대기 중인 묶음
  let pool = []; // { w, busy }
  const jobsSeen = new Map(); // jobId -> 이 기기가 처리한 묶음 수
  const jobsLogged = new Set();

  // ---- 화면 표시
  function setConn(text, cls) {
    const el = $('connStatus');
    el.className = 'conn ' + cls;
    el.lastChild.textContent = text;
  }

  function showState() {
    const busy = pool.filter((p) => p.busy).length;
    if (state === 'online') {
      if (paused) setConn('연결됨 · 벤치마크 중', 'online');
      else if (busy) setConn(`작업 처리 중 (${busy}/${CORES}코어)`, 'working');
      else setConn('연결됨 · 작업 대기', 'online');
    } else if (state === 'connecting') setConn('코디네이터 연결 중…', 'offline');
    else if (state === 'retry') setConn('연결 끊김 · 다시 연결 중', 'offline');
    else setConn('코디네이터 미연결', 'offline');
    const live = state === 'online' || state === 'connecting' || state === 'retry';
    $('connectBtn').hidden = live;
    $('disconnectBtn').hidden = !live;
    $('clusterSection').hidden = state !== 'online';
  }

  function renderStatus(msg) {
    const rows = $('nodeRows');
    rows.replaceChildren();
    for (const n of msg.nodes) {
      const tr = document.createElement('tr');
      if (n.id === cfg.id) tr.className = 'me';
      const b = n.bench || {};
      const rate = (k) => (b[k] ? compact.format(b[k].rate) : '—');
      const cells = [n.name, n.cores, rate('b1'), rate('b2'), n.paused ? '벤치마크 중' : n.running, n.done];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i > 0) td.className = 'r num' + (n.paused && i === 4 ? ' paused' : '');
        tr.append(td);
      });
      rows.append(tr);
    }
    const job = msg.jobs.find((j) => j.status === 'running') || msg.jobs[msg.jobs.length - 1];
    $('jobLine').textContent = !job ? '작업 없음'
      : job.status === 'running' ? `${job.name} ${job.done}/${job.total}`
      : `${job.name} 완료 · ${job.elapsed}초`;

    // 끝난 작업은 이 기기가 처리한 몫을 한 줄로 기록
    for (const j of msg.jobs) {
      if (j.status !== 'running' && jobsSeen.has(j.id) && !jobsLogged.has(j.id)) {
        jobsLogged.add(j.id);
        log(`작업 끝남: ${j.name} · 전체 ${j.total}묶음 ${j.elapsed}초 · 이 기기 ${jobsSeen.get(j.id)}묶음`);
      }
    }
  }

  // ---- 워커 풀
  function makePool() {
    if (pool.length) return;
    pool = Array.from({ length: CORES }, () => {
      const p = { w: new Worker('task-worker.js'), busy: false };
      p.w.onmessage = (e) => {
        p.busy = false;
        const m = e.data;
        if (m.type === 'result') jobsSeen.set(m.jobId, (jobsSeen.get(m.jobId) || 0) + 1);
        send(m);
        pump();
        showState();
      };
      p.w.onerror = (e) => {
        e.preventDefault();
        p.busy = false;
        pump();
      };
      for (const [taskId, code] of tasks) p.w.postMessage({ type: 'define', taskId, code });
      return p;
    });
  }

  function dropPool() {
    pool.forEach((p) => p.w.terminate());
    pool = [];
    queue.length = 0;
  }

  function pump() {
    if (paused) return;
    for (const p of pool) {
      if (!queue.length) break;
      if (!p.busy) {
        p.busy = true;
        p.w.postMessage(queue.shift());
      }
    }
  }

  // ---- 연결
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  async function resolveUrl() {
    let u = cfg.url.trim();
    if (!u) {
      // 주소를 비우면 이 앱을 내보낸 곳이 코디네이터인지 확인해서 거기로 접속
      if (location.protocol === 'file:') throw new Error('코디네이터 주소를 입력해 주세요');
      const res = await fetch(new URL('/api/info', location), { cache: 'no-store' }).catch(() => null);
      const info = res && res.ok ? await res.json().catch(() => null) : null;
      if (!info || !info.sparenode) throw new Error('이 주소는 코디네이터가 아닙니다. 코디네이터 주소를 입력해 주세요');
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    }
    u = u.replace(/^http(s?):\/\//i, 'ws$1://');
    if (!/^wss?:\/\//i.test(u)) {
      const local = /^(localhost|127\.|\[::1\])/i.test(u);
      u = (location.protocol === 'https:' && !local ? 'wss://' : 'ws://') + u;
    }
    const parsed = new URL(u);
    if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = '/ws';
    return parsed.toString();
  }

  async function connect() {
    clearTimeout(retryTimer);
    if (!cfg.token) {
      log('접속 토큰을 입력해 주세요');
      state = 'off';
      showState();
      return;
    }
    userClosed = false;
    authFailed = false;
    state = 'connecting';
    showState();

    let url = '';
    try {
      url = await resolveUrl();
      ws = new WebSocket(url);
    } catch (err) {
      const mixed = location.protocol === 'https:' && /^ws:/i.test(url);
      log(mixed
        ? 'https 앱에서는 ws:// 주소로 접속할 수 없습니다. USB 연결 후 localhost:8765를 쓰거나, 코디네이터 주소(http://노트북IP:8765)로 앱을 열어 주세요'
        : `연결 실패: ${err.message}`);
      ws = null;
      state = 'off';
      showState();
      return;
    }

    const sock = ws;
    sock.onopen = () => {
      send({
        type: 'hello',
        token: cfg.token,
        node: { id: cfg.id, name: cfg.name, cores: CORES, platform: navigator.platform || '' },
      });
    };

    sock.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'welcome') {
        state = 'online';
        retryDelay = 2000;
        log(`코디네이터 연결됨 (${new URL(url).host})`);
        holdScreen('node', true);
        clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ type: 'ping' }), 15000);
        if (paused) send({ type: 'pause' });
        reportBench();
        showState();
      } else if (m.type === 'error') {
        authFailed = true;
        log(`코디네이터가 접속을 거절했습니다: ${m.message}`);
      } else if (m.type === 'task') {
        tasks.set(m.taskId, m.code);
        makePool();
        pool.forEach((p) => p.w.postMessage({ type: 'define', taskId: m.taskId, code: m.code }));
      } else if (m.type === 'chunk') {
        if (paused) return; // 코디네이터가 다른 기기에 다시 배정
        if (!jobsSeen.has(m.jobId)) {
          jobsSeen.set(m.jobId, 0);
          log(`작업 받음: ${m.jobId}`);
        }
        makePool();
        queue.push(m);
        pump();
        showState();
      } else if (m.type === 'status') {
        renderStatus(m);
      }
    };

    sock.onclose = () => {
      if (ws !== sock) return; // 새 연결로 바뀐 뒤 닫힌 옛 연결
      clearInterval(pingTimer);
      dropPool();
      holdScreen('node', false);
      ws = null;
      if (userClosed || authFailed) {
        if (state === 'online' && userClosed) log('코디네이터 연결을 끊었습니다');
        state = 'off';
      } else {
        if (state === 'online') log('코디네이터 연결이 끊겼습니다. 다시 연결합니다');
        else if (state === 'connecting') log('코디네이터에 접속하지 못했습니다. 잠시 뒤 다시 시도합니다');
        state = 'retry';
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      }
      showState();
    };
  }

  function disconnect() {
    userClosed = true;
    clearTimeout(retryTimer);
    if (ws) ws.close();
    else { state = 'off'; showState(); }
  }

  // 이 기기의 벤치마크 결과를 코디네이터에 알려 '연결된 기기' 표에서 비교
  function reportBench() {
    const slim = {};
    for (const [k, r] of Object.entries(results)) slim[k] = { rate: r.rate, seconds: r.seconds, sustain: r.sustain };
    send({ type: 'bench', results: slim });
  }

  // 벤치마크 중에는 작업을 받지 않는다 (CPU를 나눠 쓰면 둘 다 부정확해짐)
  function pause(on) {
    paused = on;
    if (on) {
      dropPool();
      send({ type: 'pause' });
    } else {
      send({ type: 'resume' });
    }
    showState();
  }

  // ---- 설정 폼
  function initForm() {
    // 코디네이터가 알려 준 주소(…/?token=…)로 열었으면 토큰을 저장하고 주소창에서 지운다
    const params = new URLSearchParams(location.search);
    if (params.get('token')) {
      cfg.token = params.get('token');
      save(STORE_NODE, cfg);
      history.replaceState(null, '', location.pathname);
    }
    $('coordUrl').value = cfg.url;
    $('coordToken').value = cfg.token;
    $('nodeName').value = cfg.name;
    $('autoConnect').checked = cfg.auto;

    $('coordForm').addEventListener('submit', (e) => {
      e.preventDefault();
      cfg.url = $('coordUrl').value.trim();
      cfg.token = $('coordToken').value.trim();
      cfg.name = $('nodeName').value.trim() || guessName();
      cfg.auto = $('autoConnect').checked;
      save(STORE_NODE, cfg);
      if (ws) {
        const old = ws;
        ws = null;
        old.close();
      }
      connect();
    });
    $('autoConnect').addEventListener('change', () => {
      cfg.auto = $('autoConnect').checked;
      save(STORE_NODE, cfg);
    });
    $('disconnectBtn').addEventListener('click', disconnect);

    showState();
    if (cfg.auto && cfg.token && location.protocol !== 'file:') connect();
  }

  return { initForm, pause, reportBench };
})();

// ---------- PWA: 서비스 워커 등록 (https 또는 localhost에서만 동작) ----------
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('service-worker.js').catch((err) => {
    log(`서비스 워커 등록 실패: ${err.message}`);
  });
}

// ---------- 시작 ----------
if (location.protocol === 'file:') $('fileWarn').hidden = false;
Object.keys(BENCH).forEach(renderResult);
renderLog();
node.initForm();
