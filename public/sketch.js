/* sketch.js — APB研究用（英語＋スペース、A/P/B、進捗、Pデバッグ、CSV/ZIP）
   フェーズ: START → A(ベースライン/LLMランダム) → REST(LLM待ち) → P(個別化) → REST(LLM待ち) → B(ベースライン/LLMランダム) → RESULT
   記録: (phase別に) attempts[27x27], errors[27x27], sumMs[27x27], cntMs[27x27]
   文字種: 英字 a-z と ' '（スペース）。内部表現は 27キー (A..Z + SPACE) のビグラム。
   可視: 進捗（何文中何文）、現在文の typed/残り、WPM(typing時間のみ)、ACC、P中のターゲット遷移リスト（デバッグ）
*/

const PHASES = { START:0, PLAY:1, REST:2, RESULT:3 };
let phase = PHASES.START;

const FLOW = ['A','P','B'];            // フェーズ記号
const COUNT_A = 30;                     // A文数（必要なら変更）
const COUNT_P = 30;                     // P文数（必要なら変更）
const COUNT_B = 30;                     // B文数（必要なら変更）
const MAX_CHARS = 60;                   // 文の最大文字数
const API_URL = '/api/generate';        // 生成API

const SHOW_P_DEBUG = false; // ← P中のデバッグ表示を出さない


// 文字→インデックス（A..Z=0..25, SPACE=26）
function chIdx(ch) {
  if (ch === ' ') return 26;
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 65 && c <= 90) return c - 65;
  return -1;
}
function idxCh(i) { return (i === 26) ? ' ' : String.fromCharCode(65 + i); }
const KEY_DIM = 27;

// ===== DOM =====
const $ = id => document.getElementById(id);
const DOM = {};
function bindDom(){
  ['btnStart','viewTitle','viewRest','viewPlay','viewResult',
   'txtKana','txtRoma','lblPhase','lblProgress','lblWpm','lblAcc',
   'restRemain','resultStats'].forEach(id=>DOM[id]=$(`${id}`));
  const missing = Object.entries(DOM).filter(([k,v]) => !v).map(([k])=>k);
  if (missing.length){
    console.error('Missing DOM:', missing);
    alert('HTMLの必要要素が不足しています: ' + missing.join(', '));
    noLoop();
  }
}

// ===== 状態 =====
let deck = [];        // 現在フェーズの文配列（文字列）
let deckIdx = 0;      // 文インデックス
let cur = null;       // Sentenceオブジェクト（下）
let flowIdx = 0;      // 0:A, 1:P, 2:B

// phase別ロギング
function makeMat(init){ return Array.from({length:KEY_DIM},()=>Array(KEY_DIM).fill(init)); }
function makePhaseLog(){
  return {
    attempts: makeMat(0),
    errors:   makeMat(0),
    sumMs:    makeMat(0),
    cntMs:    makeMat(0),
    typingMs: 0,
    typedChars: 0,
    totalAttempts: 0,
    totalErrors: 0
  };
}
const Logs = { A:makePhaseLog(), P:makePhaseLog(), B:makePhaseLog() };
let prevKeyIdx = -1, prevKeyTime = -1;
let lastTickMs = 0;

let debugTransitions = [];  // Pに送った遷移（画面表示用）

// ===== p5 =====
function setup(){
  noCanvas();
  bindDom();
  DOM.btnStart.addEventListener('click', onClickStart);
  toTitle();
  // --- 追加: シンプルな進捗バー要素を生成（HTMLの変更不要） ---
  if (!DOM._progWrap) {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    wrap.style.height = '6px';
    wrap.style.background = '#eee';
    wrap.style.borderRadius = '6px';
    wrap.style.overflow = 'hidden';

    const bar = document.createElement('div');
    bar.style.height = '100%';
    bar.style.width = '0%';           // 動的に更新
    bar.style.background = '#3a8b5c'; // 入力済み色
    bar.style.transition = 'width .08s linear';

    wrap.appendChild(bar);
    // 進捗ラベル（lblProgress）の直後に差し込み
    const row = DOM.viewPlay.querySelector('.row');
    if (row) row.after(wrap);

    DOM._progWrap = wrap;
    DOM._progBar = bar;
  }
}
function draw(){
  // PLAY中のみ経過（休憩時間除外）
  if (phase === PHASES.PLAY && cur) {
    const now = millis();
    if (lastTickMs) curPhaseLog().typingMs += (now - lastTickMs);
    lastTickMs = now;
  } else {
    lastTickMs = millis();
  }
}

