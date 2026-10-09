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

// ---------- 화면 꺼짐 방지 (측정 중에만) ----------
let wakeLock = null;

async function holdScreen(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      $('specWake').textContent = '켜짐 (측정 중)';
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
      $('specWake').textContent = '측정 중에만 켜짐';
    } else if (on) {
      $('specWake').textContent = '미지원';
    }
  } catch {
    $('specWake').textContent = '사용 불가';
  }
}

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
  await holdScreen(true);

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
    log(`${BENCH[bench].name} 완료: ${compact.format(results[bench].rate)} ${BENCH[bench].unit}`);
  } catch (err) {
    renderResult(bench);
    log(`${BENCH[bench].name} 실패: ${err.message}`);
    if (location.protocol === 'file:') $('fileWarn').hidden = false;
  } finally {
    await holdScreen(false);
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
