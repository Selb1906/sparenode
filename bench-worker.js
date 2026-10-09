// SpareNode 벤치마크 워커 - CPU 코어 하나에서 돌아가는 계산 담당.
// 실제 SynthID·Zhao et al. 코드와 연산 구조(해시+표 조회, 다중 스케일 구간 검정)는
// 같게 맞추되, 입력은 합성 데이터를 쓴다. 속도 비교가 목적이다.

// ---------- 공통: 재현 가능한 난수 ----------
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- B1: SynthID 점수 계산 ----------
// 토큰마다 앞 (NGRAM-1)개 토큰 + 현재 토큰을 레이어별 키와 섞어 해시하고,
// 해시의 한 비트를 g-value(0/1)로 쓴다. 문서 점수 = 모든 g-value의 평균.
const B1 = {
  TOKENS: 512,
  NGRAM: 5,
  LAYERS: 30,
  VOCAB: 151_000, // Qwen 계열 어휘 크기 정도
};

function makeKeys(seed) {
  const rnd = mulberry32(seed);
  const keys = new Int32Array(B1.LAYERS);
  for (let l = 0; l < B1.LAYERS; l++) keys[l] = (rnd() * 4294967296) | 0;
  return keys;
}

function makeDocs(count, seed) {
  const rnd = mulberry32(seed);
  const docs = new Int32Array(count * B1.TOKENS);
  for (let i = 0; i < docs.length; i++) docs[i] = (rnd() * B1.VOCAB) | 0;
  return docs;
}

function scoreDoc(docs, offset, keys) {
  const T = B1.TOKENS, N = B1.NGRAM, L = B1.LAYERS;
  let sum = 0, count = 0;
  for (let i = N - 1; i < T; i++) {
    // n-gram 문맥을 먼저 한 번 섞어 두고, 레이어 키만 바꿔 가며 마무리 해시
    let ctx = 0x811C9DC5;
    for (let j = i - N + 1; j <= i; j++) {
      ctx = Math.imul(ctx ^ docs[offset + j], 0x01000193);
    }
    for (let l = 0; l < L; l++) {
      let h = ctx ^ keys[l];
      h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
      h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
      h ^= h >>> 16;
      sum += h & 1; // g-value
      count++;
    }
  }
  return sum / count;
}

// ---------- B2: 구간 탐지 (GCD·AOL 구조) ----------
// GCD: 길이 2^k 구간을 반 칸씩 겹쳐 덮고(geometric cover) 누적합으로 z-점수 계산.
// AOL: 한 번 훑으며 누적 편차(CUSUM)로 워터마크 구간 시작·끝을 추적.
const B2 = {
  TOKENS: 3000,
  MIN_SCALE: 3, // 길이 8부터
  Z_TH: 4,
};

function makeScoreSeqs(count, seed) {
  const rnd = mulberry32(seed);
  const T = B2.TOKENS;
  const seqs = new Float64Array(count * T);
  for (let d = 0; d < count; d++) {
    // 문서마다 무작위 위치에 워터마크 구간(점수 평균이 약간 높음)을 하나 심는다
    const len = 200 + ((rnd() * 800) | 0);
    const start = (rnd() * (T - len)) | 0;
    for (let i = 0; i < T; i++) {
      const wm = i >= start && i < start + len;
      seqs[d * T + i] = rnd() + (wm ? 0.12 : 0) - 0.06 * rnd();
    }
  }
  return seqs;
}

function detectDoc(seqs, offset, prefix) {
  const T = B2.TOKENS;
  prefix[0] = 0;
  for (let i = 0; i < T; i++) {
    prefix[i + 1] = prefix[i] + seqs[offset + i];
  }
  const mean = prefix[T] / T;
  const sd = 0.3; // 균등분포에 가까운 점수의 표준편차 근사

  // GCD
  let bestZ = -Infinity, bestS = 0, bestE = 0;
  for (let k = B2.MIN_SCALE; (1 << k) <= T; k++) {
    const len = 1 << k, step = len >> 1, norm = sd / Math.sqrt(len);
    for (let s = 0; s + len <= T; s += step) {
      const z = ((prefix[s + len] - prefix[s]) / len - mean) / norm;
      if (z > bestZ) { bestZ = z; bestS = s; bestE = s + len; }
    }
  }

  // AOL
  let cusum = 0, start = 0, aolS = 0, aolE = 0, peak = 0;
  for (let i = 0; i < T; i++) {
    cusum += seqs[offset + i] - mean - 0.03;
    if (cusum < 0) { cusum = 0; start = i + 1; }
    if (cusum > peak) { peak = cusum; aolS = start; aolE = i + 1; }
  }

  return bestZ > B2.Z_TH ? (bestE - bestS) + (aolE - aolS) : 0;
}

// ---------- 실행 루프 ----------
// 정해진 시간 동안 라운드를 반복하고, 라운드마다 처리량을 메인 화면에 보고한다.
function run({ bench, seconds, seed }) {
  const deadline = performance.now() + seconds * 1000;
  let check = 0, rounds = 0;

  if (bench === 'b1') {
    const keys = makeKeys(42);
    const docsPerRound = 50;
    const docs = makeDocs(docsPerRound, seed);
    do {
      const t0 = performance.now();
      for (let d = 0; d < docsPerRound; d++) check += scoreDoc(docs, d * B1.TOKENS, keys);
      const tokens = docsPerRound * B1.TOKENS;
      self.postMessage({ type: 'round', units: tokens, ms: performance.now() - t0 });
      rounds++;
    } while (performance.now() < deadline);
  } else if (bench === 'b2') {
    const docsPerRound = 10;
    const seqs = makeScoreSeqs(docsPerRound, seed);
    const prefix = new Float64Array(B2.TOKENS + 1);
    do {
      const t0 = performance.now();
      for (let d = 0; d < docsPerRound; d++) check += detectDoc(seqs, d * B2.TOKENS, prefix);
      self.postMessage({ type: 'round', units: docsPerRound, ms: performance.now() - t0 });
      rounds++;
    } while (performance.now() < deadline);
  } else {
    throw new Error('알 수 없는 벤치마크: ' + bench);
  }

  // check 값을 돌려줘서 계산이 최적화로 생략되지 않게 한다
  self.postMessage({ type: 'done', rounds, check });
}

self.onmessage = (e) => {
  try {
    run(e.data);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