// ===== 画面遷移 =====
function showView(v){
  DOM.viewTitle.style.display  = (v==='title')  ? '' : 'none';
  DOM.viewRest.style.display   = (v==='rest')   ? '' : 'none';
  DOM.viewPlay.style.display   = (v==='play')   ? '' : 'none';
  DOM.viewResult.style.display = (v==='result') ? '' : 'none';
}
function toTitle(){
  phase = PHASES.START; showView('title');
  DOM.lblPhase.textContent = '—';
  DOM.lblProgress.textContent = '—';
  DOM.txtKana.textContent = '';
  DOM.txtRoma.innerHTML = '';
  DOM.lblWpm.textContent = '—';
  DOM.lblAcc.textContent = '—';
}
function toRest(message){
  phase = PHASES.REST; showView('rest');
  DOM.restRemain.textContent = message || '…';
}
function toPlay(){
  phase = PHASES.PLAY; showView('play');
}
function toResult(){
  phase = PHASES.RESULT; showView('result');
  renderResult();
}

// ===== 進捗表示など =====
function setPhaseLabel(){
  const tag = FLOW[flowIdx];
  const name = (tag==='A')?'A (baseline)':(tag==='P')?'P (personalized)':'B (post-baseline)';
  DOM.lblPhase.textContent = name;
}
function setProgress(){
  DOM.lblProgress.textContent = `sentence ${deckIdx+1} / ${deck.length}`;
}
function renderSentence(){
  if (!cur) return;
  setPhaseLabel(); setProgress();

  // 上段：ターゲット全文（参照用）
  DOM.txtKana.textContent = cur.text;

  // 下段：入力進捗（入力済み=濃緑、キャレット=▌、未入力=薄灰）
  const done = cur.text.slice(0, cur.pos);
  const ahead = cur.text.slice(cur.pos);

  // 視認性を上げるため、未入力部分はやや薄く
  DOM.txtRoma.innerHTML =
    `<span style="color:#21684a">${escapeHtml(done)}</span>` +
    `<span style="color:#21684a;font-weight:700">▌</span>` +
    `<span style="color:#999">${escapeHtml(ahead)}</span>`;

  // WPM/ACC（フェーズ内）
  const log = curPhaseLog();
  const sec = Math.max(log.typingMs / 1000, 0.001);
  const wpm = (log.typedChars / 5) / (sec / 60);
  const acc = (log.totalAttempts>0)
    ? (1 - (log.totalErrors / log.totalAttempts))
    : 1;
  DOM.lblWpm.textContent = `WPM ≈ ${wpm.toFixed(1)}`;
  DOM.lblAcc.textContent = `Accuracy ${(acc*100).toFixed(1)}%`;

  // 文章内の位置を%で示すプログレスバー更新
  if (DOM._progBar) {
    const ratio = cur.len() ? (cur.pos / cur.len()) : 0;
    DOM._progBar.style.width = `${(ratio*100).toFixed(1)}%`;
  }

  // Pデバッグ: ターゲット遷移
// Pデバッグ: ターゲット遷移（OFF可）
if (SHOW_P_DEBUG && FLOW[flowIdx] === 'P' && debugTransitions.length) {
  const top = debugTransitions
    .slice(0, 20)
    .map(t => `${t.prev}${t.cur}${t.need?`×${t.need}`:''}${t.avoid?'[avoid]':''}`)
    .join(', ');
  DOM.lblProgress.textContent += `  [debug targets: ${top}]`;
}

}


