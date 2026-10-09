// 예시 작업: SynthID 점수 계산 (bench-worker.js의 B1과 같은 계산)
// input:  { docs: [[token id, ...], ...], keys: [레이어 키 30개], ngram: 5 }
// output: 문서별 평균 g-value 목록
function run(input) {
  const { docs, keys, ngram = 5 } = input;
  return docs.map((doc) => {
    let sum = 0, count = 0;
    for (let i = ngram - 1; i < doc.length; i++) {
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
    return count ? sum / count : 0;
  });
}
