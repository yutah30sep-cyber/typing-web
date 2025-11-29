// romaji.js — かな→ローマ字（複数バリアント対応）＋タイピングバッファ
export const LONG_VOWEL_KEY = '-';

// ====== マッピング（最小一式。必要に応じて拡張） ======

// 拗音（2文字）
const DIGRAPHS = {
  'きゃ': ['KYA'],
  'きゅ': ['KYU'],
  'きょ': ['KYO'],

  'しゃ': ['SHA','SYA'],
  'しゅ': ['SHU','SYU'],
  'しょ': ['SHO','SYO'],

  'ちゃ': ['CHA','TYA'],
  'ちゅ': ['CHU','TYU'],
  'ちょ': ['CHO','TYO'],

  'じゃ': ['JA','ZYA','JYA'],
  'じゅ': ['JU','ZYU','JYU'],
  'じょ': ['JO','ZYO','JYO'],

  'にゃ': ['NYA'], 'にゅ': ['NYU'], 'にょ': ['NYO'],
  'ひゃ': ['HYA'], 'ひゅ': ['HYU'], 'ひょ': ['HYO'],
  'みゃ': ['MYA'], 'みゅ': ['MYU'], 'みょ': ['MYO'],
  'りゃ': ['RYA'], 'りゅ': ['RYU'], 'りょ': ['RYO'],
  'ぎゃ': ['GYA'], 'ぎゅ': ['GYU'], 'ぎょ': ['GYO'],
  'びゃ': ['BYA'], 'びゅ': ['BYU'], 'びょ': ['BYO'],
  'ぴゃ': ['PYA'], 'ぴゅ': ['PYU'], 'ぴょ': ['PYO'],
};

// 単独（1文字）
const MONO = {
  'あ':['A'],'い':['I'],'う':['U'],'え':['E'],'お':['O'],
  'か':['KA'],'き':['KI'],'く':['KU'],'け':['KE'],'こ':['KO'],
  'さ':['SA'],'し':['SI','SHI'],'す':['SU'],'せ':['SE'],'そ':['SO'],
  'た':['TA'],'ち':['TI','CHI'],'つ':['TU','TSU'],'て':['TE'],'と':['TO'],
  'な':['NA'],'に':['NI'],'ぬ':['NU'],'ね':['NE'],'の':['NO'],
  'は':['HA'],'ひ':['HI'],'ふ':['FU','HU'],'へ':['HE'],'ほ':['HO'],
  'ま':['MA'],'み':['MI'],'む':['MU'],'め':['ME'],'も':['MO'],
  'や':['YA'],'ゆ':['YU'],'よ':['YO'],
  'ら':['RA'],'り':['RI'],'る':['RU'],'れ':['RE'],'ろ':['RO'],
  'わ':['WA'],'を':['WO'],'ん':['N'],
  'が':['GA'],'ぎ':['GI'],'ぐ':['GU'],'げ':['GE'],'ご':['GO'],
  'ざ':['ZA'],'じ':['JI','ZI'],'ず':['ZU'],'ぜ':['ZE'],'ぞ':['ZO'],
  'だ':['DA'],'ぢ':['JI','DI'],'づ':['ZU','DU'],'で':['DE'],'ど':['DO'],
  'ば':['BA'],'び':['BI'],'ぶ':['BU'],'べ':['BE'],'ぼ':['BO'],
  'ぱ':['PA'],'ぴ':['PI'],'ぷ':['PU'],'ぺ':['PE'],'ぽ':['PO'],
};

// ====== ユーティリティ ======
function isSmallYaYuYo(c){ return c==='ゃ'||c==='ゅ'||c==='ょ'; }
function isVowel(ch){ return 'AEIOU'.includes(ch); }

// 促音「っ」→ 次トークンの先頭子音を重ねる（CH/SH/J の特殊も考慮）
function geminate(form){
  const up = form.toUpperCase();
  if (up.startsWith('CH')) return 'C' + up;    // っ+ちゃ → C H A...
  if (up.startsWith('SH')) return 'S' + up;
  if (up.startsWith('J'))  return 'J' + up;
  const head = up[0];
  return isVowel(head) ? up : head + up;
}

// 「ん」+ 次が母音 or Y → NN を追加許可
function addNNIfNeeded(tokens){
  for (let i=0;i<tokens.length;i++){
    const t = tokens[i];
    if (t.kana==='ん'){
      const next = tokens[i+1]?.variants?.[0] ?? '';
      const head = next ? next[0] : '';
      if ('AEIOUY'.includes(head)){
        if (!t.variants.includes('NN')) t.variants.push('NN');
      }
    }
  }
}

// ====== トークン化 ======
function tokenize(kana){
  const toks = [];
  for (let i=0;i<kana.length;i++){
    const a = kana[i];

    // 拗音
    if (i+1<kana.length){
      const dig = a + kana[i+1];
      if (DIGRAPHS[dig]){
        // 直前が促音「っ」なら重子音だけに置換
        const vars = DIGRAPHS[dig].map(v => v);
        if (i>0 && kana[i-1]==='っ'){
          for (let k=0;k<vars.length;k++) vars[k] = geminate(vars[k]);
        }
        toks.push({ kana: dig, variants: [...new Set(vars)], chosen: 0 });
        i++; // 2文字消費
        continue;
      }
    }

    // 促音はスキップ（次トークンへ反映）
    if (a === 'っ') continue;

    // 通常1文字
    if (MONO[a]){
      let vars = MONO[a].map(v => v);
      if (i>0 && kana[i-1]==='っ'){
        vars = vars.map(v => geminate(v));
      }
      toks.push({ kana: a, variants: [...new Set(vars)], chosen: 0 });
    }
  }

  addNNIfNeeded(toks);
  return toks;
}

// ====== タイピングバッファ（複数バリアント対応） ======
export class TypingBuffer {
  constructor(kana){
    this.tokens = tokenize(kana);
    this.tokenIndex = 0;
    this.inPos = 0;
  }
  isCompleted(){ return this.tokenIndex >= this.tokens.length; }
  shownRomaji(){
    // 現在の chosen を連結して見せる
    return this.tokens.map(t => t.variants[t.chosen]).join('');
  }
  expectedKeys(){
    const set = new Set();
    if (this.isCompleted()) return set;
    const t = this.tokens[this.tokenIndex];
    for (const v of t.variants){
      if (this.inPos < v.length) set.add(v[this.inPos]);
    }
    return set;
  }
  typeKey(ch){
    if (this.isCompleted()) return false;
    const t = this.tokens[this.tokenIndex];
    const cur = t.variants[t.chosen];

    // まず現行バリアント
    if (this.inPos < cur.length && cur[this.inPos] === ch){
      this.inPos++;
      if (this.inPos >= cur.length){ this.tokenIndex++; this.inPos = 0; }
      return true;
    }
    // 他バリアントに切り替え
    for (let i=0;i<t.variants.length;i++){
      const v = t.variants[i];
      if (this.inPos < v.length && v[this.inPos] === ch){
        t.chosen = i;
        this.inPos++;
        if (this.inPos >= v.length){ this.tokenIndex++; this.inPos = 0; }
        return true;
      }
    }
    return false;
  }
}

// 既存（単一表記表示が必要な時用）
export function kanaToRomaShown(kana){
  return tokenize(kana).map(t => t.variants[0]).join('');
}
