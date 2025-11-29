// metrics.js
export const KEYSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ-";
export const K = KEYSET.length; // 27

export const attempts = Array.from({length:K},()=>Array(K).fill(0));
export const errors   = Array.from({length:K},()=>Array(K).fill(0));
export const sumMs    = Array.from({length:K},()=>Array(K).fill(0));
export const cntMs    = Array.from({length:K},()=>Array(K).fill(0));

let prevIdx = -1;
let prevTime = -1;

export function keyIndex(ch){
  return KEYSET.indexOf(ch.toUpperCase());
}
export function logKeyPress(ch, isCorrect){
  const cur = keyIndex(ch); if (cur<0) return;
  const now = performance.now();

  if (prevIdx >= 0){
    attempts[prevIdx][cur]++;
    if (!isCorrect) errors[prevIdx][cur]++;
    if (prevTime >= 0){
      const dt = now - prevTime;
      if (dt >= 0){ sumMs[prevIdx][cur] += dt; cntMs[prevIdx][cur]++; }
    }
  }
  prevIdx = cur; prevTime = now;
}

export function resetMetrics(){
  for (let i=0;i<K;i++) for (let j=0;j<K;j++){
    attempts[i][j]=errors[i][j]=cntMs[i][j]=0; sumMs[i][j]=0;
  }
  prevIdx = -1; prevTime = -1;
}