// ===== Sentence =====
class Sentence {
  constructor(text){
    this.text = text; // すべて小文字＋空白
    this.pos = 0;     // 次に打つ位置
  }
  len(){ return this.text.length; }
  isDone(){ return this.pos >= this.text.length; }
  typeChar(ch){
    if (this.isDone()) return false;
    if (this.text[this.pos] === ch) { this.pos++; return true; }
    return false;
  }
}

// ===== フェーズ制御 =====
function curPhaseKey(){ return FLOW[flowIdx]; }
function curPhaseLog(){ return Logs[curPhaseKey()]; }

function onClickStart(){
  // A開始: LLMでランダム英文
  flowIdx = 0;
  resetAll();
  toRest('generating A sentences ...');
  requestLLM('A', COUNT_A).then(arr=>{
    startPlayWithDeck(arr);
  }).catch(err=>{
    alert('LLM(A)失敗: '+err.message);
    // 簡易フォールバック
    startPlayWithDeck(fallbackRandom(COUNT_A));
  });
}

function startPlayWithDeck(arr){
  deck = (arr && arr.length) ? arr : fallbackRandom(10);
  deckIdx = 0;
  cur = new Sentence(deck[deckIdx]);
  prevKeyIdx = -1; prevKeyTime = -1;
  toPlay();
  renderSentence();
}

function nextAfterDeck(){
  // 現在デッキ終了後の遷移
  const tag = FLOW[flowIdx];
  if (tag === 'A') {
    // A→P（個別化文をLLMで）
    toRest('personalizing ...');
    const transitions = buildTransitionsFromA();
    debugTransitions = transitions.slice(0).sort((a,b)=>b.weight-a.weight).slice(0,40);
    requestLLM('P', COUNT_P, transitions).then(arr=>{
      flowIdx = 1;
      startPlayWithDeck(arr);
    }).catch(err=>{
      console.warn('LLM(P)失敗', err);
      flowIdx = 1;
      startPlayWithDeck(fallbackRandom(COUNT_P));
    });
  } else if (tag === 'P') {
    // P→B（ふたたびランダム）
    toRest('generating B sentences ...');
    requestLLM('B', COUNT_B).then(arr=>{
      flowIdx = 2;
      startPlayWithDeck(arr);
    }).catch(err=>{
      console.warn('LLM(B)失敗', err);
      flowIdx = 2;
      startPlayWithDeck(fallbackRandom(COUNT_B));
    });
  } else {
    // B→RESULT
    toResult();
  }
}

// ===== 入力処理 =====
function keyPressed(){
  if (phase !== PHASES.PLAY || !cur) return;

  // p5の key は1文字 or 特殊。英字・空白以外は捨てる
  let c = key;
  if (typeof c !== 'string' || c.length !== 1) return;

  // 大文字小文字無視、タブ等は無視。スペースは' 'として扱う
  if (c === ' ') { /* ok */ }
  else {
    const cc = c.toLowerCase();
    if (cc < 'a' || cc > 'z') return;
    c = cc;
  }

  // ログ: 前ビグラム → 今キー
  const now = millis();
  const curIdx = chIdx(c === ' ' ? ' ' : c);
  const log = curPhaseLog();

  if (prevKeyIdx !== -1 && curIdx !== -1) {
    // attempts++
    log.attempts[prevKeyIdx][curIdx] += 1;
    log.totalAttempts += 1;

    // 時間
    if (prevKeyTime >= 0) {
      const dt = now - prevKeyTime;
      if (dt >= 0) { log.sumMs[prevKeyIdx][curIdx] += dt; log.cntMs[prevKeyIdx][curIdx] += 1; }
    }
  }

  const ok = cur.typeChar(c);
  if (!ok && prevKeyIdx !== -1 && curIdx !== -1) {
    log.errors[prevKeyIdx][curIdx] += 1;
    log.totalErrors += 1;
  }
  if (ok) {
    log.typedChars += 1;
  }

  prevKeyIdx = curIdx;
  prevKeyTime = now;

  renderSentence();

  if (cur.isDone()) {
    deckIdx++;
    if (deckIdx >= deck.length) {
      nextAfterDeck();
    } else {
      cur = new Sentence(deck[deckIdx]);
      prevKeyIdx = -1; prevKeyTime = -1;
      renderSentence();
    }
  }
}

