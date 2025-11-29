// matrix.js — 遷移マトリクスの描画とCSV保存
import { KEYSET, K, attempts, errors, sumMs, cntMs } from './metrics.js';

export function renderMatrix(initialTab = 'attempts') {
  // 既存があれば再利用
  let host = document.getElementById('matrix-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'matrix-host';
    Object.assign(host.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.35)',
      display: 'grid', placeItems: 'center', zIndex: 9999
    });
    document.body.appendChild(host);
  } else {
    host.innerHTML = '';
    host.style.display = 'grid';
  }

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(1024px, 92vw)', maxHeight: '88vh', overflow: 'auto',
    background: '#fff', borderRadius: '16px', padding: '16px 16px 20px',
    boxShadow: '0 10px 30px rgba(0,0,0,.25)', fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto'
  });

  const head = document.createElement('div');
  head.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px">
      <div style="display:flex;gap:8px;align-items:center">
        <strong style="font-size:18px">Transition Matrix</strong>
        <button data-tab="attempts" class="m-tab">Attempts</button>
        <button data-tab="errors"   class="m-tab">Errors</button>
        <button data-tab="avg"      class="m-tab">Avg(ms)</button>
      </div>
      <div style="display:flex;gap:8px">
        <button id="m-csv">CSV保存</button>
        <button id="m-close">閉じる</button>
      </div>
    </div>
  `;
  panel.appendChild(head);

  const grid = document.createElement('div');
  panel.appendChild(grid);

  host.appendChild(panel);

  // 共通スタイル
  panel.querySelectorAll('button').forEach(b => {
    Object.assign(b.style, {
      padding: '8px 12px', borderRadius: '8px', border: '1px solid #ddd', background: '#fff', cursor: 'pointer'
    });
  });

  function cellColor01(t, hot = [220,60,60]) {
    // t: 0..1 -> 白〜赤
    const r = Math.round(255 + (hot[0]-255)*t);
    const g = Math.round(255 + (hot[1]-255)*t);
    const b = Math.round(255 + (hot[2]-255)*t);
    return `rgb(${r},${g},${b})`;
  }

  function draw(tab) {
    grid.innerHTML = '';

    // タブ選択スタイル
    panel.querySelectorAll('.m-tab').forEach(btn => {
      btn.style.background = (btn.dataset.tab === tab) ? '#eef7ff' : '#fff';
    });

    // 最大値の算出
    let maxVal = 1;
    if (tab === 'attempts') {
      for (let i=0;i<K;i++) for (let j=0;j<K;j++) maxVal = Math.max(maxVal, attempts[i][j]);
    } else if (tab === 'errors') {
      for (let i=0;i<K;i++) for (let j=0;j<K;j++) maxVal = Math.max(maxVal, errors[i][j]);
    } else {
      for (let i=0;i<K;i++) for (let j=0;j<K;j++) {
        if (cntMs[i][j] > 0) {
          const v = sumMs[i][j] / cntMs[i][j];
          maxVal = Math.max(maxVal, v);
        }
      }
    }

    // テーブル
    const table = document.createElement('table');
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '13px';
    const thead = document.createElement('thead');
    const tr0 = document.createElement('tr');

    // corner
    const th0 = document.createElement('th');
    th0.textContent = 'prev \\ cur';
    Object.assign(th0.style, { position:'sticky', top:'0', left:'0', zIndex:2, background:'#fff', padding:'6px', border:'1px solid #ddd' });
    tr0.appendChild(th0);

    // headers
    for (let j=0;j<K;j++) {
      const th = document.createElement('th');
      th.textContent = KEYSET[j];
      Object.assign(th.style, { position:'sticky', top:'0', background:'#fff', padding:'6px 8px', border:'1px solid #ddd' });
      tr0.appendChild(th);
    }
    thead.appendChild(tr0);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i=0;i<K;i++) {
      const tr = document.createElement('tr');

      const th = document.createElement('th');
      th.textContent = KEYSET[i];
      Object.assign(th.style, { position:'sticky', left:'0', zIndex:1, background:'#fff', padding:'6px 8px', border:'1px solid #ddd' });
      tr.appendChild(th);

      for (let j=0;j<K;j++) {
        let v = 0, has = true, label = '';
        if (tab === 'attempts') {
          v = attempts[i][j]; label = String(v);
        } else if (tab === 'errors') {
          v = errors[i][j]; label = String(v);
        } else {
          if (cntMs[i][j] === 0) { has = false; label = ''; v = 0; }
          else { v = sumMs[i][j] / cntMs[i][j]; label = v.toFixed(0); }
        }
        const t = has ? Math.min(1, v / maxVal) : 0;

        const td = document.createElement('td');
        Object.assign(td.style, {
          padding: '6px 8px', border:'1px solid #ddd',
          background: has ? cellColor01(t) : '#f1f1f1', textAlign: 'right', minWidth: '36px'
        });
        td.title = `${KEYSET[i]} → ${KEYSET[j]} : ${label}`;
        td.textContent = label;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    grid.appendChild(table);
  }

  draw(initialTab);

  panel.querySelector('#m-close').onclick = () => { host.style.display = 'none'; };
  panel.querySelectorAll('.m-tab').forEach(btn => {
    btn.onclick = () => draw(btn.dataset.tab);
  });
  panel.querySelector('#m-csv').onclick = () => downloadCSVs();
}

export function downloadCSVs() {
  const head = ['prev\\cur', ...KEYSET];

  function save(name, rows) {
    const blob = new Blob([rows.join('\n')], { type:'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // attempts.csv
  {
    const rows = [head.join(',')];
    for (let i=0;i<K;i++) {
      const r = [KEYSET[i]];
      for (let j=0;j<K;j++) r.push(String(attempts[i][j]));
      rows.push(r.join(','));
    }
    save('attempts.csv', rows);
  }

  // errors.csv
  {
    const rows = [head.join(',')];
    for (let i=0;i<K;i++) {
      const r = [KEYSET[i]];
      for (let j=0;j<K;j++) r.push(String(errors[i][j]));
      rows.push(r.join(','));
    }
    save('errors.csv', rows);
  }

  // avg_ms.csv
  {
    const rows = [head.join(',')];
    for (let i=0;i<K;i++) {
      const r = [KEYSET[i]];
      for (let j=0;j<K;j++) {
        const v = cntMs[i][j] ? (sumMs[i][j] / cntMs[i][j]).toFixed(1) : '';
        r.push(v);
      }
      rows.push(r.join(','));
    }
    save('avg_ms.csv', rows);
  }
}
