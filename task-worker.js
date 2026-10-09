// SpareNode 작업 워커 - 코디네이터가 보낸 작업 코드를 받아 실행한다.
// 작업 코드는 `function run(input) { ... return output; }` 형태의 JS 문자열이다.
// 브라우저 워커 안에서만 돌아가므로 폰의 파일·다른 앱에는 접근할 수 없다.

const compiled = new Map(); // taskId -> run 함수

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'define') {
    try {
      // eslint-disable-next-line no-new-func
      const run = new Function(`"use strict";\n${m.code}\n;return typeof run === 'function' ? run : null;`)();
      if (!run) throw new Error('작업 코드에 run(input) 함수가 없습니다');
      compiled.set(m.taskId, run);
    } catch (err) {
      compiled.set(m.taskId, err);
    }
    return;
  }

  if (m.type === 'chunk') {
    const t0 = performance.now();
    try {
      const run = compiled.get(m.taskId);
      if (!run) throw new Error('작업 코드를 받지 못했습니다');
      if (run instanceof Error) throw run;
      const output = await run(m.input);
      self.postMessage({ type: 'result', jobId: m.jobId, chunkId: m.chunkId, output, ms: performance.now() - t0 });
    } catch (err) {
      self.postMessage({
        type: 'fail', jobId: m.jobId, chunkId: m.chunkId,
        error: String((err && err.message) || err), ms: performance.now() - t0,
      });
    }
  }
};