// ===== LLM呼び出し =====
async function requestLLM(phaseTag, n, transitions){
  const body = {
    phase: phaseTag, // 'A'|'P'|'B'
    num_sentences: n,
    max_chars_per_sentence: MAX_CHARS
  };
  if (Array.isArray(transitions)) body.transitions = transitions;

  const res = await fetch(API_URL, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt);
  const json = JSON.parse(txt);
  const arr = Array.isArray(json?.sentences) ? json.sentences : [];
  if (!arr.length) throw new Error('no sentences');
  return arr;
}

// ===== Aの結果→P用ターゲット遷移 =====
function wilsonUpper(p, n, z=1.96){
  if (n <= 0) return 0;
  const denom = 1 + z*z/n;
  const center = (p + z*z/(2*n)) / denom;
  const radius = z*Math.sqrt((p*(1-p)+z*z/(4*n))/n)/denom;
  return center + radius;
}
function buildTransitionsFromA(){
  // 危なさ: Wilson上限(誤り率) と 平均遅延
  const A = Logs.A;
  // 正規化のため最大avg算出
  let maxAvg = 0;
  for (let i=0;i<KEY_DIM;i++) for (let j=0;j<KEY_DIM;j++){
    if (A.cntMs[i][j] > 0) {
      maxAvg = Math.max(maxAvg, A.sumMs[i][j] / A.cntMs[i][j]);
    }
  }
  if (maxAvg <= 0) maxAvg = 1;

  const edges = [];
  for (let i=0;i<KEY_DIM;i++) for (let j=0;j<KEY_DIM;j++){
    const att = A.attempts[i][j]; if (att < 3) continue;
    const err = A.errors[i][j];
    const p = att ? err/att : 0;
    const wU = wilsonUpper(p, att);
    const avg = A.cntMs[i][j] ? (A.sumMs[i][j] / A.cntMs[i][j]) : 0;
    const navg = Math.min(Math.max(avg/maxAvg, 0), 1);
    const w = 0.7*wU + 0.3*navg;
    if (w <= 0) continue;
    edges.push({ prev: idxCh(i).toLowerCase(), cur: idxCh(j).toLowerCase(), weight: +w.toFixed(4) });
  }

  // 避け対象（すごく易しい）
  const avoid = new Set();
  for (let i=0;i<KEY_DIM;i++) for (let j=0;j<KEY_DIM;j++){
    const att = A.attempts[i][j]; if (att < 5) continue;
    const err = A.errors[i][j]; const p = att ? err/att : 0;
    const avg = A.cntMs[i][j] ? (A.sumMs[i][j] / A.cntMs[i][j]) : Infinity;
    if (p <= 0.03 && avg < (maxAvg*0.6)) {
      avoid.add(idxCh(i).toLowerCase()+idxCh(j).toLowerCase());
    }
  }

  // need 配分（P文×5遷移を目標）
  const desiredTotalEdges = 5 * COUNT_P;
  const sumW = edges.reduce((a,e)=>a+e.weight, 0) || 1;
  for (const e of edges) {
    const base = (e.weight / sumW) * desiredTotalEdges;
    e.need = Math.max(0, Math.round(base));
    if (avoid.has(e.prev + e.cur)) e.avoid = true;
  }
  return edges;
}

