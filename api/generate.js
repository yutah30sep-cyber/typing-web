// api/generate.js — APB対応・英語文生成（A/B=ランダム, P=個別化）
// 依存: npm i openai dotenv
// require('dotenv').config({ path: '.env.local' });

const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --------- ユーティリティ ----------
async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 英文スコア: 文字列(小文字＋空白)内のビグラム出現回数（weight対応）
function scoreSentence(text, transitions) {
  if (!text) return 0;
  const r = String(text).toLowerCase();
  let score = 0;
  for (const t of transitions || []) {
    const prev = (t.prev || '').toLowerCase();
    const cur  = (t.cur  || '').toLowerCase();
    if (!prev || !cur) continue;
    const w = Number(t.weight ?? 1);
    const bigram = prev + cur; // e.g., "th", "e "
    for (let i = 0; i < r.length - 1; i++) {
      if (r[i] + r[i+1] === bigram) score += w;
    }
  }
  return score;
}

function rerankAndPick(sentences, transitions, k) {
  const ranked = sentences
    .map(s => ({ text: s, _score: scoreSentence(s, transitions) }))
    .sort((a,b) => b._score - a._score);
  return ranked.slice(0, k).map(x => x.text);
}

// 英文のみ（a-z と空白、句読点なし）, 文頭大文字禁止・すべて小文字、長さ制約
function buildMessages({ phase, transitions, num_sentences, max_chars }) {
  const mustBigrams = Array.isArray(transitions)
    ? transitions.filter(t => t && t.prev && t.cur).map(t => (String(t.prev)+String(t.cur)).toLowerCase())
    : [];

  const system = `
You are a data generator for typing experiments.
Output strictly JSON with this schema:
{ "sentences": ["string", "string", ...] }

Hard constraints:
- Exactly ${num_sentences} sentences.
- Each sentence must be ALL LOWERCASE a–z and space only. NO punctuation, NO digits, NO symbols.
- Each sentence length <= ${max_chars} characters (including spaces).
- Sentences should be natural everyday English snippets but simplified (no proper nouns).
`.trim();

  // フェーズ別の指示（Pはターゲット遷移を多く含める）
  const phaseHint = (phase === 'P')
    ? `
Goal for personalization:
- Prefer sentences that include many of these bigrams (character pairs): ${JSON.stringify(mustBigrams)}
- Avoid repeating the same word unnaturally. Keep variety.
`
    : `
Goal for baseline:
- Sentences should be varied and not optimized for any particular bigram.
`;

  const user = `
phase=${phase}
num_sentences=${num_sentences}
max_chars=${max_chars}

${phaseHint}

Return ONLY a JSON object: { "sentences": ["...", "..."] }
Do NOT add explanations.
`.trim();

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user   }
  ];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const body = await readJson(req);
    // 期待ペイロード
    // { phase: 'A'|'P'|'B', num_sentences, max_chars_per_sentence, transitions?: [{prev,cur,weight,need,avoid}] }
    const phase = String(body.phase || 'A').toUpperCase();  // 'A','P','B'
    const N = Math.max(1, Number(body.num_sentences || 10));
    const CAND = Math.min(N * 3, 60); // 冗長に生成して後で絞る
    const maxChars = Math.max(10, Number(body.max_chars_per_sentence || 60));
    const transitions = Array.isArray(body.transitions) ? body.transitions : [];

    const messages = buildMessages({
      phase,
      transitions,
      num_sentences: CAND,
      max_chars: maxChars
    });

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: (phase === 'P') ? 0.6 : 0.8,
      // JSONモードを有効化して安定回収
      response_format: { type: "json_object" }
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('LLM JSON parse error');
    }
    let arr = Array.isArray(parsed?.sentences) ? parsed.sentences : [];
    // 正規化: すべて小文字と空白のみ・長さ制約
    arr = arr
      .map(s => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').trim())
      .filter(s => s && s.length <= maxChars);

    // Pなら rerank して上位N、A/Bならシャッフルして先頭N
    if (phase === 'P' && transitions.length) {
      arr = rerankAndPick(arr, transitions, N);
    } else {
      // シャッフル
      for (let i = arr.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      arr = arr.slice(0, N);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ sentences: arr }));
  } catch (err) {
    console.error('[api/generate] error:', err);
    const detail = (err && err.message) || String(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'internal_error', detail }));
  }
};
