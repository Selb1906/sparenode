// 예시 작업: SynthID 점수 계산 - 문서를 직접 보내지 않고 시드만 보내 기기에서 생성
// (전송량을 줄여 계산 비중이 큰 작업을 흉내 낸다)
// input:  { seed, docs, tokens, keys: [레이어 키], ngram: 5, vocab }
// output: { n: 문서 수, mean: 평균 점수 }
function run(input) {
  const { seed, docs, tokens, keys, ngram = 5, vocab = 151000 } = input;
  let s = seed | 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const doc = new Int32Array(tokens);
  let total = 0;
  for (let d = 0; d < docs; d++) {
    for (let i = 0; i < tokens; i++) doc[i] = (rnd() * vocab) | 0;
    let sum = 0, count = 0;
    for (let i = ngram - 1; i < tokens; i++) {
      let ctx = 0x811C9DC5;
      for (let j = i - ngram + 1; j <= i; j++) ctx = Math.imul(ctx ^ doc[j], 0x01000193);
      for (let l = 0; l < keys.length; l++) {
        let h = ctx ^ keys[l];
        h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
        h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
        h ^= h >>> 16;
        sum += h & 1;
        count++;
      }
    }
    total += sum / count;
  }
  return { n: docs, mean: total / docs };
}