// ===== フォールバック文（英語小文字＋スペースのみ） =====
function fallbackRandom(n){
  const stock = [
    'the cat is sleeping on the sofa',
    'we walk along the river at night',
    'a small bird rests on the fence',
    'they read a book under a tree',
    'music plays softly in the hall',
    'i make tea and sit by the lamp',
    'the door opens and we move on',
    'a bright star shines over town',
    'the dog is running in the yard',
    'we talk and laugh on the train',
    'a warm wind comes from the sea',
    'time flows like water in a stream',
    'please hold the line and wait',
    'the sun rises over the hill',
    'a child draws a house and a car',
  ].map(s=>s.toLowerCase().replace(/[^a-z ]/g,''));
  const out = [];
  for (let i=0;i<n;i++){
    out.push(stock[(Math.random()*stock.length)|0]);
  }
  return out;
}

// ===================
// 結果ビューの描画（ZIPのみ）
// ===================
function renderResult(summaryText) {
  // ここで showView は呼ばない（toResult() で showView('result') 済み）

  // 要約テキスト（未指定なら各フェーズのWPM/ACCを自動で出す）
  if (!summaryText) {
    const A = phaseStats(Logs.A);
    const P = phaseStats(Logs.P);
    const B = phaseStats(Logs.B);
    summaryText =
      `A: WPM=${A.wpm.toFixed(1)} ACC=${(A.acc*100).toFixed(1)}%  ` +
      `P: WPM=${P.wpm.toFixed(1)} ACC=${(P.acc*100).toFixed(1)}%  ` +
      `B: WPM=${B.wpm.toFixed(1)} ACC=${(B.acc*100).toFixed(1)}%`;
  }
  DOM.resultStats.textContent = summaryText;

  const legacyCsvBtn=DOM.viewResult.querySelector('#btnDownload, button[data-dl="csv"], .csv-only');
  if (legacyCsvBtn) legacyCsvBtn.remove();

  // ダウンロード領域（初回のみ生成）
  let area = document.getElementById('dlArea');
  if (!area) {
    area = document.createElement('div');
    area.id = 'dlArea';
    area.style.marginTop = '16px';
    area.className = 'center';
    DOM.viewResult.appendChild(area);

    // ZIPボタンのクリック（イベント委任）
    area.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-dl="zip"]');
      if (btn) downloadZipAll();
    });
  }

  // ZIPボタンのみ表示
  area.innerHTML = `<button class="btn" data-dl="zip">結果をZIPでダウンロード</button>`;
}



// ======================================
// 結果画面：ボタンのイベント委任ハンドラ
// ======================================
function onResultButtonsClick(e) {
  const btn = e.target.closest('button[data-dl]');
  if (!btn) return;
  const key = btn.getAttribute('data-dl');

  // ここはプロジェクト内の変数名に合わせてください。
  // 下記は一般的な命名例: attemptsA, errorsA, sumMsA, cntMsA など。
  const map = {
    'att-A': () => downloadCSV('attempts_A.csv', matrixToCSV(attemptsA)),
    'err-A': () => downloadCSV('errors_A.csv',   matrixToCSV(errorsA)),
    'avg-A': () => downloadCSV('avg_ms_A.csv',   avgMatrixToCSV(sumMsA, cntMsA)),

    'att-P': () => downloadCSV('attempts_P.csv', matrixToCSV(attemptsP)),
    'err-P': () => downloadCSV('errors_P.csv',   matrixToCSV(errorsP)),
    'avg-P': () => downloadCSV('avg_ms_P.csv',   avgMatrixToCSV(sumMsP, cntMsP)),

    'att-B': () => downloadCSV('attempts_B.csv', matrixToCSV(attemptsB)),
    'err-B': () => downloadCSV('errors_B.csv',   matrixToCSV(errorsB)),
    'avg-B': () => downloadCSV('avg_ms_B.csv',   avgMatrixToCSV(sumMsB, cntMsB)),

    'metrics': () => downloadCSV('tpm_accuracy_per_phase.csv', buildMetricsCSV()),

    'zip': () => downloadZipAll(), // JSZipを使って一括DL（任意）
  };

  const fn = map[key];
  if (fn) fn();
}


