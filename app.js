// SpareNode - 1단계: 화면만. 벤치마크·코디네이터 연결은 2단계에서 추가.
// 지금은 '이 기기' 칸에 브라우저가 알려 주는 기본 정보만 채운다.

document.getElementById('specCores').textContent =
  navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency}개` : '알 수 없음';

// deviceMemory는 Chrome만 제공하고, 개인정보 보호로 최대 8GB까지만 알려 준다
document.getElementById('specMem').textContent =
  navigator.deviceMemory ? `${navigator.deviceMemory}GB 이상` : '알 수 없음';

const gpuEl = document.getElementById('specGpu');
if (!('gpu' in navigator)) {
  gpuEl.textContent = window.isSecureContext ? '미지원' : '미지원 (https 필요)';
} else {
  navigator.gpu.requestAdapter()
    .then(adapter => { gpuEl.textContent = adapter ? '사용 가능' : '어댑터 없음'; })
    .catch(() => { gpuEl.textContent = '오류'; });
}

if (navigator.getBattery) {
  navigator.getBattery().then(b => {
    const show = () => {
      document.getElementById('specBattery').textContent =
        `${Math.round(b.level * 100)}%${b.charging ? ' 충전 중' : ''}`;
    };
    show();
    b.addEventListener('levelchange', show);
    b.addEventListener('chargingchange', show);
  });
}