// ===== CSVユーティリティ =====
function matToCSV(mat){
  const header = ['prev\\cur', ...Array.from({length:KEY_DIM},(_,j)=>idxCh(j))];
  const lines = [header.join(',')];
  for (let i=0;i<KEY_DIM;i++){
    const row = [idxCh(i)];
    for (let j=0;j<KEY_DIM;j++) row.push(String(mat[i][j]));
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
function avgToCSV(sum,cnt){
  const header = ['prev\\cur', ...Array.from({length:KEY_DIM},(_,j)=>idxCh(j))];
  const lines = [header.join(',')];
  for (let i=0;i<KEY_DIM;i++){
    const row = [idxCh(i)];
    for (let j=0;j<KEY_DIM;j++){
      if (!cnt[i][j]) row.push('');
      else row.push((sum[i][j]/cnt[i][j]).toFixed(1));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}
function downloadCSV(filename, text){
  const blob = new Blob([text], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 0);
}

// ===== 指標 =====
function phaseStats(L){
  const sec = Math.max(L.typingMs/1000, 0.001);
  const wpm = (L.typedChars/5) / (sec/60);
  const acc = (L.totalAttempts>0) ? (1 - L.totalErrors/L.totalAttempts) : 1;
  return { wpm, acc };
}

// ===== 小物 =====
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function resetAll(){
  for (const k of ['A','P','B']) Logs[k] = makePhaseLog();
  prevKeyIdx = -1; prevKeyTime = -1; lastTickMs = 0; deck = []; deckIdx = 0; cur = null;
}

function loadScript(url){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + url));
    document.head.appendChild(s);
  });
}

async function ensureZipLibs(){
  if (!window.JSZip) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  }
  if (!window.saveAs) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js');
  }
}


async function downloadZipAll() {
  try {
    await ensureZipLibs();

    const zip = new JSZip();

    // 各フェーズの行列CSV
    zip.file('attempts_A.csv', matToCSV(Logs.A.attempts));
    zip.file('errors_A.csv',   matToCSV(Logs.A.errors));
    zip.file('avg_ms_A.csv',   avgToCSV(Logs.A.sumMs, Logs.A.cntMs));

    zip.file('attempts_P.csv', matToCSV(Logs.P.attempts));
    zip.file('errors_P.csv',   matToCSV(Logs.P.errors));
    zip.file('avg_ms_P.csv',   avgToCSV(Logs.P.sumMs, Logs.P.cntMs));

    zip.file('attempts_B.csv', matToCSV(Logs.B.attempts));
    zip.file('errors_B.csv',   matToCSV(Logs.B.errors));
    zip.file('avg_ms_B.csv',   avgToCSV(Logs.B.sumMs, Logs.B.cntMs));

    // 指標CSV
    zip.file('tpm_accuracy_per_phase.csv', buildMetricsCSV());

    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, 'typing_results.zip');
  } catch (e) {
    console.error('ZIP build error:', e);
    alert('ZIPの作成に失敗しました。コンソールをご確認ください。');
  }
}

function buildMetricsCSV() {
  const rows = [['phase','wpm','accuracy','typed_chars','typing_ms','total_attempts','total_errors']];
  for (const tag of ['A','P','B']) {
    const L = Logs[tag];
    const st = phaseStats(L);
    rows.push([
      tag,
      st.wpm.toFixed(2),
      (st.acc*100).toFixed(2),
      String(L.typedChars),
      String(Math.round(L.typingMs)),
      String(L.totalAttempts),
      String(L.totalErrors),
    ]);
  }
  return rows.map(r=>r.join(',')).join('\n');
}
