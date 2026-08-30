'use strict';
/* 音楽棚 — pCloud の音楽をブラウザだけで聴く。
   マウントは一切使わない。すべて pCloud の HTTP API 経由。 */

/* ============ 小道具 ============ */
const $  = s => document.querySelector(s);
const main = () => $('#main');
/* 入口（worker）から配られているときは、pCloud の秘密はこちらに降りてこない。
   一覧も曲の場所も入口に頼む。github.io から直接開いたときは従来どおり。 */
const GATE = !/(^|\.)github\.io$/.test(location.hostname) && location.protocol === 'https:';
async function gate(path) {
  const r = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new PCloudError(j.result || -10, j.error || ('入口が ' + r.status));
  return j;
}

const AUDIO_EXT = new Set(['mp3','m4a','aac','flac','wav','ogg','opus','aiff','aif','wma','m4b']);
const IMAGE_EXT = new Set(['jpg','jpeg','png','webp','gif']);
const COVER_NAMES = ['cover','folder','front','albumart','album','jacket','ジャケット'];

const ext = n => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '');
const isAudio = n => AUDIO_EXT.has(ext(n));
const isImage = n => IMAGE_EXT.has(ext(n));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
}
async function sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 曲順は「01」「1-02」を数として見る。文字列順だと 10 が 2 より前に来る。 */
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

/* ============ 保存領域 ============ */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pm.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    try { localStorage.setItem('pm.' + k, JSON.stringify(v)); return true; }
    catch (e) { LS.full = true; return false; }   /* 溢れたら黙らせない */
  },
  del(k)    { try { localStorage.removeItem('pm.' + k); } catch (e) {} },
};

const S = {
  host:   LS.get('host', 'api.pcloud.com'),
  auth:   LS.get('auth', ''),
  email:  LS.get('email', ''),
  rootId: LS.get('rootId', null),
  rootName: LS.get('rootName', ''),
  albums: [],          // 走査結果（メモリ）
  covers: LS.get('covers', {}),   // { folderid: {url, src, q, cands:[{url,label}], manual} }
  offline: LS.get('offline', {}), // { fileid: 1 }
  meta:   LS.get('meta', {}),     // { folderid: {g:ジャンル, y:年} }
  fav:    LS.get('fav', {}),      // { 'a'+folderid | 't'+fileid : 1 }
  hist:   LS.get('hist', []),     // [{a:アルバム, t:曲, at:時刻}] 新しい順
  plays:  LS.get('plays', {}),    // { folderid: {n:回数, last:時刻} }
  lists:  LS.get('lists', {}),    // { 名前: [{a:folderid, t:fileid}] }
  filter: LS.get('filter', 'all'),
  genre:  LS.get('genre', ''),
  sort:   LS.get('sort', 'artist'),
  cell:   LS.get('cell', 'm'),      // ジャケットの大きさ 小・中・大
  deco:   LS.get('deco', true),     // 音が読めないとき、飾りとして動かすか
  meter:  LS.get('meter', 'wave'),  // レベル計の見た目
  mood:   LS.get('mood', {}),       // { folderid: {bpm, gain, tag, hand:[手で付けた札]} }
  vol:    LS.get('vol', 1),         // 音量。端末ごとに覚える
  code:   LS.get('code', ''),       // 共有リンクの符号。これがあれば合鍵なしで読める
  linkpw: LS.get('linkpw', ''),     // 共有リンクに合言葉が掛かっている場合
  relay:  LS.get('relay', ''),      // 中継所のURL（符号が使えないときの逃げ道）
  pub:    LS.get('pub', false),     // 公開リンク経由にするか
  sweep:  null,
};
const saveMeta  = () => LS.set('meta', S.meta);
const saveFav   = () => LS.set('fav', S.fav);
const savePlays = () => LS.set('plays', S.plays);
const saveLists = () => LS.set('lists', S.lists);
const saveMood  = () => LS.set('mood', S.mood);
const saveHist  = () => LS.set('hist', S.hist.slice(0, 400));
const isFav = k => !!S.fav[k];
function toggleFav(k) { if (S.fav[k]) delete S.fav[k]; else S.fav[k] = 1; saveFav(); }
const albumYear  = al => (S.meta[al.id] || {}).y || '';
const albumGenre = al => (S.meta[al.id] || {}).g || '';
const playCount  = al => (S.plays[al.id] || {}).n || 0;
const lastPlayed = al => (S.plays[al.id] || {}).last || 0;
/* 何が起きたかの控え。画面が消えても残るので、後から読み返せる。
   パスワードやメールの中身は絶対に残さない（長さだけ）。 */
function note(what) {
  try {
    const a = LS.get('log', []);
    a.push(new Date().toLocaleTimeString('ja-JP') + ' ' + what);
    LS.set('log', a.slice(-15));
  } catch (e) {}
}
const readLog = () => (LS.get('log', []).join('\n') || '（記録なし）');

const saveCovers  = () => LS.set('covers', S.covers);
const saveOffline = () => LS.set('offline', S.offline);

/* ============ pCloud API ============ */
class PCloudError extends Error {
  constructor(code, msg) { super(msg || ('pCloud error ' + code)); this.code = code; }
}
async function api(method, params = {}, host, ms = 25000) {
  const u = new URL('https://' + (host || S.host) + '/' + method);
  if (S.auth && !('username' in params)) u.searchParams.set('auth', S.auth);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  /* 返事が来ないまま黙って待ち続けると、画面が固まったようにしか見えない。必ず時間を切る。
     abort が握り潰される環境があるので（実測）、中断要求とは別に時計と競争させて決着をつける。 */
  const ac = new AbortController();
  let timer;
  const clock = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch (e) {}
      rej(new PCloudError(-3, 'pCloud からの返事がありません（' + Math.round(ms / 1000) + '秒待ちました）'));
    }, ms);
  });
  let r;
  try { r = await Promise.race([fetch(u, { cache: 'no-store', signal: ac.signal, referrerPolicy: 'no-referrer' }), clock]); }
  catch (e) {
    if (e instanceof PCloudError) throw e;
    throw new PCloudError(-4, 'pCloud につながりません（通信が遮られている可能性）');
  }
  finally { clearTimeout(timer); }
  if (!r.ok) throw new PCloudError(-1, 'HTTP ' + r.status);
  const j = await r.json();
  if (j.result !== 0) throw new PCloudError(j.result, j.error);
  return j;
}
/* 共有リンクの符号で呼ぶ。合鍵と違って Origin で弾かれない。
   耳読が Mac 無しで鳴るのはこの道を通っているから。 */
let memCode = null;      /* 入口からもらった符号。保存しない。閉じれば消える。 */
async function getCode() {
  if (memCode) return memCode;
  const g = await gate('/api/code');
  memCode = { code: g.code, linkpw: g.linkpw || '' };
  if (g.host) S.host = g.host;
  note('入口から符号を受け取った（保存しない）');
  return memCode;
}
async function apiPub(method, params = {}, ms = 25000) {
  const cd = GATE ? await getCode() : { code: S.code, linkpw: S.linkpw };
  const u = new URL('https://' + S.host + '/' + method);
  u.searchParams.set('code', cd.code);
  if (cd.linkpw) u.searchParams.set('linkpassword', cd.linkpw);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const ac = new AbortController();
  let timer;
  const clock = new Promise((_, rej) => {
    timer = setTimeout(() => { try { ac.abort(); } catch (e) {} 
      rej(new PCloudError(-3, 'pCloud からの返事がありません')); }, ms);
  });
  let r;
  try { r = await Promise.race([fetch(u, { cache: 'no-store', signal: ac.signal, referrerPolicy: 'no-referrer' }), clock]); }
  catch (e) { if (e instanceof PCloudError) throw e; throw new PCloudError(-4, 'pCloud につながりません'); }
  finally { clearTimeout(timer); }
  const j = await r.json();
  if (j.result !== 0) throw new PCloudError(j.result, j.error);
  return j;
}

/* 画像は API に auth を載せた URL をそのまま <img> に渡す（往復が1回で済む） */
const thumbUrl = (fileid, px) =>
  'https://' + S.host + '/getthumb?fileid=' + fileid + '&size=' + px + 'x' + px +
  '&crop=1&type=auto&auth=' + encodeURIComponent(S.auth);

async function login(email, password, say = () => {}) {
  if (!(window.crypto && crypto.subtle)) {
    throw new PCloudError(-5, 'この開き方では暗号が使えません。https:// で開いてください');
  }
  /* pCloud は合鍵（auth）の渡し方が一通りではない。
     実機で「認証は通って userinfo が丸ごと返るのに auth だけ無い」状態を踏んだので、
     符丁での取り方を先に試し、駄目なら pCloud が公式に認めている渡し方に降りる。
     いずれも宛先は pcloud.com だけ。パスワードは端末にも控えにも残さない。 */
  let lastErr = null, gotInfo = false;
  for (const host of ['api.pcloud.com', 'eapi.pcloud.com']) {
    let dg;
    try {
      say(host + ' に問い合わせています…');
      dg = await api('getdigest', {}, host);
    } catch (e) { lastErr = e; note('符丁がもらえない @ ' + host + ' code=' + e.code); continue; }
    const pd = await sha1hex(password + (await sha1hex(email.toLowerCase())) + dg.digest);
    const tries = [
      ['userinfo', { getauth: 1, username: email, digest: dg.digest, passworddigest: pd }, '符丁'],
      ['login',    { getauth: 1, username: email, digest: dg.digest, passworddigest: pd }, '符丁 / login'],
      ['userinfo', { getauth: 1, username: email, password: password },                    '暗号化した通信で直接'],
      ['login',    { getauth: 1, username: email, password: password },                    '暗号化した通信で直接 / login'],
    ];
    let badCreds = false;
    for (const [m, params, label] of tries) {
      try {
        say(label + ' で合鍵をもらっています…');
        const r = await api(m, params, host);
        if (r.auth) {
          S.host = host; S.auth = r.auth; S.email = r.email || email;
          LS.set('host', host); LS.set('auth', r.auth); LS.set('email', S.email);
          note('合鍵が取れた: ' + label + ' @ ' + host);
          return r;
        }
        gotInfo = true;
        note('合鍵なし: ' + label + ' @ ' + host + '（項目' + Object.keys(r).length + '個）');
        lastErr = new PCloudError(-6, 'pCloud が合鍵を返しませんでした');
      } catch (e) {
        lastErr = e;
        note('駄目: ' + label + ' @ ' + host + ' code=' + e.code);
        if (e.code === 2000 || e.code === 1000) { badCreds = true; break; }   /* 地域違いか資格情報違い */
      }
    }
    if (!badCreds && gotInfo) break;   /* 認証は通っている。別の地域を試しても同じ */
  }
  if (gotInfo) throw new PCloudError(-6,
    'pCloud に入れましたが、合鍵をもらえませんでした（試した渡し方すべて）');
  throw lastErr || new PCloudError(-7, 'つながりません');
}

function logout() {
  ['auth', 'email', 'rootId', 'rootName', 'covers', 'offline', 'code', 'linkpw'].forEach(LS.del);
  Object.assign(S, { auth: '', email: '', code: '', linkpw: '',
                     rootId: null, rootName: '', albums: [], covers: {}, offline: {} });
}

/* ============ ライブラリ走査 ============ */
/* 1回の recursive listfolder で棚を組み立てる。
   folderid を鍵にするので、macOS の NFD と NFC の食い違いを踏まない。 */
function walk(node, trail, out) {
  const here = node.name ? trail.concat(node.name) : trail;
  const kids = node.contents || [];
  const tracks = kids.filter(c => !c.isfolder && isAudio(c.name)).sort(byName);
  if (tracks.length) {
    const imgs = kids.filter(c => !c.isfolder && isImage(c.name));
    const named = imgs.find(c => COVER_NAMES.includes(c.name.slice(0, c.name.lastIndexOf('.')).toLowerCase()));
    out.push({
      id: node.folderid,
      name: node.name || '(最上位)',
      artist: here.length > 1 ? here[here.length - 2] : '',
      path: here.join(' / '),
      tracks: tracks.map(t => ({ id: t.fileid, name: t.name, size: t.size })),
      folderCover: (named || imgs[0] || null) && (named || imgs[0]).fileid,
    });
  }
  for (const c of kids) if (c.isfolder) walk(c, here, out);
}
async function scanLibrary(folderid) {
  /* 符号があれば、共有リンクの中身が丸ごと降ってくる。folderid も合鍵も要らない。 */
  const r = (GATE || S.code) ? await apiPub('showpublink', { recursive: 1 })
                             : await api('listfolder', { folderid, recursive: 1 });
  const out = [];
  walk(r.metadata, [], out);
  out.sort((a, b) => collator.compare(a.artist + a.name, b.artist + b.name));
  return out;
}

/* ============ ジャケット ============ */
/* サイトを見て回らない。鍵の要らない JSON API を決まった順に叩くだけ。
   iTunes → Deezer(JSONP) の2段。ここで 95% 付く。残りは手で選ぶ。 */
const artUrl = (u, px) => u.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/' + px + 'x' + px + 'bb.jpg');

let itunesDelay = 320;          // iTunes は取りすぎると 403 を返す。様子を見て伸ばす。
let itunesNext  = 0;
async function itunesGate() {
  const wait = itunesNext - Date.now();
  if (wait > 0) await sleep(wait);
  itunesNext = Date.now() + itunesDelay;
}
async function itunesSearch(term, limit = 8, country = 'JP') {
  await itunesGate();
  const u = 'https://itunes.apple.com/search?media=music&entity=album&country=' + country +
            '&limit=' + limit + '&term=' + encodeURIComponent(term);
  const r = await fetch(u);
  if (r.status === 403 || r.status === 429) {
    itunesDelay = Math.min(itunesDelay * 1.6, 4000);
    itunesNext = Date.now() + 20000;
    throw new PCloudError(-2, 'iTunes 側で待たされている');
  }
  if (!r.ok) throw new PCloudError(-1, 'iTunes HTTP ' + r.status);
  const j = await r.json();
  return (j.results || []).filter(x => x.artworkUrl100).map(x => ({
    url: artUrl(x.artworkUrl100, 1200),
    thumb: artUrl(x.artworkUrl100, 300),
    n: x.trackCount || 0,
    g: x.primaryGenreName || '',
    y: (x.releaseDate || '').slice(0, 4),
    label: (x.artistName || '') + ' / ' + (x.collectionName || ''),
    src: 'iTunes/' + country,
  }));
}
let jsonpSeq = 0;
function deezerSearch(term, limit = 8) {
  return new Promise(resolve => {
    const cb = 'dz' + (++jsonpSeq);
    const s = document.createElement('script');
    const done = res => {
      delete window[cb]; s.remove(); clearTimeout(tm); resolve(res);
    };
    const tm = setTimeout(() => done([]), 6000);
    window[cb] = j => done(((j && j.data) || []).filter(a => a.cover_xl).map(a => ({
      url: a.cover_xl,
      thumb: a.cover_medium || a.cover_xl,
      n: a.nb_tracks || 0,
      label: ((a.artist && a.artist.name) || '') + ' / ' + (a.title || ''),
      src: 'Deezer',
    })).slice(0, limit));
    s.onerror = () => done([]);
    s.src = 'https://api.deezer.com/search/album?output=jsonp&callback=' + cb +
            '&limit=' + limit + '&q=' + encodeURIComponent(term);
    document.body.appendChild(s);
  });
}
/* 親フォルダが「洋楽」のような棚の名前のとき、それを検索語に入れると別の盤を掴む。 */
const GENRE_WORDS = new Set(['洋楽','邦楽','サントラ','サウンドトラック','ost','クラシック','ジャズ','jazz','ロック','rock',
  'ポップス','pop','アニメ','非音楽','音楽','music','その他','未整理','アルバム','albums','マイミュージック',
  'various','va','compilation','オムニバス','ベスト','best']);
const cleanName = s => String(s || '')
  .replace(/^[★☆♪●○▶\d\s._-]+/, '')
  .replace(/[\[\(【（][^\]\)】）]*[\]\)】）]/g, ' ')      // (Disc 1) [FLAC] は邪魔
  .replace(/\s+/g, ' ').trim();

/* フォルダ名は「アーティスト - アルバム」の形が多い。分けずに丸ごと照合すると、
   同じ言葉を含むトリビュート盤を掴む（実測で踏んだ）。 */
const artOf = c => {
  if (!c || !c.label) return '';
  const i = c.label.indexOf(' / ');
  return i < 0 ? '' : c.label.slice(0, i);
};
/* 表示に使うアーティスト名。親フォルダが「洋楽」のような棚の名前のときは、
   それを人の名前として出さない。拾ったジャケットに付いてきた名前を使う。 */
function artistOf(al) {
  const raw = cleanName(al.artist);
  if (raw && !GENRE_WORDS.has(raw.toLowerCase())) return raw;
  const c = S.covers[al.id];
  if (c && c.a) return c.a;
  const m = parseAlbum(al);
  return m.artist || '';
}

function parseAlbum(al) {
  const raw = cleanName(al.name);
  const par = cleanName(al.artist);
  const parOk = par && !GENRE_WORDS.has(par.toLowerCase());
  const m = raw.match(/^(.{2,40}?)\s+[-–—~〜]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), album: m[2].trim() };
  return { artist: parOk ? par : '', album: raw };
}
const albumQuery = al => {
  const a = parseAlbum(al);
  return ((a.artist ? a.artist + ' ' : '') + a.album).replace(/\b(19|20)\d\d\b/g, ' ').replace(/\s+/g, ' ').trim();
};

/* 候補の採点。先頭を黙って採ると別の盤を掴むので、言葉の重なりで並べ替える。 */
const STOP = new Set(['the','a','an','of','and','de','feat','ft','with','vol','cd','disc','remaster','remastered',
  'remastering','deluxe','expanded','edition','anniversary','version','bonus','ep','single','album','ソレ','盤']);
const normTitle = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[\[\(【][^\]\)】]*[\]\)】]/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = s => {
  const t = normTitle(s).split(' ').filter(w => w && !STOP.has(w) && !/^\d{4}$/.test(w));
  return new Set(t.length ? t : normTitle(s).split(' ').filter(Boolean));
};
/* Jaccard を使う。部分文字列に甘い指標だと「VSQ Performs Pink Floyd's ...」が勝ってしまう。 */
function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of B) if (A.has(x)) hit++;
  return hit / (A.size + B.size - hit);
}
function rank(cands, al) {
  const me = parseAlbum(al);
  const mine = (al.tracks || []).length;
  const wa = me.artist ? 0.62 : 0.80, wn = me.artist ? 0.38 : 0;
  return cands.map(c => {
    const i = c.label.indexOf(' / ');
    const cArt = i < 0 ? '' : c.label.slice(0, i), cAlb = i < 0 ? c.label : c.label.slice(i + 3);
    const sArt = me.artist ? overlap(cArt, me.artist) : 0;
    /* アーティスト名を混ぜて照合すると、名前が合うだけの別アルバムに点が乗る
       （風神雷神 が同じ人の BLOOD を掴んだ）。アーティストが分かっているときは題名だけで見る。 */
    let sAlb = me.artist ? overlap(cAlb, me.album)
                         : Math.max(overlap(cAlb, me.album), overlap(cArt + ' ' + cAlb, me.album));
    /* 連番は題名の一部として効かせる。EAT A CLASSIC と EAT A CLASSIC 7 は別物。 */
    const serial = t => { const m = normTitle(t).match(/(?:^|\s)(\d{1,2})$/); return m ? m[1] : ''; };
    const a1 = serial(me.album), a2 = serial(cAlb);
    if (a1 !== a2) sAlb = Math.max(0, sAlb - (a1 && a2 ? 0.45 : 0.30));
    let sc = wa * sAlb + wn * sArt;
    /* 曲数は強い手がかり。9曲のフォルダにシングル盤のジャケットは付かない。 */
    if (mine >= 4 && c.n) {
      const d = Math.abs(c.n - mine);
      if (d <= 1) sc += 0.14;
      else if (c.n <= 2) sc -= 0.30;
      else if (d > Math.max(4, mine * 0.6)) sc -= 0.12;
    }
    if (mine >= 5 && /\s[-–]\s(single|ep)$/i.test(c.label.trim())) sc -= 0.25;
    /* 確定させない条件。どちらも実測で踏んだ型。
       ・題名が噛み合っていない：アーティスト名だけ合った別アルバムが居座り、
         iTunes に無い盤（The Dark Side of the Moon）で Deezer まで進まなかった
       ・題名は同じで演奏者が違う：クラシックで頻発する
       ただし題名がほぼ完全一致なら、名前の違いは表記の違い（ピンク・フロイド／Pink Floyd）とみなす。 */
    if (sAlb < 0.34) sc = Math.min(sc, SURE - 0.01);
    else if (me.artist && sArt < 0.34 && sAlb < 0.75) sc = Math.min(sc, SURE - 0.01);
    return Object.assign({}, c, { score: +Math.max(0, Math.min(1, sc)).toFixed(3) });
  }).sort((a, b) => b.score - a.score);
}
const SURE = 0.42;   // これ未満は「要確認」を立てて、手で選ぶ先を絞る

/* 題名の文字種でストアを選ぶ。英字の盤を日本のストアで引くと、
   アーティスト名が日本語で返って照合できなくなる。往復の数は変わらない。 */
const latinish = s => {
  const t = String(s).replace(/[^\p{L}]/gu, '');
  if (!t) return true;
  return (t.match(/[A-Za-z]/g) || []).length / t.length > 0.6;
};
async function findCandidates(term, al, wide) {
  const seen = new Set();
  let out = [];
  const add = arr => { for (const c of arr) if (!seen.has(c.label)) { seen.add(c.label); out.push(c); } };
  const best = () => (al ? ((rank(out, al)[0] || {}).score || 0) : (out.length ? 1 : 0));
  const first = latinish(term) ? 'US' : 'JP', second = first === 'US' ? 'JP' : 'US';

  try { add(await itunesSearch(term, 20, first)); } catch (e) {}
  if (best() < SURE || wide) { try { add(await itunesSearch(term, 20, second)); } catch (e) {} }
  if (best() < SURE || wide) add(await deezerSearch(term, 15));
  return (al ? rank(out, al) : out).slice(0, 24);
}

/* 棚ぜんぶを一巡する。止めても続きから。費用は 0 円。
   1件ずつ引くと1500枚で1〜2時間かかるので、まずアーティスト単位でまとめて引く。
   iTunes は1回で200件返せるので、同じ人のアルバムは1往復で片が付く。 */
async function sweepByArtist(targets, groups) {
  for (const [artist, list] of groups) {
    if (S.sweep.stop) return;
    if (!artist || list.length < 2) continue;          // 1枚だけなら普通に引いた方が当たる
    let pool = [];
    try {
      S.sweep.note = artist + ' をまとめて（' + list.length + '枚）';
      updateSweepBar();
      pool = await itunesSearch(artist, 200, latinish(artist) ? 'US' : 'JP');
    } catch (e) { continue; }
    if (!pool.length) continue;
    for (const al of list) {
      if (S.sweep.stop) return;
      const best = rank(pool, al)[0];
      if (best && best.score >= SURE) {
        S.covers[al.id] = { url: best.url, src: best.src, q: albumQuery(al), a: artOf(best),
                            manual: false, score: best.score, sure: true };
        if (best.g || best.y) S.meta[al.id] = { g: best.g || '', y: best.y || '' };
        al._done = true; S.sweep.hit++; S.sweep.done++;
      }
    }
    saveCovers(); saveMeta();
    updateSweepBar();
  }
}

async function sweepCovers(onlyMissing = true) {
  if (S.sweep) { S.sweep.stop = true; return; }
  const targets = S.albums.filter(a => !(onlyMissing && (S.covers[a.id] || a.folderCover)));
  if (!targets.length) { toast('付いていないジャケットはありません'); return; }
  targets.forEach(a => { a._done = false; });
  const groups = new Map();
  for (const al of targets) {
    const k = parseAlbum(al).artist;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(al);
  }
  S.sweep = { done: 0, total: targets.length, hit: 0, iffy: 0, stop: false, t0: Date.now(), note: '' };
  renderRoute();
  await sweepByArtist(targets, [...groups.entries()]);
  S.sweep.note = '';
  for (const al of targets) {
    if (S.sweep.stop) break;
    if (al._done) continue;
    const q = albumQuery(al);
    try {
      const cands = await findCandidates(q, al);
      if (cands.length) {
        const top = cands[0];
        /* 候補一式は持たない。1500件も抱えると端末の記憶（5MB前後）を越え、
           保存が黙って失敗して結果が残らなくなる。選び直す時に取り直せばよい。 */
        S.covers[al.id] = { url: top.url, src: top.src, q, a: artOf(top), manual: false,
                            score: top.score, sure: top.score >= SURE };
        if (top.g || top.y) S.meta[al.id] = { g: top.g || '', y: top.y || '' };
        if (top.score >= SURE) S.sweep.hit++; else S.sweep.iffy++;
        saveCovers();
      }
    } catch (e) { /* 1枚の失敗で全体を止めない */ }
    S.sweep.done++;
    updateSweepBar();
  }
  const r = S.sweep; S.sweep = null;
  saveCovers(); saveMeta();
  toast((r.stop ? '中断：' : '') + `${r.hit} / ${r.total} 枚確定、${r.iffy} 枚は要確認`, 3600);
  renderRoute();
}
function updateSweepBar() {
  const s = S.sweep; if (!s) return;
  const bar = $('#swbar'), txt = $('#swtxt');
  if (bar) bar.style.width = (s.done / s.total * 100) + '%';
  if (!txt) return;
  let rest = '';
  if (s.done > 4) {
    const per = (Date.now() - s.t0) / s.done;
    const m = Math.round(per * (s.total - s.done) / 60000);
    rest = m > 0 ? `・のこり約${m}分` : '・もうすぐ';
  }
  txt.textContent = (s.note || `探しています ${s.done}/${s.total}`) +
                    `（確定 ${s.hit}・要確認 ${s.iffy}${rest}）` + (LS.full ? ' ★端末の記憶が一杯です' : '');
}
const coverOf = al => {
  const c = S.covers[al.id];
  if (c) return c.url;
  if (al.folderCover && !S.code && !GATE) return thumbUrl(al.folderCover, 400);
  return null;
};
/* ジャケットが手に入らない盤は、名前から色を決めて題字だけの札を作る。
   空の四角より探しやすく、他と取り違えない。絵ではないと分かる見た目にする。 */
function hueOf(t) {
  let h = 0;
  const s2 = String(t || '');
  for (let i = 0; i < s2.length; i++) h = (h * 31 + s2.charCodeAt(i)) >>> 0;
  return h % 360;
}
const madeCover = al => {
  const h = hueOf(al.name + al.artist);
  return `background:linear-gradient(150deg,hsl(${h} 42% 26%),hsl(${(h + 40) % 360} 38% 14%))`;
};

/* ============ 操作シート ============ */
/* YouTube Music の ⋮ にあたるもの。曲でもアルバムでも同じ形で出す。 */
function sheet(head, items) {
  const bg = $('#sheetbg'), sh = $('#sheet');
  sh.innerHTML = `<div class="grip"></div>
    <div class="head">
      ${head.cover ? `<img src="${esc(head.cover)}" onerror="this.style.visibility='hidden'">`
                   : '<img alt="">'}
      <div class="t"><div class="n">${esc(head.name)}</div><div class="a">${esc(head.sub || '')}</div></div>
    </div>` +
    items.filter(Boolean).map((it, i) =>
      `<button class="item" data-k="${i}"><span class="ic">${it[0]}</span>${esc(it[1])}</button>`).join('');
  bg.classList.remove('hide'); sh.classList.remove('hide');
  requestAnimationFrame(() => { bg.classList.add('on'); sh.classList.add('on'); });
  const close = () => {
    bg.classList.remove('on'); sh.classList.remove('on');
    setTimeout(() => { bg.classList.add('hide'); sh.classList.add('hide'); }, 200);
  };
  bg.onclick = close;
  sh.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    close();
    const it = items.filter(Boolean)[+b.dataset.k];
    if (it && it[2]) it[2]();
  });
  return close;
}
function nowSheet() {
  const c = cur();
  if (!c) { toast('まだ何も流していません'); return; }
  const al = c.al, t = al.tracks[c.i];
  const fa = isFav('a' + al.id), ft = isFav('t' + t.id);
  const rep = { off: '繰り返さない', all: 'ぜんぶ繰り返す', one: '1曲を繰り返す' };
  sheet({ name: trackTitle(t), sub: [al.artist, al.name].filter(Boolean).join(' — '), cover: coverOf(al) },
    [['💿', 'アルバムを開く', () => go('#/album/' + al.id)],
     ['≡', '次に流れるものを見る', () => go('#/queue')],
     [ft ? '★' : '☆', ft ? 'この曲の★を外す' : 'この曲を★に入れる',
      () => { toggleFav('t' + t.id); renderRoute(); }],
     [fa ? '★' : '☆', fa ? 'このアルバムの★を外す' : 'このアルバムを★に入れる',
      () => { toggleFav('a' + al.id); renderRoute(); }],
     ['🔀', 'このアルバムをシャッフル', () => startQueue(shuffle(albumRefs(al)), 0)],
     ['🌙', 'この雰囲気で流す', () => {
        const q = moodQueue(al);
        if (!q.length) { toast('先に ⋯ →「雰囲気を測る」を回してください', 4000); return; }
        startQueue([{ al, i: c.i }].concat(q), 0); go('#/queue');
      }],
     ['🔁', '繰り返し：' + rep[P.repeat] + ' →',
      () => { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; LS.set('repeat', P.repeat);
              toast('繰り返し：' + rep[P.repeat]); }],
     ['✕', 'この曲を列から外す', () => {
        P.q.splice(P.qi, 1);
        if (P.qi >= P.q.length) P.qi = P.q.length - 1;
        P.q.length ? playAt(P.qi) : (au.pause(), paintPlayer());
        renderRoute();
      }],
     ['🖼', 'ジャケットを変える', () => go('#/cover/' + al.id)],
     ['🎞', 'ビジュアライザーを選ぶ', () => go('#/vis')],
     ['🚗', '車モード（大きく表示）', () => go('#/car')],
     [albumOffline(al) ? '🗑' : '↓', albumOffline(al) ? 'このアルバムを端末から消す' : 'このアルバムを端末に入れる',
      () => (albumOffline(al) ? removeAlbum(al) : downloadAlbum(al))]]);
}

function albumSheet(al) {
  const fav = isFav('a' + al.id);
  sheet({ name: al.name, sub: [al.artist, albumGenre(al), albumYear(al)].filter(Boolean).join(' · '),
          cover: coverOf(al) },
    [['▶', '今すぐ再生', () => play(al, 0)],
     ['🔀', 'シャッフルで再生', () => startQueue(shuffle(albumRefs(al)), 0)],
     ['🌙', 'この雰囲気で流す', () => {
        const q = moodQueue(al);
        if (!q.length) { toast('先に ⋯ →「雰囲気を測る」を回してください', 4000); return; }
        startQueue([{ al, i: 0 }].concat(q), 0); go('#/queue');
      }],
     ['⤵', '次に再生', () => enqueueNext(albumRefs(al))],
     ['＋', '列の最後に追加', () => enqueueEnd(albumRefs(al))],
     [fav ? '★' : '☆', fav ? 'お気に入りから外す' : 'お気に入りに入れる',
      () => { toggleFav('a' + al.id); renderRoute(); }],
     ['💿', 'アルバムを開く', () => go('#/album/' + al.id)],
     ['🖼', 'ジャケットを変える', () => go('#/cover/' + al.id)],
     [albumOffline(al) ? '🗑' : '↓', albumOffline(al) ? '端末から消す' : '端末に入れる',
      () => (albumOffline(al) ? removeAlbum(al) : downloadAlbum(al))]]);
}
function trackSheet(al, i) {
  const t = al.tracks[i], fav = isFav('t' + t.id);
  sheet({ name: trackTitle(t), sub: [al.artist, al.name].filter(Boolean).join(' — '), cover: coverOf(al) },
    [['▶', '今すぐ再生', () => play(al, i)],
     ['⤵', '次に再生', () => enqueueNext([{ al, i }])],
     ['＋', '列の最後に追加', () => enqueueEnd([{ al, i }])],
     [fav ? '★' : '☆', fav ? 'お気に入りから外す' : 'お気に入りに入れる',
      () => { toggleFav('t' + t.id); renderRoute(); }],
     ['💿', 'アルバムを開く', () => go('#/album/' + al.id)]]);
}

/* ============ 再生 ============ */
/* 待ち行列を器にする。アルバムを通して聴くのも、棚全体のシャッフルも、
   条件で組んだものも、すべて同じ「並んだ曲」として扱う。 */
const au = $('#au');
const P = { q: [], qi: -1, linkCache: new Map(), repeat: LS.get('repeat', 'off') };
const cur = () => (P.qi >= 0 ? P.q[P.qi] : null);
Object.defineProperty(P, 'album', { get: () => (cur() ? cur().al : null) });
Object.defineProperty(P, 'i',     { get: () => (cur() ? cur().i  : -1) });

const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const albumRefs = al => al.tracks.map((_, i) => ({ al, i }));

async function fileLink(fileid) {
  const hit = P.linkCache.get(fileid);
  if (hit && hit.exp > Date.now()) return hit.url;
  /* 合鍵で出す getfilelink は Origin で弾かれる（7010）。
     符号で出す getpublinkdownload は弾かれない。耳読と同じ道。 */
  const r = (GATE || S.code) ? await apiPub('getpublinkdownload', { fileid, forcedownload: 0 })
                             : await api('getfilelink', { fileid, forcedownload: 0, skipfilename: 0 });
  const url = 'https://' + r.hosts[0] + r.path;
  P.linkCache.set(fileid, { url, exp: Date.now() + 40 * 60 * 1000 });
  return url;
}
const cacheKey = fileid => 'https://track.local/' + fileid;
async function cachedResponse(fileid) {
  if (!('caches' in window)) return null;
  const c = await caches.open('tracks-v1');
  return (await c.match(cacheKey(fileid))) || null;
}

/* 聴いた記録。次の一手（条件付きシャッフル）の材料になる。 */
function remember(al, t) {
  S.hist.unshift({ a: al.id, t: t.id, at: Date.now() });
  if (S.hist.length > 400) S.hist.length = 400;
  const p = S.plays[al.id] || { n: 0, last: 0 };
  p.n++; p.last = Date.now(); S.plays[al.id] = p;
  saveHist(); savePlays();
}

/* ブラウザは「利用者が押した、その場で始まる音」しか鳴らさない。
   曲のURLを取りに行く待ちが入ると操作の資格が切れるので、
   最初に触った瞬間に無音を一度鳴らして資格を取っておく。 */
const SILENT = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
let unlocked = false;
function unlockAudio() {
  if (unlocked || au.src) return;
  unlocked = true;
  try {
    au.muted = true; au.src = SILENT;
    const pr = au.play();
    if (pr && pr.then) pr.then(() => {
                           if (au.src === SILENT) au.pause();   /* 本物が入っていたら止めない */
                           au.muted = false; note('音を出す資格を取った');
                         })
                         .catch(e => { au.muted = false; unlocked = false; note('資格を取れない: ' + e.name); });
  } catch (e) { au.muted = false; unlocked = false; }
}
addEventListener('pointerdown', unlockAudio, true);
addEventListener('touchstart', unlockAudio, true);
addEventListener('pointerdown', () => {
  if (pending == null) return;
  const q = pending; pending = null;
  au.play().catch(() => playAt(q));
}, true);

let pending = null;   // 資格が無くて鳴らせなかったもの
async function playAt(qi) {
  if (qi < 0 || qi >= P.q.length) return;
  P.qi = qi;
  const { al, i } = P.q[qi];
  const t = al.tracks[i];
  if (!t) return;
  let src = null;
  try {
    const so = await trackSource(t);
    /* 解析器に繋いだ後は、外から流す音に CORS の印を付けないと
       ブラウザが音を消す。印は src を入れる前に決めないと効かない。 */
    /* 出力から拾っているときは印を付けてはいけない。付けると次の曲が読めなくなる。 */
    au.crossOrigin = (V.ok && !V.tap && !so.local && so.cors === true) ? 'anonymous' : null;
    if (so.relay) {
      /* ① ブラウザが pCloud から直に読む ② 中継所に流してもらう。
         通るかどうかは相手次第なので、実際に読ませて先に通った方を使う。 */
      const cands = [];
      if (V.direct !== false) { const d = await relayLink(t); if (d) cands.push(['直', d]); }
      cands.push(['中継', relayUrl('/audio', t)]);
      for (const [how, u] of cands) {
        try {
          await tryLoad(u);
          src = u;
          if (V.direct === null) { V.direct = (how === '直'); note('読めた道: ' + how); }
          break;
        } catch (e2) { note('読めない道: ' + how); if (how === '直') V.direct = false; }
      }
      if (!src) throw new PCloudError(-9, 'どちらの道でも音を読めません');
    } else {
      src = so.url;
    }
  } catch (e) {
    note('場所が分からない: ' + (e.code != null ? 'code=' + e.code + ' ' : '') + (e.message || e));
    toast('曲の場所が分かりません: ' + (e.message || e), 5000);
    if (S.relay) diagnoseRelay(t);
    return;
  }
  try {
    if (au.src !== src) au.src = src;
    await au.play();
    pending = null;
  } catch (e) {
    note('鳴らせない: ' + e.name + ' ' + (e.message || ''));
    if (e.name === 'NotAllowedError') {
      pending = qi;
      toast('もう一度押してください（音を出す許可が要ります）', 4000);
    } else {
      toast('再生できません: ' + e.name + ' — ' + (e.message || e), 5000);
      if (GATE) diagnoseGate(t); else if (S.relay) diagnoseRelay(t);
    }
    return;
  }
  remember(al, t);
  paintPlayer();
  setMediaSession();
  if (location.hash.startsWith('#/album/') || location.hash === '#/queue') renderRoute();
}
function startQueue(list, at = 0) {
  if (!list.length) { toast('流すものがありません'); return; }
  P.q = list; P.qi = -1;
  playAt(at);
}
const play = (album, i) => startQueue(albumRefs(album), i);
function enqueueNext(list) {
  if (!list.length) return;
  if (!P.q.length) return startQueue(list, 0);
  P.q.splice(P.qi + 1, 0, ...list);
  toast(list.length + ' 曲を次に流します');
}
function enqueueEnd(list) {
  if (!P.q.length) return startQueue(list, 0);
  P.q.push(...list);
  toast(list.length + ' 曲を最後に足しました');
}

const trackTitle = t => t.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');
function paintPlayer() {
  const p = $('#player'), c = cur();
  if (!c) { p.classList.add('gone'); document.body.classList.remove('playing'); return; }
  p.classList.remove('gone'); document.body.classList.add('playing');
  const t = c.al.tracks[c.i];
  $('#pti').textContent = trackTitle(t);
  $('#par').textContent = [artistOf(c.al), c.al.name].filter(Boolean).join(' — ');
  const nx = P.q[P.qi + 1];
  $('#pnx').textContent = nx ? '次: ' + trackTitle(nx.al.tracks[nx.i]) : '次はありません';
  $('#pqn').textContent = Math.max(0, P.q.length - P.qi - 1);
  const cv = coverOf(c.al);
  $('#pcov').src = cv || '';
  $('#pcov').style.visibility = cv ? 'visible' : 'hidden';
  $('#play').textContent = au.paused ? '▶' : '⏸';
}
function setMediaSession() {
  const c = cur();
  const t0 = c ? trackTitle(c.al.tracks[c.i]) : '';
  document.title = t0 ? t0 + '｜音楽棚' : '音楽棚';
  if (!('mediaSession' in navigator) || !c) return;
  const t = c.al.tracks[c.i], cv = coverOf(c.al);
  /* 大きさ違いを並べて渡す。iOS はここから選ぶので、1つだけだと粗く出る（耳読に倣う）。 */
  const art = cv ? [96, 192, 256, 384, 512].map(n =>
    ({ src: cv, sizes: n + 'x' + n, type: cv.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' })) : [];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackTitle(t),
      artist: cleanName(c.al.artist) || c.al.name,
      album: c.al.name,
      artwork: art,
    });
  } catch (e) {}
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
  set('play',  () => au.play().catch(() => {}));
  set('pause', () => au.pause());
  set('previoustrack', prevTrack);
  set('nexttrack', nextTrack);
  set('seekbackward', d => { au.currentTime = Math.max(0, au.currentTime - ((d && d.seekOffset) || 15)); });
  set('seekforward',  d => { au.currentTime = au.currentTime + ((d && d.seekOffset) || 15); });
  set('seekto', d => { if (d && d.seekTime != null) au.currentTime = d.seekTime; });
  set('stop', () => { au.pause(); });
  try { navigator.mediaSession.playbackState = au.paused ? 'paused' : 'playing'; } catch (e) {}
}
function nextTrack(auto) {
  if (auto && P.repeat === 'one') return playAt(P.qi);
  if (P.qi + 1 < P.q.length) return playAt(P.qi + 1);
  if (P.repeat === 'all' && P.q.length) return playAt(0);
}
function prevTrack() {
  if (P.qi < 0) return;
  if (au.currentTime > 3) { au.currentTime = 0; return; }
  if (P.qi > 0) playAt(P.qi - 1);
}
/* 形式が合わない・読めない、は play() の失敗ではなく要素の error に出る。 */
au.addEventListener('error', () => {
  const e = au.error; if (!e || au.src === SILENT || probing) return;
  const why = { 1:'読み込みを中断した', 2:'通信が切れた', 3:'音の中身を解けない',
                4:'この形式は再生できません' }[e.code] || ('error ' + e.code);
  const c = cur(), nm = c ? c.al.tracks[c.i].name : '';
  note('音が鳴らない: ' + why + ' / ' + nm.slice(-24));
  toast(why + (e.code === 4 ? '（' + nm.split('.').pop() + '）' : ''), 5000);
  if (GATE && c) diagnoseGate(c.al.tracks[c.i]);
});
au.addEventListener('ended', () => nextTrack(true));
au.addEventListener('play',  () => { paintPlayer();
  try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {} });
au.addEventListener('pause', () => { paintPlayer();
  try { navigator.mediaSession.playbackState = 'paused'; } catch (e) {} });
au.addEventListener('timeupdate', () => {
  if (au.duration) $('#seek').style.width = (au.currentTime / au.duration * 100) + '%';
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && au.duration) {
    try { navigator.mediaSession.setPositionState(
      { duration: au.duration, position: au.currentTime, playbackRate: au.playbackRate }); } catch (e) {}
  }
});
$('#play').onclick = () => { au.paused ? au.play().catch(e => toast('鳴らせません: ' + e.name)) : au.pause(); };
$('#next').onclick = nextTrack;
$('#prev').onclick = prevTrack;
$('#pcov').onclick  = () => go('#/now');
$('#pinfo').onclick = () => go('#/now');
$('#pq').onclick    = () => go('#/queue');
/* 音量。覚えておく。端末の物理ボタンが効かない場面（PC）で要る。 */
au.volume = Math.max(0, Math.min(1, S.vol));
function setVol(v, quiet) {
  v = Math.max(0, Math.min(1, v));
  au.volume = v; au.muted = v === 0 ? au.muted : false;
  S.vol = v; LS.set('vol', v);
  paintVol();
  if (!quiet) toast('音量 ' + Math.round(v * 100) + '%', 800);
}
function paintVol() {
  const r = $('#pvol'), m = $('#pmute');
  if (r) r.value = Math.round((au.muted ? 0 : au.volume) * 100);
  if (m) m.textContent = au.muted || au.volume === 0 ? '🔇' : au.volume < 0.45 ? '🔉' : '🔊';
  const r2 = $('#cvol'); if (r2) r2.value = Math.round((au.muted ? 0 : au.volume) * 100);
  const m2 = $('#cmute'); if (m2) m2.textContent = au.muted || au.volume === 0 ? '🔇' : '🔊';
}
$('#pvol').oninput  = e => setVol(+e.target.value / 100, true);
$('#pmute').onclick = () => { au.muted = !au.muted; paintVol(); };
au.addEventListener('volumechange', paintVol);
paintVol();
$('#pdots').onclick = () => nowSheet();

/* ============ ビジュアライザー ============ */
/* 音を解析するには、音のデータに手が届かないといけない。
   pCloud から直に流している音がブラウザに読ませてもらえるかは、
   叩いてみるまで分からない。読めない音を Web Audio に通すと
   ブラウザは「音を消す」ので、確かめる前に繋いではいけない。 */
const V = { ctx:null, src:null, aL:null, aR:null, fL:null, fR:null, td:null,
            ok:false, cors:null, link:null, direct:null, directUrl:null,
            on:false, vi:0, raf:0 };
const BANDS = 84;

/* いま鳴っている音そのものを読めるかで決める。
   読めない音を解析器に通すと、ブラウザは音を消す（実機で踏んだ）。 */
/* 曲を丸ごと落として手元で鳴らし直す。素直な GET なら事前問い合わせが起きないので、
   相手が CORS を許していれば通る。通れば手元の音になり、解析は必ずできる。 */
async function bufferHere(c) {
  const t = c.al.tracks[c.i];
  const url = au.currentSrc || au.src || '';
  if (!url || url.startsWith('blob:')) return false;
  const msg = $('#nmsg');
  if (msg) msg.textContent = '曲を手元に読み込んでいます…';
  let blobUrl;
  try {
    const r = await fetch(url, { referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob();
    if (b.size < 10000) throw new Error('中身が小さすぎます');
    blobUrl = URL.createObjectURL(b);
  } catch (e) { note('手元に読めない: ' + (e.message || e)); return false; }
  keepBlob(t.id, blobUrl);
  const pos = au.currentTime, playing = !au.paused;
  await new Promise(res => {
    let done = false;
    const fin = () => { if (done) return; done = true; probing = false; clearTimeout(tm);
      au.removeEventListener('loadedmetadata', fin); au.removeEventListener('error', fin); res(); };
    const tm = setTimeout(fin, 9000);
    probing = true;
    au.addEventListener('loadedmetadata', fin); au.addEventListener('error', fin);
    au.crossOrigin = null; au.src = blobUrl; au.load();
  });
  try { au.currentTime = pos; } catch (e) {}
  if (playing) au.play().catch(() => {});
  note('手元に読み込んだ（解析できる）');
  return true;
}

/* CORS の印を付けて読み込み直せるか試す。通れば解析器に繋げる。
   駄目なら印を外して元に戻す。位置も再生状態も保つ。 */
async function tryCors() {
  const src = au.currentSrc || au.src || '';
  if (!src || src.startsWith('blob:')) return false;
  const pos = au.currentTime, playing = !au.paused;
  const load = cross => new Promise(res => {
    let done = false;
    const fin = ok => {
      if (done) return; done = true; clearTimeout(tm); probing = false;
      au.removeEventListener('loadedmetadata', onOk); au.removeEventListener('canplay', onOk);
      au.removeEventListener('error', onNg);
      res(ok);
    };
    const onOk = () => fin(true), onNg = () => fin(false);
    const tm = setTimeout(() => fin(false), 12000);
    probing = true;
    au.addEventListener('loadedmetadata', onOk);
    au.addEventListener('canplay', onOk);
    au.addEventListener('error', onNg);
    au.crossOrigin = cross; au.src = src; au.load();
  });
  const ok = await load('anonymous');
  if (!ok) await load(null);
  try { au.currentTime = pos; } catch (e) {}
  if (playing) au.play().catch(() => {});
  note('CORS で読み直し: ' + (ok ? '通った（解析できる）' : '駄目'));
  return ok;
}

async function canAnalyse() {
  const src = au.currentSrc || au.src || '';
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith(location.origin)) return true;
  /* Range を付けると事前問い合わせ（preflight）が起き、相手がそれに答えないだけで
     「読めない」と誤判定してしまう。素直な GET で確かめる。 */
  try {
    const r = await fetch(src, { referrerPolicy: 'no-referrer' });
    if (r.ok) { try { r.body && r.body.cancel(); } catch (e) {} return true; }
  } catch (e) {}
  return false;
}
/* 鳴っている「出力」から拾う。ファイルの中身を読む必要がない。
   ① 要素の出力をそのまま取る（許可不要）
   ② タブの音を拾う（一度だけ許可が要る。画面共有の仕組みを音だけに使う）
   どちらも CORS とは無関係に動く。 */
function wireAnalyser(node, ctx) {
  const sp = ctx.createChannelSplitter(2);
  V.aL = ctx.createAnalyser(); V.aR = ctx.createAnalyser();
  V.aL.fftSize = V.aR.fftSize = 2048;
  V.aL.smoothingTimeConstant = V.aR.smoothingTimeConstant = 0.72;
  node.connect(sp);
  sp.connect(V.aL, 0); sp.connect(V.aR, 1);
  V.fL = new Uint8Array(V.aL.frequencyBinCount);
  V.fR = new Uint8Array(V.aR.frequencyBinCount);
  V.td = new Uint8Array(V.aL.fftSize);
  V.ctx = ctx; V.ok = true;
}
/* 実際に音が来ているかを確かめる。来ていなければ諦めて元に戻す。 */
function hasSignal(ms = 1200) {
  return new Promise(res => {
    const t0 = Date.now();
    const tick = () => {
      if (!V.aL) return res(false);
      V.aL.getByteFrequencyData(V.fL);
      let sum = 0;
      for (let i = 0; i < V.fL.length; i++) sum += V.fL[i];
      if (sum > 200) return res(true);
      if (Date.now() - t0 > ms) return res(false);
      setTimeout(tick, 80);
    };
    tick();
  });
}
async function tapElement() {
  if (V.ok) return true;
  if (V.tapTried) return false;      /* 一度駄目なら毎回試さない */
  V.tapTried = true;
  const grab = au.captureStream ? au.captureStream.bind(au)
             : (au.mozCaptureStream ? au.mozCaptureStream.bind(au) : null);
  if (!grab) return false;
  try {
    const st = grab();
    if (!st || !st.getAudioTracks().length) return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    wireAnalyser(ctx.createMediaStreamSource(st), ctx);
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    if (await hasSignal()) { note('出力から拾えた（要素）'); V.tap = 'element'; return true; }
    try { ctx.close(); } catch (e) {}
    V.ok = false; V.ctx = null;
  } catch (e) { note('要素の出力を取れない: ' + (e.name || e)); }
  return false;
}
async function tapTab() {
  if (V.ok) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return false;
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: true,
    });
    st.getVideoTracks().forEach(t => t.stop());          /* 映像は要らない */
    if (!st.getAudioTracks().length) {
      st.getTracks().forEach(t => t.stop());
      toast('音が共有されませんでした。「タブの音声も共有」に印を付けてください', 6000);
      return false;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    wireAnalyser(ctx.createMediaStreamSource(st), ctx);
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    V.tapStream = st;
    if (await hasSignal(2500)) { note('出力から拾えた（タブの音）'); V.tap = 'tab'; return true; }
    st.getTracks().forEach(t => t.stop());
    try { ctx.close(); } catch (e) {}
    V.ok = false; V.ctx = null;
    toast('音を拾えませんでした', 4000);
  } catch (e) { note('タブの音を拾えない: ' + (e.name || e)); }
  return false;
}

function initGraph() {
  if (V.ctx) return V.ok;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    V.ctx = new AC();
    V.src = V.ctx.createMediaElementSource(au);
    const sp = V.ctx.createChannelSplitter(2);
    V.aL = V.ctx.createAnalyser(); V.aR = V.ctx.createAnalyser();
    V.aL.fftSize = V.aR.fftSize = 2048;
    V.aL.smoothingTimeConstant = V.aR.smoothingTimeConstant = 0.72;
    V.src.connect(sp);
    sp.connect(V.aL, 0); sp.connect(V.aR, 1);
    V.src.connect(V.ctx.destination);
    V.fL = new Uint8Array(V.aL.frequencyBinCount);
    V.fR = new Uint8Array(V.aR.frequencyBinCount);
    V.td = new Uint8Array(V.aL.fftSize);
    V.ok = true;
  } catch (e) { V.ok = false; note('解析器を作れない: ' + e.message); }
  return V.ok;
}
/* 周波数の目盛りは対数。低い方を細かく見ないと、音楽らしい動きにならない。 */
const band = new Float32Array(BANDS), peakB = new Float32Array(BANDS);
let lvL = 0, lvR = 0, pkL = 0, pkR = 0, wav = new Float32Array(256), beatE = 0, spin = 0;
/* 音が読めないときの飾り。曲の進みから作った、本物ではない動き。
   設定で切れる。切ると止まったまま何も描かない。 */
let decoT = 0;
function decoAudio(dt) {
  decoT += dt;
  const t = decoT, beat = (au.currentTime % 0.55) / 0.55;
  for (let i = 0; i < BANDS; i++) {
    const f = i / BANDS;
    const v = Math.max(0,
        Math.exp(-Math.pow(f / 0.10, 2)) * (0.55 + 0.4 * Math.exp(-beat * 9))
      + Math.exp(-Math.pow((f - 0.22 - 0.06 * Math.sin(t * 0.6)) / 0.12, 2)) * (0.30 + 0.22 * Math.sin(t * 1.7 + i * 0.2))
      + Math.exp(-Math.pow((f - 0.6) / 0.3, 2)) * (0.12 + 0.12 * Math.abs(Math.sin(t * 4.4 + i * 0.5))));
    band[i] += (Math.min(1, v) - band[i]) * (v > band[i] ? 0.5 : 0.13);
  }
  const base = 0.34 + 0.34 * Math.exp(-beat * 8) + 0.08 * Math.sin(t * 1.1);
  lvL += (base + 0.06 * Math.sin(t * 2.3) - lvL) * 0.3;
  lvR += (base + 0.06 * Math.sin(t * 2.3 + 1.2) - lvR) * 0.3;
  beatE = Math.max(beatE - dt * 2.4, Math.exp(-beat * 8));
  for (let i = 0; i < wav.length; i++) {
    const xq = i / wav.length;
    wav[i] = (Math.sin(xq * Math.PI * 6 + t * 4) * (0.36 + 0.3 * Math.exp(-beat * 8))
            + Math.sin(xq * Math.PI * 15 + t * 2) * 0.16) * 0.9;
  }
  return true;
}

function readAudio(dt) {
  if (!V.ok) return (S.deco && !au.paused) ? decoAudio(dt) : false;
  V.aL.getByteFrequencyData(V.fL); V.aR.getByteFrequencyData(V.fR);
  V.aL.getByteTimeDomainData(V.td);
  const n = V.fL.length;
  let sum = 0, bass = 0;
  for (let i = 0; i < BANDS; i++) {
    const a = Math.floor(Math.pow(i / BANDS, 2.1) * n);
    const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / BANDS, 2.1) * n));
    let m = 0;
    for (let k = a; k < b && k < n; k++) m = Math.max(m, (V.fL[k] + V.fR[k]) / 2);
    const v = m / 255;
    band[i] = v; peakB[i] = Math.max(peakB[i] - dt * 0.45, v);
    sum += v; if (i < BANDS * 0.12) bass = Math.max(bass, v);
  }
  let sl = 0, sr = 0;
  for (let i = 0; i < n; i++) { sl += V.fL[i]; sr += V.fR[i]; }
  lvL += (Math.min(1, sl / n / 90) - lvL) * 0.35;
  lvR += (Math.min(1, sr / n / 90) - lvR) * 0.35;
  pkL = Math.max(pkL - dt * 0.4, lvL); pkR = Math.max(pkR - dt * 0.4, lvR);
  for (let i = 0; i < wav.length; i++) wav[i] = (V.td[Math.floor(i * V.td.length / wav.length)] - 128) / 128;
  beatE = Math.max(beatE - dt * 2.6, bass);
  return sum > 0.01;
}

let vart = null, vartId = null;
function coverImage(al) {
  const url = coverOf(al);
  if (!url) { vart = null; vartId = null; return null; }
  if (vartId === al.id && vart && vart.complete) return vart;
  const im = new Image(); im.crossOrigin = 'anonymous'; im.src = url;
  vart = im; vartId = al.id;
  return im.complete ? im : null;
}

const VIS = {
  art:   ['ジャケットと盤',  false],
  bubble:['バブルコンポ',    true],
  pro:   ['プロ用メーター',  true],
  disc:  ['回転ジャケット', false],
  ladder:['L／R レベル',    true],
  bars:  ['スペクトラム',    true],
  mirror:['鏡像',           true],
  scope: ['オシロスコープ',  true],
  ring:  ['円環',           true],
  vu:    ['アナログVU',      true],
  parts: ['粒子',           true],
};
S.vis = LS.get('vis', ['art', 'disc', 'ladder', 'bars', 'ring']);
if (!S.vis.includes('art')) { S.vis = ['art'].concat(S.vis); LS.set('vis', S.vis); }

/* ジャケットのどこが「静か」かを見て、札を置く場所を決める。
   決め打ちだと必ず一番良いところを隠す（実際に隠していた）。
   32×32 に縮めて隣との差＝細かさを測り、いちばん細かくない場所を選ぶ。 */
const salCache = new Map();
function quietSpot(im, id) {
  if (salCache.has(id)) return salCache.get(id);
  let pick = 'br';
  try {
    const n = 32, c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(im, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    const lum = new Float32Array(n * n), skin = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const r = d[i*4], gg = d[i*4+1], b = d[i*4+2];
      lum[i] = (r*0.299 + gg*0.587 + b*0.114) / 255;
      /* 肌の色。顔は明るさの差が小さいので「静か」と誤判定される。
         ここを見ないと、むしろ顔を狙って隠してしまう（実際そうなっていた）。 */
      const mx = Math.max(r,gg,b), mn = Math.min(r,gg,b);
      skin[i] = (r > 90 && gg > 35 && b > 18 && mx - mn > 12 &&
                 r > gg && gg >= b && r - gg > 8 && r - gg < 90) ? 1 : 0;
    }
    const e = new Float32Array(n * n);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      e[i] = Math.abs(lum[i]-lum[i-1]) + Math.abs(lum[i]-lum[i+1])
           + Math.abs(lum[i]-lum[i-n]) + Math.abs(lum[i]-lum[i+n])
           + skin[i] * 3.0;                      /* 肌は強く避ける。弱いと顔を狙って隠す */
    }
    /* 盤は左下に居るので、そこは候補にしない */
    const box = { br: [0.50,0.60,0.97,0.86], tr: [0.50,0.28,0.97,0.54],
                  mr: [0.46,0.40,0.97,0.66], tc: [0.36,0.20,0.97,0.46],
                  bs: [0.30,0.79,0.97,0.965] };   /* 下端の帯。たいていの絵で一番おとなしい */
    let best = Infinity;
    for (const [k, r] of Object.entries(box)) {
      let sum = 0, cnt = 0;
      for (let y = Math.floor(r[1]*n); y < Math.ceil(r[3]*n); y++)
        for (let x = Math.floor(r[0]*n); x < Math.ceil(r[2]*n); x++) { sum += e[y*n+x]; cnt++; }
      const v = sum / Math.max(1, cnt);
      if (v < best) { best = v; pick = k; }
    }
  } catch (err) { /* 読めない絵は既定の位置で */ }
  salCache.set(id, pick);
  return pick;
}
const BOXES = { br: [0.50,0.60], tr: [0.50,0.28], mr: [0.46,0.40], tc: [0.36,0.20], bs: [0.30,0.775] };
const BOXH  = { br: 0.235, tr: 0.235, mr: 0.235, tc: 0.235, bs: 0.185 };


/* レベル計の品揃え。飾りである以上、見た目くらいは選べる方がよい。 */
const METERS = {
  wave: '波形（細い縦棒）',
  seg:  '段階バー（緑・琥珀・赤）',
  vu:   'アナログ針',
  dots: '点の列',
  none: '出さない',
};
function drawMeter(x, u, ox, oy, S0, spot) {
  const kind = S.meter || 'wave';
  if (kind === 'none') return;
  const live = V.ok || (S.deco && !au.paused);
  if (!live) return;
  const rowH = u(0.052);
  const my = (spot === 'br' || spot === 'bs') ? oy + u(0.14) : oy + u(0.845);
  const rows = [['L', lvL], ['R', lvR]];

  if (kind === 'vu') {
    rows.forEach((row, ri) => {
      const cx = ox + S0 - u(0.30) + ri * u(0.20), cy = my + u(0.03), r = u(0.085);
      x.fillStyle = 'rgba(238,232,214,.92)';
      x.fillRect(cx - r * 1.15, cy - r * 0.95, r * 2.3, r * 1.15);
      for (let i = 0; i <= 8; i++) {
        const a2 = Math.PI * (1.12 - i / 8 * 0.84);
        x.beginPath();
        x.moveTo(cx + Math.cos(a2) * r * 0.78, cy - Math.sin(a2) * r * 0.78);
        x.lineTo(cx + Math.cos(a2) * r * 0.92, cy - Math.sin(a2) * r * 0.92);
        x.strokeStyle = i > 6 ? 'rgba(185,40,30,.9)' : 'rgba(40,35,30,.75)';
        x.lineWidth = i > 6 ? 2 : 1; x.stroke();
      }
      const a3 = Math.PI * (1.12 - Math.min(1, row[1]) * 0.84);
      x.beginPath(); x.moveTo(cx, cy);
      x.lineTo(cx + Math.cos(a3) * r * 0.86, cy - Math.sin(a3) * r * 0.86);
      x.strokeStyle = '#1b1b1b'; x.lineWidth = 2; x.stroke();
      x.fillStyle = '#1b1b1b'; x.beginPath(); x.arc(cx, cy, 2.5, 0, 7); x.fill();
      x.fillStyle = 'rgba(40,35,30,.8)';
      x.font = '700 ' + u(0.028) + 'px "Hiragino Sans",sans-serif';
      x.fillText(row[0], cx - u(0.008), cy - r * 0.55);
      x.lineWidth = 1;
    });
    return;
  }

  const n = kind === 'seg' ? 16 : 24;
  const gap = u(kind === 'seg' ? 0.019 : 0.0135);
  const bw  = Math.max(1.5, u(kind === 'seg' ? 0.012 : 0.0062));
  const mw = u(0.05) + n * gap;
  const mx = ox + S0 - u(0.055) - mw;
  x.font = '700 ' + u(0.04) + 'px "Hiragino Sans",-apple-system,sans-serif';
  rows.forEach((row, ri) => {
    const y = my + ri * rowH;
    x.fillStyle = 'rgba(255,255,255,.95)';
    x.fillText(row[0], mx, y + u(0.014));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const v = band[Math.floor(i * BANDS / n)] * (0.5 + row[1] * 1.0);
      if (kind === 'seg') {
        const on = f < row[1];
        x.fillStyle = on ? (f > 0.84 ? '#e06c75' : f > 0.62 ? '#e5a34a' : '#5fbf7f')
                         : 'rgba(255,255,255,.13)';
        x.fillRect(mx + u(0.05) + i * gap, y - u(0.016), bw, u(0.032));
      } else if (kind === 'dots') {
        const on = f < row[1];
        x.beginPath();
        x.arc(mx + u(0.05) + i * gap + bw / 2, y, u(0.006), 0, 7);
        x.fillStyle = on ? `rgba(255,255,255,${0.5 + v * 0.5})` : 'rgba(255,255,255,.16)';
        x.fill();
      } else {
        const bh = Math.max(u(0.004), v * u(0.05));
        x.fillStyle = `rgba(255,255,255,${0.4 + Math.min(0.55, v * 1.2)})`;
        x.fillRect(mx + u(0.05) + i * gap, y - bh / 2, bw, bh);
      }
    }
  });
}

const VD = {
  /* お手本（大航海時代の盤）の作りをそのまま起こす。
       ① ジャケットを背景に敷く
       ② 左に水色の縦帯
       ③ 左上にアルバム名を白抜きで
       ④ 帯に重ねて盤を回す（盤面には曲名を円周に刷る）
       ⑤ 盤の右にアーティストと曲名の札
       ⑥ 左下に L／R のレベル計
     解析が無くても絵として成立する。 */
  art(x, w, h, al) {
    const im = coverImage(al), ok = im && im.complete && im.naturalWidth;
    const S0 = Math.min(w, h) * 0.96;
    const ox = (w - S0) / 2, oy = (h - S0) / 2;
    const c = cur(), tk = c && c.al === al ? c.al.tracks[c.i] : al.tracks[0];
    const u = v => S0 * v;                      /* 盤面の寸法はすべて一辺からの割合で決める */

    x.save();
    const rr = Math.max(5, u(0.012));
    x.beginPath();
    x.moveTo(ox + rr, oy); x.arcTo(ox + S0, oy, ox + S0, oy + S0, rr);
    x.arcTo(ox + S0, oy + S0, ox, oy + S0, rr); x.arcTo(ox, oy + S0, ox, oy, rr);
    x.arcTo(ox, oy, ox + S0, oy, rr); x.closePath(); x.clip();

    /* ① 背景 */
    if (ok) {
      /* お手本の元絵も左右が切られている。わずかに寄せて縁を落とす。 */
      const zm = S0 * 1.08, dx = ox - (zm - S0) / 2, dy = oy - (zm - S0) / 2;
      x.drawImage(im, dx, dy, zm, zm);
    } else { x.fillStyle = '#132436'; x.fillRect(ox, oy, S0, S0); }

    /* ② 左の水色の帯。奥のジャケットを透かしつつ、白文字が読める濃さにする */
    const bandW = u(0.40);
    const bg = x.createLinearGradient(ox, 0, ox + bandW, 0);
    bg.addColorStop(0,   'rgba(86,178,226,.80)');
    bg.addColorStop(.72, 'rgba(86,178,226,.72)');
    bg.addColorStop(1,   'rgba(86,178,226,0)');
    x.fillStyle = bg; x.fillRect(ox, oy, bandW, S0);

    /* ③ 左上のタイトル（アルバム名）。長ければ縮めて2行まで */
    const title = cleanName(al.name).toUpperCase();
    x.textBaseline = 'alphabetic';
    let ts = u(0.105);
    const maxW = u(0.355);
    const wrap = (txt, size) => {
      x.font = '800 ' + size + 'px "Hiragino Sans",-apple-system,sans-serif';
      const ws = txt.split(/\s+/), lines = []; let cur2 = '';
      for (const wd of ws) {
        const t2 = cur2 ? cur2 + ' ' + wd : wd;
        if (x.measureText(t2).width > maxW && cur2) { lines.push(cur2); cur2 = wd; } else cur2 = t2;
      }
      if (cur2) lines.push(cur2);
      return lines;
    };
    let lines = wrap(title, ts);
    while (lines.length > 2 && ts > u(0.05)) { ts *= 0.86; lines = wrap(title, ts); }
    lines = lines.slice(0, 2);
    x.font = '800 ' + ts + 'px "Hiragino Sans",-apple-system,sans-serif';
    x.fillStyle = '#fff';
    x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = u(0.012); x.shadowOffsetY = u(0.004);
    lines.forEach((ln, i) => x.fillText(ln, ox + u(0.055), oy + u(0.12) + i * ts * 1.02));
    x.shadowBlur = 0; x.shadowOffsetY = 0;

    /* ④ 盤 */
    const dr = u(0.40), cx = ox + u(0.20), cy = oy + u(0.735);
    x.save(); x.translate(cx, cy);
    x.beginPath(); x.arc(2, u(0.008), dr, 0, 7); x.fillStyle = 'rgba(0,0,0,.35)'; x.fill();
    x.rotate(spin);
    x.beginPath(); x.arc(0, 0, dr, 0, 7); x.save(); x.clip();
    /* 盤の地。ジャケットの色を薄く敷き、銀を混ぜる */
    if (ok) { const z = dr * 4; x.drawImage(im, -z, -z, z * 2, z * 2); }
    const base = x.createRadialGradient(0, 0, dr * 0.2, 0, 0, dr);
    base.addColorStop(0,   'rgba(214,222,232,.62)');
    base.addColorStop(.55, 'rgba(186,198,212,.58)');
    base.addColorStop(1,   'rgba(150,164,182,.66)');
    x.fillStyle = base; x.fillRect(-dr, -dr, dr * 2, dr * 2);

    /* 虹は光の回折。角度で色が回るので、円錐の色回しを重ねる。
       盤の縁ほど強く、中心ほど弱い。回転に合わせて色も流れる。 */
    if (x.createConicGradient) {
      const cg = x.createConicGradient(spin * 0.6, 0, 0);
      const turns = 5;
      for (let i = 0; i <= turns * 6; i++) {
        const t = i / (turns * 6);
        const hue = (t * 360 * turns) % 360;
        cg.addColorStop(t, `hsla(${hue}, 92%, 62%, .5)`);
      }
      x.save();
      x.globalCompositeOperation = 'overlay';
      x.fillStyle = cg; x.fillRect(-dr, -dr, dr * 2, dr * 2);
      /* 中心側は虹を弱める */
      const fade = x.createRadialGradient(0, 0, 0, 0, 0, dr);
      fade.addColorStop(0,   'rgba(0,0,0,1)');
      fade.addColorStop(.34, 'rgba(0,0,0,.55)');
      fade.addColorStop(1,   'rgba(0,0,0,0)');
      x.globalCompositeOperation = 'destination-out';
      x.fillStyle = fade; x.fillRect(-dr, -dr, dr * 2, dr * 2);
      x.restore();
    } else {
      /* 円錐が使えない環境向けの控え */
      const sh0 = x.createLinearGradient(-dr, -dr, dr, dr);
      ['rgba(255,120,160,.30)','rgba(255,225,120,.28)','rgba(120,255,200,.26)',
       'rgba(120,190,255,.30)','rgba(210,140,255,.28)'].forEach((c2, k, arr) =>
        sh0.addColorStop(k / (arr.length - 1), c2));
      x.fillStyle = sh0; x.fillRect(-dr, -dr, dr * 2, dr * 2);
    }

    /* 光が当たっている一筋。盤の艶はこれで出る */
    const spec = x.createLinearGradient(-dr, -dr * 0.6, dr * 0.4, dr);
    spec.addColorStop(0,   'rgba(255,255,255,0)');
    spec.addColorStop(.42, 'rgba(255,255,255,.50)');
    spec.addColorStop(.52, 'rgba(255,255,255,.62)');
    spec.addColorStop(.62, 'rgba(255,255,255,.18)');
    spec.addColorStop(1,   'rgba(255,255,255,0)');
    x.fillStyle = spec; x.fillRect(-dr, -dr, dr * 2, dr * 2);
    x.restore();
    /* 盤面の円周に曲名を刷る（実物の曲目表示に相当） */
    const ring = trackTitle(tk).toUpperCase().slice(0, 46);
    x.save(); x.font = '600 ' + u(0.026) + 'px "Hiragino Sans",-apple-system,sans-serif';
    x.fillStyle = 'rgba(255,255,255,.82)'; x.textAlign = 'center'; x.textBaseline = 'middle';
    /* 文字は接線に沿わせる。余計に半回転させると裏返って読めなくなる。 */
    const step = Math.min(0.115, (Math.PI * 1.5) / Math.max(1, ring.length));
    const start = -((ring.length - 1) * step) / 2;
    for (let i = 0; i < ring.length; i++) {
      x.save(); x.rotate(start + i * step); x.translate(0, -dr * 0.84);
      x.fillText(ring[i], 0, 0); x.restore();
    }
    x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.restore();
    x.save(); x.beginPath(); x.arc(0, 0, dr, 0, 7); x.clip();
    x.lineWidth = 1;
    for (let i = 0; i < 46; i++) {
      const rr2 = dr * (0.33 + i * 0.0148);
      x.strokeStyle = i % 2 ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.05)';
      x.beginPath(); x.arc(0, 0, rr2, 0, 7); x.stroke();
    }
    x.restore();
    /* 中心の透明な輪。実物は素通しに近い */
    x.beginPath(); x.arc(0, 0, dr * 0.235, 0, 7);
    x.fillStyle = 'rgba(245,249,255,.34)'; x.fill();
    x.strokeStyle = 'rgba(255,255,255,.45)'; x.lineWidth = 1; x.stroke();
    x.beginPath(); x.arc(0, 0, dr * 0.185, 0, 7);
    x.strokeStyle = 'rgba(180,200,220,.55)'; x.stroke();
    x.beginPath(); x.arc(0, 0, dr * 0.155, 0, 7);
    x.fillStyle = 'rgba(228,238,248,.55)'; x.fill();
    x.beginPath(); x.arc(0, 0, dr * 0.070, 0, 7);
    x.fillStyle = 'rgba(12,14,18,.92)'; x.fill();
    x.restore();
    x.beginPath(); x.arc(cx, cy, dr, 0, 7);
    x.strokeStyle = 'rgba(255,255,255,.20)'; x.lineWidth = 1; x.stroke();

    /* ⑤ 盤の右の札。アーティストと曲名 */
    const spot = ok ? quietSpot(im, al.id) : 'br';
    const bx = BOXES[spot] || BOXES.br;
    const px = ox + u(bx[0]), pw = S0 - u(bx[0]) - u(0.04);
    const ph = u(BOXH[spot] || 0.235), py = oy + u(bx[1]);
    x.fillStyle = 'rgba(226,222,196,.93)';
    x.fillRect(px, py, pw, ph);
    x.strokeStyle = 'rgba(150,148,120,.9)'; x.lineWidth = Math.max(1, u(0.004));
    x.strokeRect(px + u(0.008), py + u(0.008), pw - u(0.016), ph - u(0.016));
    x.lineWidth = 1;
    const artist = artistOf(al) || cleanName(al.name);
    let as = u(0.062);
    x.font = '800 italic ' + as + 'px "Hiragino Sans",-apple-system,sans-serif';
    while (x.measureText(artist).width > pw - u(0.06) && as > u(0.026)) {
      as *= 0.9; x.font = '800 italic ' + as + 'px "Hiragino Sans",-apple-system,sans-serif';
    }
    x.fillStyle = '#1b7fc4';
    x.fillText(artist, px + u(0.03), py + u(0.075));
    let ns = u(0.042);
    const name = trackTitle(tk);
    x.font = 'italic ' + ns + 'px "Hiragino Mincho ProN",Georgia,serif';
    while (x.measureText(name).width > pw - u(0.06) && ns > u(0.02)) {
      ns *= 0.9; x.font = 'italic ' + ns + 'px "Hiragino Mincho ProN",Georgia,serif';
    }
    x.fillStyle = '#2a2a26';
    x.fillText(name, px + u(0.03), py + u(0.145));
    x.font = u(0.03) + 'px "Hiragino Sans",-apple-system,sans-serif';
    x.fillStyle = 'rgba(60,58,50,.85)';
    x.fillText(cleanName(al.name), px + u(0.03), py + u(0.198));

    /* ⑥ 左下の L／R */
    drawMeter(x, u, ox, oy, S0, spot);
    x.restore();
    x.beginPath(); x.rect(ox - 1, oy - 1, S0 + 2, S0 + 2);
    x.strokeStyle = `rgba(255,255,255,${0.05 + beatE * 0.22})`;
    x.lineWidth = 1.5 + beatE * 2; x.stroke(); x.lineWidth = 1;
  },
  /* バブル期の据置コンポ。太い段、緑→琥珀→赤、天井が少し留まる。 */
  bubble(x, w, h) {
    const pad = Math.min(w, h) * 0.05;
    const W = w - pad * 2, H = h - pad * 2;
    x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, w, h);
    /* ヘアライン仕上げの前面板 */
    const pn = x.createLinearGradient(0, pad, 0, pad + H);
    pn.addColorStop(0, '#22242a'); pn.addColorStop(.5, '#171920'); pn.addColorStop(1, '#101217');
    x.fillStyle = pn; x.fillRect(pad, pad, W, H);
    for (let y = pad; y < pad + H; y += 3) {
      x.fillStyle = 'rgba(255,255,255,.015)'; x.fillRect(pad, y, W, 1);
    }
    x.strokeStyle = 'rgba(0,0,0,.7)'; x.strokeRect(pad + .5, pad + .5, W - 1, H - 1);
    const n = 14, rows = 16;
    const gx = pad + W * 0.06, gw = W * 0.88;
    const cw = gw / n, cellW = cw * 0.66;
    const gy = pad + H * 0.14, gh = H * 0.64, ch = gh / rows;
    for (let i = 0; i < n; i++) {
      const v = band[Math.floor(i * BANDS / n)];
      const lit = Math.round(v * rows);
      const pk = Math.round(peakB[Math.floor(i * BANDS / n)] * rows);
      for (let r = 0; r < rows; r++) {
        const on = r < lit, isPk = (r === pk - 1);
        const f = r / rows;
        const col = f > 0.82 ? [255, 76, 60] : f > 0.60 ? [255, 176, 58] : [86, 230, 140];
        x.fillStyle = on ? `rgb(${col[0]},${col[1]},${col[2]})`
                   : isPk ? `rgba(${col[0]},${col[1]},${col[2]},.55)`
                          : `rgba(${col[0]},${col[1]},${col[2]},.07)`;
        const yy = gy + gh - (r + 1) * ch;
        x.fillRect(gx + i * cw + (cw - cellW) / 2, yy + ch * 0.16, cellW, ch * 0.68);
        if (on && f > 0.6) {
          x.shadowColor = x.fillStyle; x.shadowBlur = ch * 0.5;
          x.fillRect(gx + i * cw + (cw - cellW) / 2, yy + ch * 0.16, cellW, ch * 0.68);
          x.shadowBlur = 0;
        }
      }
    }
    /* 目盛りと文字 */
    x.fillStyle = 'rgba(220,225,235,.55)';
    x.font = '600 ' + Math.round(H * 0.032) + 'px "Barlow Condensed",-apple-system,sans-serif';
    const labels = ['63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
    labels.forEach((t, k) => {
      const px = gx + gw * (k / (labels.length - 1));
      x.fillText(t, px - H * 0.012, gy + gh + H * 0.055);
    });
    x.fillStyle = 'rgba(255,176,58,.85)';
    x.font = '700 ' + Math.round(H * 0.042) + 'px "Barlow Condensed",-apple-system,sans-serif';
    x.fillText('SPECTRUM ANALYZER', gx, pad + H * 0.10);
    x.fillStyle = 'rgba(160,170,185,.6)';
    x.fillText((lvL * 100).toFixed(0).padStart(3, '0') + ' / ' + (lvR * 100).toFixed(0).padStart(3, '0'),
               gx + gw - H * 0.20, pad + H * 0.10);
  },

  /* 現場の卓に近い見え方。dB目盛り、天井の保持、細かい帯。 */
  pro(x, w, h) {
    x.fillStyle = '#0b0d10'; x.fillRect(0, 0, w, h);
    const L = w * 0.075, R = w * 0.985, T = h * 0.10, B = h * 0.80;
    const dbs = [0, -6, -12, -18, -24, -30, -40, -50, -60];
    x.font = Math.round(h * 0.026) + 'px "Roboto Mono",ui-monospace,monospace';
    dbs.forEach(db => {
      const y = T + (B - T) * (db / -60);
      x.strokeStyle = db === 0 ? 'rgba(255,90,70,.5)' : 'rgba(255,255,255,.10)';
      x.beginPath(); x.moveTo(L, y + .5); x.lineTo(R, y + .5); x.stroke();
      x.fillStyle = 'rgba(180,190,205,.75)';
      x.fillText(String(db), w * 0.012, y + h * 0.010);
    });
    const n = BANDS, bw = (R - L) / n;
    for (let i = 0; i < n; i++) {
      const v = band[i];
      const db = v > 0.001 ? Math.max(-60, 20 * Math.log10(v)) : -60;
      const y = T + (B - T) * (db / -60);
      const g2 = x.createLinearGradient(0, B, 0, y);
      g2.addColorStop(0, 'rgba(92,200,255,.35)'); g2.addColorStop(1, 'rgba(92,200,255,.95)');
      x.fillStyle = g2;
      x.fillRect(L + i * bw, y, Math.max(1, bw - 1), B - y);
      const pv = peakB[i];
      const pdb = pv > 0.001 ? Math.max(-60, 20 * Math.log10(pv)) : -60;
      const py2 = T + (B - T) * (pdb / -60);
      x.fillStyle = 'rgba(255,255,255,.85)';
      x.fillRect(L + i * bw, py2 - 1, Math.max(1, bw - 1), 1.5);
    }
    /* 周波数目盛り */
    x.fillStyle = 'rgba(150,160,175,.7)';
    ['31','63','125','250','500','1k','2k','4k','8k','16k'].forEach((t, k, arr) => {
      const px = L + (R - L) * (k / (arr.length - 1));
      x.fillText(t, px - h * 0.012, B + h * 0.045);
    });
    /* 右下に L/R の数値 */
    const dbv = v => (v > 0.001 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
    x.font = '500 ' + Math.round(h * 0.034) + 'px "Roboto Mono",ui-monospace,monospace';
    x.fillStyle = 'rgba(230,235,245,.9)';
    x.fillText('L ' + dbv(lvL).padStart(6) + ' dB', L, h * 0.945);
    x.fillText('R ' + dbv(lvR).padStart(6) + ' dB', L + w * 0.30, h * 0.945);
  },

  disc(x, w, h, al) {
    const cx = w/2, cy = h/2, rad = Math.min(w,h)*0.36, im = coverImage(al);
    x.save(); x.translate(cx, cy); x.rotate(spin);
    x.beginPath(); x.arc(0,0,rad,0,7);
    if (im && im.complete && im.naturalWidth) { x.save(); x.clip(); x.drawImage(im,-rad,-rad,rad*2,rad*2); x.restore(); }
    else { x.fillStyle = '#22222b'; x.fill(); }
    const sh = x.createLinearGradient(-rad,-rad,rad,rad);
    sh.addColorStop(0,'rgba(255,255,255,.20)'); sh.addColorStop(.35,'rgba(255,255,255,0)');
    sh.addColorStop(.62,'rgba(255,255,255,.13)'); sh.addColorStop(1,'rgba(255,255,255,0)');
    x.beginPath(); x.arc(0,0,rad,0,7); x.fillStyle = sh; x.fill();
    x.restore();
    x.strokeStyle = 'rgba(0,0,0,.3)';
    for (let i=1;i<7;i++){ x.beginPath(); x.arc(cx,cy,rad*(0.3+i*0.1),0,7); x.stroke(); }
    x.beginPath(); x.arc(cx,cy,rad*0.15,0,7); x.fillStyle='#0b0b0f'; x.fill();
    x.strokeStyle='rgba(255,255,255,.16)'; x.stroke();
    x.beginPath(); x.arc(cx,cy,rad+4+beatE*7,0,7);
    x.strokeStyle=`rgba(110,168,254,${0.16+beatE*0.5})`; x.lineWidth=2; x.stroke(); x.lineWidth=1;
  },
  ladder(x, w, h) {
    const pad = Math.max(40, w*0.11), seg = Math.floor((w-pad-24)/11);
    [['L',lvL,pkL],['R',lvR,pkR]].forEach((rw,ri) => {
      const y = h*(ri?0.58:0.42);
      x.fillStyle='#8b8b99'; x.font='600 14px -apple-system,sans-serif'; x.fillText(rw[0], pad-26, y+5);
      for (let i=0;i<seg;i++) {
        const f=i/seg, on=f<rw[1], pk=Math.abs(f-rw[2])<1/seg;
        x.fillStyle = on ? (f>0.86?'#e06c75':f>0.66?'#e5a34a':'#5fbf7f')
                    : pk ? 'rgba(255,255,255,.6)' : 'rgba(255,255,255,.07)';
        x.fillRect(pad+i*11, y-9, 8, 18);
      }
    });
  },
  bars(x, w, h) {
    const bw = w/BANDS;
    for (let i=0;i<BANDS;i++) {
      const bh = band[i]*h*0.7;
      const g = x.createLinearGradient(0,h,0,h-bh);
      g.addColorStop(0,'rgba(95,191,127,.95)'); g.addColorStop(.6,'#e5a34a'); g.addColorStop(1,'#e06c75');
      x.fillStyle=g; x.fillRect(i*bw+1, h-bh, bw-2, bh);
      x.fillStyle='rgba(255,255,255,.75)'; x.fillRect(i*bw+1, h-peakB[i]*h*0.7-2, bw-2, 2);
    }
  },
  mirror(x, w, h) {
    const bw = w/BANDS, mid = h/2;
    for (let i=0;i<BANDS;i++) {
      const v = band[i], bh = v*h*0.42, hue = 205-v*165;
      x.fillStyle = `hsl(${hue} 84% ${44+v*24}%)`;
      x.fillRect(i*bw+1, mid-bh, bw-2, bh);
      x.globalAlpha=.32; x.fillRect(i*bw+1, mid+2, bw-2, bh*0.7); x.globalAlpha=1;
    }
  },
  scope(x, w, h) {
    x.beginPath();
    for (let i=0;i<wav.length;i++) {
      const px=i/(wav.length-1)*w, py=h/2-wav[i]*h*0.34;
      i?x.lineTo(px,py):x.moveTo(px,py);
    }
    x.strokeStyle='#5fbf7f'; x.lineWidth=2; x.shadowColor='#5fbf7f'; x.shadowBlur=10;
    x.stroke(); x.shadowBlur=0; x.lineWidth=1;
  },
  ring(x, w, h, al) {
    const cx=w/2, cy=h/2, r0=Math.min(w,h)*0.20, im=coverImage(al);
    x.save(); x.translate(cx,cy);
    x.beginPath(); x.arc(0,0,r0-4,0,7);
    if (im && im.complete && im.naturalWidth) { x.save(); x.clip(); x.drawImage(im,-r0,-r0,r0*2,r0*2); x.restore(); }
    else { x.fillStyle='#22222b'; x.fill(); }
    for (let i=0;i<BANDS;i++) {
      const a=i/BANDS*Math.PI*2-Math.PI/2, v=band[i], l=6+v*Math.min(w,h)*0.24;
      x.beginPath();
      x.moveTo(Math.cos(a)*r0, Math.sin(a)*r0);
      x.lineTo(Math.cos(a)*(r0+l), Math.sin(a)*(r0+l));
      x.strokeStyle=`hsl(${210-v*30} 90% ${50+v*24}%)`; x.lineWidth=3; x.stroke();
    }
    x.lineWidth=1; x.restore();
  },
  vu(x, w, h) {
    [0,1].forEach(k => {
      const cx=w*(k?0.72:0.28), cy=h*0.68, r=Math.min(w*0.2,h*0.3);
      x.fillStyle='#e9e2cf';
      x.fillRect(cx-r*1.12, cy-r*0.92, r*2.24, r*1.02+12);
      for (let i=0;i<=10;i++) {
        const a=Math.PI*(1.13-i/10*0.86);
        x.beginPath();
        x.moveTo(cx+Math.cos(a)*r*0.80, cy-Math.sin(a)*r*0.80);
        x.lineTo(cx+Math.cos(a)*r*0.92, cy-Math.sin(a)*r*0.92);
        x.strokeStyle=i>7?'rgba(190,40,30,.9)':'rgba(40,35,30,.8)'; x.lineWidth=i>7?2:1; x.stroke();
      }
      const v=(k?lvR:lvL), a=Math.PI*(1.13-Math.min(v,1)*0.86);
      x.beginPath(); x.moveTo(cx,cy); x.lineTo(cx+Math.cos(a)*r*0.88, cy-Math.sin(a)*r*0.88);
      x.strokeStyle='#1b1b1b'; x.lineWidth=2; x.stroke();
      x.fillStyle='#1b1b1b'; x.beginPath(); x.arc(cx,cy,3.5,0,7); x.fill();
      x.lineWidth=1;
    });
  },
  parts: (() => {
    const P2 = []; for (let i=0;i<140;i++) P2.push({a:Math.random()*7, r:Math.random(), s:.3+Math.random()});
    return (x, w, h) => {
      const cx=w/2, cy=h/2, R0=Math.min(w,h)*0.44;
      P2.forEach((p,i) => {
        const v = band[i % BANDS];
        p.a += (0.1+p.s*0.28)*0.016*(1+beatE*2.4);
        const rr=(p.r*0.7+0.3+v*0.34)*R0;
        x.beginPath(); x.arc(cx+Math.cos(p.a)*rr*1.45, cy+Math.sin(p.a)*rr, 1+v*3.4*p.s, 0, 7);
        x.fillStyle=`hsla(${200+v*70} 90% ${56+v*18}% / ${0.22+v*0.7})`; x.fill();
      });
    };
  })(),
};

function screenNow() {
  const c = cur();
  if (!c) { go('#/lib'); return; }
  $('#hdr').classList.add('hide');
  const list = S.vis.length ? S.vis : ['disc'];
  if (V.vi >= list.length) V.vi = 0;
  main().innerHTML = `
    <div class="now">
      <div class="nowtop">
        <button class="hbtn" id="nclose">✕</button>
        <div class="nowinfo"><div class="nt" id="nti"></div><div class="na" id="nar"></div></div>
        <button class="hbtn" id="npick">⚙</button>
      </div>
      <div class="nowwrap">
        <div class="nowcv"><canvas id="vcv"></canvas></div>
        <div class="nowq" id="nowq"></div>
      </div>
      <div class="nowname" id="vname"></div>
      <div class="nowbar"><i id="nseek"></i></div>
      <div class="nowctl">
        <button id="nprev">⏮</button><button id="nplay">▶</button><button id="nnext">⏭</button>
        <button class="hbtn" id="nq">次に流れる</button>
        <button class="hbtn" id="nalb">アルバム</button>
      </div>
      <div class="msg" id="nmsg"></div>
    </div>`;
  const cv = $('#vcv'), ctx = cv.getContext('2d');
  const paintQ = () => {
    const q = $('#nowq'); if (!q) return;
    const next = P.q.slice(P.qi + 1, P.qi + 25);
    q.innerHTML = `<div class="qh">次に流れる（${Math.max(0, P.q.length - P.qi - 1)}）</div>` +
      (next.map((r, k) => `
        <button class="qi" data-nq="${P.qi + 1 + k}">
          ${coverOf(r.al) ? `<img loading="lazy" src="${esc(coverOf(r.al))}">` : '<img alt="">'}
          <span class="qt"><span class="q1">${esc(trackTitle(r.al.tracks[r.i]))}</span>
            <span class="q2">${esc(r.al.name)}${artistOf(r.al) ? ' · ' + esc(artistOf(r.al)) : ''}</span></span>
        </button>`).join('') || '<div class="qe">この曲でおしまいです</div>');
    q.querySelectorAll('[data-nq]').forEach(b => b.onclick = () => { playAt(+b.dataset.nq); });
  };
  const paint = () => {
    const cc = cur(), el = $('#nti');
    /* 画面を離れた後も呼ばれることがある。要素が無ければ何もしない。 */
    if (!cc || !el) return;
    el.textContent = trackTitle(cc.al.tracks[cc.i]);
    const ar = $('#nar'), vn = $('#vname'), pl = $('#nplay');
    if (ar) {
      ar.textContent = [artistOf(cc.al), cc.al.name].filter(Boolean).join(' — ');
      ar.style.cursor = 'pointer';
      ar.onclick = () => go('#/album/' + cc.al.id);
    }
    if (vn) vn.textContent = (VIS[list[V.vi]] || VIS.disc)[0] + `（${V.vi + 1}/${list.length}・画面を触ると切り替え）`;
    if (pl) pl.textContent = au.paused ? '▶' : '⏸';
    paintQ();
  };
  paint();
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width*dpr); cv.height = Math.round(r.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
  };
  fit(); addEventListener('resize', fit);

  let last = 0;
  const frame = now => {
    if (location.hash !== '#/now') { V.on = false; return; }
    V.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now-last)/1000 || 0.016); last = now;
    if (!au.paused) spin += dt*1.1;
    const live = readAudio(dt);
    const cc = cur(); if (!cc) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    ctx.clearRect(0,0,w,h); ctx.fillStyle='#0b0b0f'; ctx.fillRect(0,0,w,h);
    const key = list[V.vi];
    (VD[key] || VD.disc)(ctx, w, h, cc.al);
    if (VIS[key] && VIS[key][1] && !live) {
      ctx.fillStyle='rgba(139,139,153,.85)'; ctx.font='13px -apple-system,sans-serif';
      ctx.textAlign='center';
      ctx.fillText('音を解析できていません。回転ジャケットなら動きます', w/2, h-14);
      ctx.textAlign='left';
    }
  };
  V.on = true; cancelAnimationFrame(V.raf); V.raf = requestAnimationFrame(frame);

  cv.onclick = () => { V.vi = (V.vi + 1) % list.length; paint(); };
  $('#nclose').onclick = () => go('#/lib');
  $('#nprev').onclick  = () => { prevTrack(); setTimeout(paint, 60); };
  $('#nnext').onclick  = () => { nextTrack(); setTimeout(paint, 60); };
  $('#nplay').onclick  = () => { au.paused ? au.play().catch(() => {}) : au.pause(); setTimeout(paint, 60); };
  $('#nq').onclick     = () => go('#/queue');
  $('#nalb').onclick   = () => { const c2 = cur(); if (c2) go('#/album/' + c2.al.id); };
  $('#npick').onclick  = () => nowSheet();
  /* 画面を開くたびに見張りを足していたので、離れた後も呼ばれて落ちていた。
     前の分を必ず外してから足す。 */
  if (V.watch) {
    au.removeEventListener('play', V.watch.p); au.removeEventListener('pause', V.watch.p);
    au.removeEventListener('timeupdate', V.watch.t);
    removeEventListener('resize', V.watch.f);
  }
  const onTime = () => {
    const b = $('#nseek'); if (b && au.duration) b.style.width = (au.currentTime / au.duration * 100) + '%';
  };
  V.watch = { p: paint, t: onTime, f: fit };
  au.addEventListener('play', paint); au.addEventListener('pause', paint);
  au.addEventListener('timeupdate', onTime);
  /* 解析はここで初めて繋ぐ。読めない音を通すと無音になるので、確かめてから。 */
  (async () => {
    const cc = cur(); if (!cc) return;
    showTapState();
    if (V.ok) return;                       /* すでに繋がっている */
    const src = au.currentSrc || au.src || '';
    const own = src.startsWith('blob:') || src.startsWith(location.origin);
    /* 読める音かどうかは、実際に印を付けて読み込み直してみるのが確か。
       通れば解析でき、通らなければ元に戻す（音は止めない）。 */
    /* まず鳴っている出力から拾う。ファイルの中身が読めなくても関係ない。 */
    if (!own && await tapElement()) { paint(); return; }
    if (!own && !(await tryCors()) && !(await bufferHere(cc))) {
      $('#nmsg').className = 'msg';
      showTapState();
      note('解析しない（読めない音）');
      return;
    }
    initGraph();
    if (V.ctx && V.ctx.state === 'suspended') { try { await V.ctx.resume(); } catch (e) {} }
    if (!V.ok) {
      $('#nmsg').className = 'msg';
      $('#nmsg').textContent = '解析器を作れませんでした。回転ジャケットなら動きます';
    }
  })();
}

/* いま本物か飾りかを、常に見せる。切り替えもここから。 */
function showTapState() {
  const el = $('#nmsg'); if (!el) return;
  if (V.ok) {
    el.innerHTML = '<b>本物の波形</b>（' +
      (V.tap === 'tab' ? 'タブの音から' : V.tap === 'element' ? '再生の出力から' : '音そのものから') + '）';
    return;
  }
  el.innerHTML = (S.deco ? '<b>飾り</b>で動かしています。' : '止まっています。') +
    ' <button class="hbtn" id="ntap" style="padding:5px 10px;font-size:12px">本物の波形にする</button>' +
    '<br><span style="font-size:11.5px">押すと共有の窓が出ます。<b>このタブ</b>を選び、' +
    '<b>「タブの音声も共有」に印</b>を付けてください。映像は使いません。一度で以後ずっと効きます。</span>';
  const nt = $('#ntap');
  if (nt) nt.onclick = async () => {
    nt.textContent = '拾っています…';
    if (await tapElement() || await tapTab()) { showTapState(); toast('本物の波形になりました', 3000); }
    else { nt.textContent = 'もう一度試す'; }
  };
}

function screenVis() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = 'ビジュアライザー';
  $('#btnCovers').classList.add('hide');
  main().innerHTML = `
    <div class="rowlist">${Object.keys(VIS).map(k => `
      <button class="row" data-v="${k}">
        <span class="nm">${VIS[k][0]}${VIS[k][1] ? '' : '<br><span class="sub">音の解析が要りません。何があっても動きます</span>'}</span>
        <span class="chk ${S.vis.includes(k) ? 'on' : ''}">${S.vis.includes(k) ? '✓' : ''}</span>
      </button>`).join('')}</div>
    <div class="rowlist" style="margin-top:14px">
      <button class="row" id="deco">
        <span class="nm">音が読めないときも動かす<br>
          <span class="sub">pCloud から直に流している音は中身を読めないので、本物の音量は出せません。
          入にすると<b>曲に合わせた飾り</b>として動かします（本物の波形ではありません）。
          切ると止まったままになります。</span></span>
        <span class="chk ${S.deco ? 'on' : ''}">${S.deco ? '✓' : ''}</span>
      </button>
    </div>
    <div class="rowlist" style="margin-top:14px">
      <button class="row" id="tapgo">
        <span class="nm">${V.ok ? '本物の波形で動いています' : '本物の波形にする'}<br>
          <span class="sub">${V.ok
            ? '鳴っている音から拾えています。'
            : 'pCloud から直に流している音は中身を読めないので、鳴っている出力から拾います。押すと共有の窓が出るので「このタブ」を選び「タブの音声も共有」に印を付けてください。'}</span></span>
        <span class="chk ${V.ok ? 'on' : ''}">${V.ok ? '✓' : ''}</span>
      </button>
    </div>
    <div class="sect" style="margin-top:18px">レベル計の見た目</div>
    <div class="rowlist">${Object.entries(METERS).map(([k, n]) => `
      <button class="row" data-m="${k}"><span class="nm">${n}</span>
        <span class="chk ${S.meter === k ? 'on' : ''}">${S.meter === k ? '✓' : ''}</span></button>`).join('')}</div>
    <div class="note" style="padding:12px 2px 0">選んだものを、再生画面で触るたびに順に切り替えます。</div>`;
  $('#tapgo').onclick = async () => {
    if (V.ok) { toast('すでに本物です'); return; }
    if (await tapElement() || await tapTab()) { toast('本物の波形になりました', 3000); }
    screenVis();
  };
  $('#deco').onclick = () => { S.deco = !S.deco; LS.set('deco', S.deco); screenVis(); };
  main().querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    S.meter = b.dataset.m; LS.set('meter', S.meter); screenVis();
  });
  main().querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
    const k = b.dataset.v;
    S.vis = S.vis.includes(k) ? S.vis.filter(x => x !== k) : S.vis.concat(k);
    if (!S.vis.length) S.vis = ['disc'];
    LS.set('vis', S.vis); V.vi = 0; screenVis();
  });
  $('#back').onclick = () => go(cur() ? '#/now' : '#/lib');
}

/* ============ オフライン保存 ============ */
/* 直リンクが CORS を返さない場合に備え、api 経由の読み出しに落ちる道を用意する。 */
const MIME = { mp3:'audio/mpeg', m4a:'audio/mp4', m4b:'audio/mp4', aac:'audio/aac',
               flac:'audio/flac', wav:'audio/wav', ogg:'audio/ogg', opus:'audio/ogg',
               aiff:'audio/aiff', aif:'audio/aiff', wma:'audio/x-ms-wma' };
const mimeOf = name => MIME[ext(name)] || 'audio/mpeg';

/* pCloud の getfilelink はウェブアプリからは使えない（参照元が pcloud.com に限定されている）。
   その場合は api 経由で中身を丸ごと読む。こちらは制限を受けず、
   手元に落ちるぶん解析器にも通せる（＝ビジュアライザーが確実に動く）。 */
async function fetchTrackBytes(fileid, name, onProgress) {
  if (S.relay) {
    const r = await fetch(relayUrl('/audio', { id: fileid }), { referrerPolicy: 'no-referrer' });
    if (r.ok) return r;
    throw new PCloudError(-8, '中継所から取れません（HTTP ' + r.status + '）');
  }
  try {
    const r = await fetch(await fileLink(fileid), { referrerPolicy: 'no-referrer' });
    if (r.ok) return r;
  } catch (e) { /* 直リンクが駄目なら下へ */ }
  const fd = (await api('file_open', { fileid, flags: 0 })).fd;
  try {
    const CH = 4 * 1024 * 1024, chunks = [];
    let got = 0;
    for (;;) {
      const u = new URL('https://' + S.host + '/file_read');
      u.searchParams.set('auth', S.auth); u.searchParams.set('fd', fd);
      u.searchParams.set('count', CH);
      const rr = await fetch(u, { referrerPolicy: 'no-referrer' });
      /* 中身ではなく JSON のエラーが返ることがある。気づかず繋ぐと壊れた音になる。 */
      if ((rr.headers.get('content-type') || '').includes('json')) {
        const j = await rr.json();
        throw new PCloudError(j.result, j.error || '読み出しを断られました');
      }
      const buf = await rr.arrayBuffer();
      if (!buf.byteLength) break;
      chunks.push(buf); got += buf.byteLength;
      if (onProgress) onProgress(got);
      if (buf.byteLength < CH) break;
    }
    return new Response(new Blob(chunks, { type: mimeOf(name || '') }));
  } finally { try { await api('file_close', { fd }); } catch (e) {} }
}

/* 直近の数曲だけ手元に置く。棚が1535枚あるので、際限なく溜めない。 */
const blobs = new Map();
function keepBlob(id, url) {
  blobs.set(id, url);
  while (blobs.size > 3) {
    const k = blobs.keys().next().value;
    try { URL.revokeObjectURL(blobs.get(k)); } catch (e) {}
    blobs.delete(k);
  }
}
/* 曲の出どころを決める。手元 → 直リンク → api 経由の順。 */
const relayUrl = (path, t) => S.relay.replace(/\/+$/, '') + path +
  '?fileid=' + encodeURIComponent(t.id) + '&host=' + encodeURIComponent(S.host) +
  (S.pub ? '&pub=1' : '') + '&auth=' + encodeURIComponent(S.auth);

/* 読めるかどうかは、実際に音として読ませてみるのが一番確か。
   fetch で試すと CORS で弾かれるだけで、再生できるかどうかは分からない
   （<audio> の読み込みに CORS は要らない）。 */
let probing = false;
function tryLoad(url, ms = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = ok => {
      if (done) return; done = true; probing = false;
      clearTimeout(timer);
      au.removeEventListener('loadedmetadata', onOk);
      au.removeEventListener('error', onNg);
      ok ? resolve(url) : reject(new Error('読めません'));
    };
    const onOk = () => finish(true), onNg = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    probing = true;
    au.addEventListener('loadedmetadata', onOk);
    au.addEventListener('error', onNg);
    au.src = url;
    au.load();
  });
}
async function relayLink(t) {
  try {
    const r = await fetch(relayUrl('/link', t), { referrerPolicy: 'no-referrer' });
    const j = await r.json();
    return j.url || null;
  } catch (e) { return null; }
}

async function trackSource(t) {
  const hit = await cachedResponse(t.id);
  if (hit) return { url: URL.createObjectURL(await hit.blob()), local: true };
  if (blobs.has(t.id)) return { url: blobs.get(t.id), local: true };
  /* 端末自身が発行したリンクなら pCloud は渡す。入口ごしでも同じ道を通る。 */
  if (GATE || S.code) return { url: await fileLink(t.id), local: false, cors: false };
  if (S.code) return { url: await fileLink(t.id), local: false, cors: false };
  /* 中継所がある場合の道は playAt 側で順に試す。ここでは何もしない。 */
  if (S.relay) return { url: null, relay: true, local: false, cors: true };
  if (V.link !== false) {
    try {
      const u = await fileLink(t.id);
      V.link = true;
      return { url: u, local: false };
    } catch (e) {
      V.link = false;
      note('直リンク不可（' + (e.code != null ? e.code + ' ' : '') + (e.message || '') + '）→ api 経由へ');
    }
  }
  toast('読み込んでいます…', 1500);
  const res = await fetchTrackBytes(t.id, t.name, got => {
    const mb = (got / 1048576).toFixed(1);
    const el = $('#pti'); if (el) el.textContent = '読み込み中 ' + mb + 'MB';
  });
  const url = URL.createObjectURL(await res.blob());
  keepBlob(t.id, url);
  return { url, local: true };
}
async function downloadAlbum(album, btn) {
  if (!('caches' in window)) { toast('この環境では保存できません'); return; }
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
  const c = await caches.open('tracks-v1');
  let n = 0;
  for (const t of album.tracks) {
    if (await c.match(cacheKey(t.id))) { n++; continue; }
    if (btn) btn.textContent = `保存中 ${n + 1}/${album.tracks.length}`;
    try {
      const res = await fetchTrackBytes(t.id, t.name);
      await c.put(cacheKey(t.id), new Response(await res.blob()));
      S.offline[t.id] = 1; n++;
    } catch (e) { toast('保存できない曲がありました: ' + trackTitle(t)); }
  }
  saveOffline();
  toast(`${n} 曲を端末に入れました`);
  renderRoute();
}
async function removeAlbum(album) {
  const c = await caches.open('tracks-v1');
  for (const t of album.tracks) { await c.delete(cacheKey(t.id)); delete S.offline[t.id]; }
  saveOffline(); toast('端末から消しました'); renderRoute();
}
const albumOffline = al => al.tracks.length > 0 && al.tracks.every(t => S.offline[t.id]);

/* ============ 索引を pCloud に置く（端末をまたぐため） ============ */
const INDEX_NAME = '音楽棚.json';
async function saveIndexToCloud() {
  const body = JSON.stringify({ v: 2, rootId: S.rootId, covers: S.covers, meta: S.meta,
                                fav: S.fav, lists: S.lists, at: new Date().toISOString() });
  const fd = new FormData();
  fd.append('file', new Blob([body], { type: 'application/json' }), INDEX_NAME);
  const u = new URL('https://' + S.host + '/uploadfile');
  u.searchParams.set('auth', S.auth);
  u.searchParams.set('folderid', S.rootId);
  u.searchParams.set('filename', INDEX_NAME);
  u.searchParams.set('nopartial', 1);
  const r = await fetch(u, { method: 'POST', body: fd });
  const j = await r.json();
  if (j.result !== 0) throw new PCloudError(j.result, j.error);
}
async function loadIndexFromCloud() {
  const list = await api('listfolder', { folderid: S.rootId });
  const f = (list.metadata.contents || []).find(c => !c.isfolder && c.name === INDEX_NAME);
  if (!f) return false;
  const link = await fetch(await fileLink(f.fileid));
  const j = await link.json();
  if (j && j.covers) {
    S.covers = Object.assign({}, j.covers, S.covers); saveCovers();
    if (j.meta)  { S.meta  = Object.assign({}, j.meta,  S.meta);  saveMeta(); }
    if (j.fav)   { S.fav   = Object.assign({}, j.fav,   S.fav);   saveFav(); }
    if (j.lists) { S.lists = Object.assign({}, j.lists, S.lists); saveLists(); }
    return true;
  }
  return false;
}

/* ============ 探す ============ */
/* 1535枚では、絞り込みより探す方が速い。アルバム・アーティスト・曲を一度に見る。 */
const norm = s => String(s || '').normalize('NFKC').toLowerCase()
  .replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));   // ひらがなをカタカナに寄せる
function search(q) {
  const w = norm(q).split(/\s+/).filter(Boolean);
  if (!w.length) return { albums: [], tracks: [], artists: [] };
  const hit = t => w.every(x => norm(t).includes(x));
  const albums = [], tracks = [], seenA = new Map();
  for (const al of S.albums) {
    const meta = al.name + ' ' + al.artist + ' ' + albumGenre(al) + ' ' + albumYear(al);
    if (hit(meta)) albums.push(al);
    const art = cleanName(al.artist);
    if (art && hit(art) && !seenA.has(art)) seenA.set(art, al);
    if (tracks.length < 60) {
      al.tracks.forEach((t, i) => {
        if (tracks.length < 60 && hit(t.name)) tracks.push({ al, i });
      });
    }
  }
  return { albums: albums.slice(0, 80), tracks, artists: [...seenA.entries()].slice(0, 12) };
}

function screenSearch() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '探す';
  $('#btnCovers').classList.add('hide'); $('#btnSearch').classList.add('hide');
  const q0 = LS.get('q', '');
  main().innerHTML = `
    <div class="srch"><input id="sq" placeholder="アルバム・アーティスト・曲名" value="${esc(q0)}"
      autocapitalize="off" autocorrect="off" enterkeyhint="search">
      <button class="hbtn" id="sclr">消す</button></div>
    <div id="sres"></div>`;
  const box = $('#sq');
  const draw = () => {
    const q = box.value.trim();
    LS.set('q', q);
    const r = search(q);
    const out = $('#sres');
    if (!q) { out.innerHTML = '<div class="empty">言葉を入れてください</div>'; return; }
    const n = r.albums.length + r.tracks.length + r.artists.length;
    if (!n) { out.innerHTML = '<div class="empty">見つかりません</div>'; return; }
    out.innerHTML =
      (r.artists.length ? `<div class="sect">アーティスト</div>` + r.artists.map(([nm, al]) => `
        <button class="hit2" data-artist="${esc(nm)}">
          ${coverOf(al) ? `<img src="${esc(coverOf(al))}">` : '<img alt="">'}
          <span class="t2"><span class="n2">${esc(nm)}</span>
            <span class="a2">${S.albums.filter(x => cleanName(x.artist) === nm).length} アルバム</span></span>
        </button>`).join('') : '') +
      (r.albums.length ? `<div class="sect">アルバム（${r.albums.length}）</div>` + r.albums.map(al => `
        <button class="hit2" data-alb="${al.id}">
          ${coverOf(al) ? `<img loading="lazy" src="${esc(coverOf(al))}">` : '<img alt="">'}
          <span class="t2"><span class="n2">${esc(al.name)}</span>
            <span class="a2">${esc(al.artist)} · ${al.tracks.length}曲</span></span>
        </button>`).join('') : '') +
      (r.tracks.length ? `<div class="sect">曲（${r.tracks.length}）</div>` + r.tracks.map((x, k) => `
        <button class="hit2" data-tk="${k}">
          ${coverOf(x.al) ? `<img loading="lazy" src="${esc(coverOf(x.al))}">` : '<img alt="">'}
          <span class="t2"><span class="n2">${esc(trackTitle(x.al.tracks[x.i]))}</span>
            <span class="a2">${esc(x.al.artist)} — ${esc(x.al.name)}</span></span>
        </button>`).join('') : '');
    out.querySelectorAll('[data-alb]').forEach(b => b.onclick = () => go('#/album/' + b.dataset.alb));
    out.querySelectorAll('[data-tk]').forEach(b => b.onclick = () => {
      const x = r.tracks[+b.dataset.tk]; play(x.al, x.i);
    });
    out.querySelectorAll('[data-artist]').forEach(b => b.onclick = () => {
      box.value = b.dataset.artist; draw();
    });
  };
  let timer = null;
  box.oninput = () => { clearTimeout(timer); timer = setTimeout(draw, 160); };
  box.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); draw(); box.blur(); } };
  $('#sclr').onclick = () => { box.value = ''; draw(); box.focus(); };
  draw();
  setTimeout(() => { if (!q0) box.focus(); }, 60);
  $('#back').onclick = () => go('#/lib');
}

/* ============ 車モード ============ */
/* 走っているときは、狙わずに押せることが全て。字も的も大きく、選択肢は少なく。 */
function screenCar() {
  let c = cur();
  if (!c) {
    /* 何も鳴っていなければ、その場で棚から適当に流し始める。
       走り出す前に曲を選ばせない。 */
    startQueue(shuffle(S.albums.flatMap(albumRefs)).slice(0, 200), 0);
    c = cur();
    if (!c) { toast('棚が空です'); go('#/lib'); return; }
  }
  $('#hdr').classList.add('hide');
  main().innerHTML = `
    <div class="car">
      <div class="top">
        <button id="cx">✕ もどる</button>
        <button id="cshuf">🔀 シャッフル</button>
      </div>
      <div class="art"><img id="cimg" alt=""></div>
      <div class="ti2" id="cti"></div>
      <div class="ar2" id="car2"></div>
      <div class="bar2"><i id="cbar"></i></div>
      <div class="ctl2">
        <button id="cprev">⏮</button>
        <button id="cplay" class="big">▶</button>
        <button id="cnext">⏭</button>
      </div>
      <div class="volbig">
        <button id="cmute" aria-label="消音">🔊</button>
        <input id="cvol" type="range" min="0" max="100" step="1" aria-label="音量">
      </div>
    </div>`;
  const paint = () => {
    const cc = cur(), t = $('#cti'); if (!cc || !t) return;
    t.textContent = trackTitle(cc.al.tracks[cc.i]);
    $('#car2').textContent = [artistOf(cc.al), cc.al.name].filter(Boolean).join(' — ');
    const cv = coverOf(cc.al);
    $('#cimg').src = cv || '';
    $('#cimg').style.visibility = cv ? 'visible' : 'hidden';
    $('#cplay').textContent = au.paused ? '▶' : '⏸';
  };
  const onT = () => { const b = $('#cbar'); if (b && au.duration) b.style.width = (au.currentTime / au.duration * 100) + '%'; };
  paint(); onT();
  if (V.carw) { au.removeEventListener('play', V.carw.p); au.removeEventListener('pause', V.carw.p);
                au.removeEventListener('timeupdate', V.carw.t); }
  V.carw = { p: paint, t: onT };
  au.addEventListener('play', paint); au.addEventListener('pause', paint);
  au.addEventListener('timeupdate', onT);
  $('#cx').onclick    = () => go('#/lib');
  $('#cplay').onclick = () => { au.paused ? au.play().catch(() => {}) : au.pause(); setTimeout(paint, 60); };
  $('#cprev').onclick = () => { prevTrack(); setTimeout(paint, 80); };
  $('#cnext').onclick = () => { nextTrack(); setTimeout(paint, 80); };
  paintVol();
  $('#cvol').oninput  = e => setVol(+e.target.value / 100, true);
  $('#cmute').onclick = () => { au.muted = !au.muted; paintVol(); };
  $('#cshuf').onclick = () => { const cc = cur(); P.q = shuffle(P.q); P.qi = cc ? P.q.indexOf(cc) : 0; toast('並べ直しました'); };
  /* 走行中に画面が消えると操作できないので、開いている間は点けておく */
  if (navigator.wakeLock && !V.lock) {
    navigator.wakeLock.request('screen').then(l => { V.lock = l; l.addEventListener('release', () => { V.lock = null; }); })
      .catch(() => {});
  }
}

/* ============ 索引の持ち出しと取り込み ============ */
/* ジャケットや★は置き場（オリジン）ごとにしまわれる。
   入口へ移ると前の棚の記録が見えなくなるので、файл で持ち運べるようにする。 */
function exportIndex() {
  const body = JSON.stringify({
    v: 3, at: new Date().toISOString(), rootName: S.rootName,
    covers: S.covers, meta: S.meta, fav: S.fav, lists: S.lists,
    plays: S.plays, hist: S.hist.slice(0, 200),
    byPath: Object.fromEntries(S.albums
      .filter(al => S.covers[al.id])
      .map(al => [pathKey(al), S.covers[al.id]])),
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = '音楽棚.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('書き出しました');
}
/* フォルダの道を鍵にする。棚を読み直しても、置き場が変わっても同じ物を指せる。 */
const nfc = s => (s || '').normalize('NFC');
const pathKey = al => nfc(String(al.path || '').split(' / ').slice(1).join('/')) || nfc(al.artist + '/' + al.name);

function applyIndex(j) {
  let n = 0;
  if (j.covers) { for (const [k, v] of Object.entries(j.covers)) if (!S.covers[k]) { S.covers[k] = v; n++; } }
  if (j.meta)   S.meta  = Object.assign({}, j.meta, S.meta);
  if (j.fav)    S.fav   = Object.assign({}, j.fav, S.fav);
  if (j.lists)  S.lists = Object.assign({}, j.lists, S.lists);
  if (j.plays)  S.plays = Object.assign({}, j.plays, S.plays);
  /* 道を鍵にしたものは、いまの棚に当て直す（別の置き場から来たとき用） */
  if (j.byPath) {
    const byKey = new Map(S.albums.map(al => [pathKey(al), al]));
    for (const [k, v] of Object.entries(j.byPath)) {
      if (v && v.skip) continue;
      const al = byKey.get(nfc(k));
      if (al && !S.covers[al.id]) {
        S.covers[al.id] = { url: v.url, src: v.src, q: v.q, manual: !!v.manual,
                            score: v.score, sure: v.sure !== false };
        if (v.g || v.y) S.meta[al.id] = { g: v.g || '', y: v.y || '' };
        n++;
      }
    }
  }
  saveCovers(); saveMeta(); saveFav(); saveLists(); savePlays();
  return n;
}
function importIndex(file, done) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const n = applyIndex(JSON.parse(r.result));
      toast(n + ' 枚ぶん取り込みました' + (LS.full ? '（★記憶が一杯）' : ''), 4000);
      note('索引を取り込んだ: ' + n);
      S.albums = []; done && done();
    } catch (e) { toast('読めません: ' + (e.message || e), 5000); }
  };
  r.readAsText(file);
}

/* ============ 画面 ============ */
/* ハッシュが同じだと hashchange が飛ばない。
   #/pick/0 が付いたまま開き直してログインすると、成功しても画面が変わらず
   「つないでいます…」のまま固まる（実際に踏んだ）。同じときは自分で描き直す。 */
/* 画面ごとに見ていた位置を覚える。1535枚の棚で毎回頭に戻されるのは苦行。 */
const scrollMem = Object.create(null);
try { history.scrollRestoration = 'manual'; } catch (e) {}
const hashNow = () => location.hash || '#/lib';
function keepScroll() { scrollMem[hashNow()] = window.scrollY || 0; }
function restoreScroll(h) {
  const y = scrollMem[h] || 0;
  /* 絵が後から入って高さが変わるので、何度か置き直す。 */
  const put = () => window.scrollTo(0, y);
  put();
  requestAnimationFrame(put);
  setTimeout(put, 80);
  setTimeout(put, 300);
}
function go(hash) {
  keepScroll();
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}
let lastHash = hashNow();
window.addEventListener('hashchange', () => {
  scrollMem[lastHash] = scrollMem[lastHash] || 0;
  lastHash = hashNow();
  renderRoute();
});
/* 直接ハッシュを書き換えられたときのために、離れる直前も控える */
window.addEventListener('beforeunload', keepScroll);

/* pCloud が返す番号を、こちらの言葉に置き換える。分からない番号はそのまま見せる。 */
function loginHint(e) {
  if (e.code === 2000) return 'メールアドレスかパスワードが違います';
  if (e.code === 1000) return 'ログインが通りませんでした';
  if (e.code === 2012 || e.code === 2064) return '確認番号が違うか、期限が切れています';
  if (e.code >= 2200 && e.code <= 2400) return '追加の確認が要るようです（下の返事をそのまま教えてください）';
  if (e.code === 4000) return 'しばらく待ってからやり直してください（試行が多すぎます）';
  return e.message || 'つながりません';
}

let lastMsg = null;   // 画面を組み直しても直前の言葉を消さないため
function screenLogin() {
  $('#hdr').classList.add('hide');
  main().innerHTML = `
    <div class="card">
      <h2>音楽棚</h2>
      <p>pCloud にある音楽を、ブラウザだけで聴く。</p>
      <div class="field"><label>pCloud のメールアドレス</label>
        <input id="em" type="email" autocomplete="username" inputmode="email"></div>
      <div class="field"><label>パスワード</label>
        <input id="pw" type="password" autocomplete="current-password"></div>
      <button class="primary" id="go">つなぐ</button>
      <button class="hbtn" id="bycode" style="width:100%;padding:11px;border-radius:10px;margin-top:10px;background:var(--bg2);border:1px solid var(--line)">共有リンクで使う（合鍵なし・こちらが確実）</button>
      <div class="msg${lastMsg && lastMsg.cls ? ' ' + lastMsg.cls : ''}" id="m">${lastMsg ? esc(lastMsg.text) : ''}</div>
      <button class="hbtn" id="diag" style="margin-top:14px;width:100%;padding:9px;border-radius:9px;background:var(--bg2);border:1px solid var(--line);font-size:12.5px;color:var(--dim)">つながりを調べる</button>
      <pre id="diagout" class="hide" style="white-space:pre-wrap;font-size:11.5px;color:var(--dim);background:#0c0c10;border:1px solid var(--line);border-radius:9px;padding:11px;margin-top:10px;line-height:1.7"></pre>
      <div class="note">パスワードはこの端末に保存されません。まず「毎回変わる符丁」で試し、
      それで合鍵をもらえないときだけ、pCloud が公式に認めている渡し方
      （暗号化した通信でそのまま送る）に降ります。宛先は pcloud.com だけです。
      以後この端末には接続用の合鍵だけが残ります。</div>
    </div>`;
  const say = (t, cls) => {
    lastMsg = { text: t, cls: cls || '' };
    const m = $('#m'); if (m) { m.className = 'msg' + (cls ? ' ' + cls : ''); m.textContent = t; }
  };
  const run = async () => {
    const em = $('#em').value.trim(), pw = $('#pw').value;
    /* 黙って帰らない。押して何も起きないのが一番困る。 */
    note('つなぐを押した（メール' + em.length + '文字 / パスワード' + pw.length + '文字）');
    if (!em && !pw) return say('メールアドレスとパスワードを入れてください', 'err');
    if (!em) return say('メールアドレスが空です', 'err');
    if (!pw) return say('パスワードが空です', 'err');
    $('#go').disabled = true;
    say('符丁を作っています…');
    try {
      await login(em, pw, say);
      note('入れた（合鍵 ' + String(S.auth).length + '文字）');
      $('#pw').value = '';
      say('入れました。棚を開きます…', 'ok');
      go(S.rootId ? '#/lib' : '#/pick/0');
    } catch (e) {
      note('駄目だった: code=' + e.code + ' ' + (e.message || ''));
      $('#m').className = 'msg err';
      $('#m').innerHTML = esc(loginHint(e)) +
        (e.code > 0 ? `<br><span style="color:var(--dim);font-size:11.5px">pCloud の返事: ${e.code} — ${esc(e.message)}</span>` : '');
      $('#go').disabled = false;
    }
  };
  $('#go').onclick = run;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') run(); };
  $('#em').onkeydown = e => { if (e.key === 'Enter') $('#pw').focus(); };
  $('#bycode').onclick = () => go('#/code');
  $('#diag').onclick = async () => {
    const o = $('#diagout'); o.classList.remove('hide'); o.textContent = '調べています…';
    try { o.textContent = await selftest(); } catch (e) { o.textContent = '調べられません: ' + (e.message || e); }
  };
}

async function screenPick(folderid) {
  $('#hdr').classList.remove('hide');
  $('#title').textContent = '音楽のフォルダを選ぶ';
  $('#btnCovers').classList.add('hide'); $('#btnMenu').classList.add('hide');
  main().innerHTML = '<div class="empty">読んでいます…</div>';
  let r;
  try { r = await api('listfolder', { folderid }); }
  catch (e) { main().innerHTML = `<div class="empty">読めません: ${esc(e.message)}</div>`; return; }
  const folders = (r.metadata.contents || []).filter(c => c.isfolder).sort(byName);
  const audioHere = (r.metadata.contents || []).filter(c => !c.isfolder && isAudio(c.name)).length;
  main().innerHTML = `
    <div class="crumb">${esc(r.metadata.path || '/')}</div>
    <button class="primary" id="use">このフォルダを音楽棚にする${audioHere ? `（直下に ${audioHere} 曲）` : ''}</button>
    <div style="height:14px"></div>
    <div class="rowlist">${folders.map(f => `
      <button class="row" data-id="${f.folderid}"><span class="nm">📁 ${esc(f.name)}</span><span class="sub">›</span></button>
    `).join('') || '<div class="empty">下にフォルダはありません</div>'}</div>`;
  $('#use').onclick = async () => {
    S.rootId = folderid; S.rootName = r.metadata.name || '/';
    LS.set('rootId', S.rootId); LS.set('rootName', S.rootName);
    try { await loadIndexFromCloud(); } catch (e) {}
    go('#/lib');
  };
  main().querySelectorAll('.row').forEach(b => b.onclick = () => go('#/pick/' + b.dataset.id));
  $('#back').onclick = () => (folderid === 0 || folderid === '0' ? go('#/lib') : history.back());
}

/* 絞り込みと並び替え。1535枚あると「何を出すか」を決める道具が本体になる。 */
const FILTERS = {
  all:    ['すべて',        () => true],
  fav:    ['★',            al => isFav('a' + al.id)],
  recent: ['最近聴いた',    al => lastPlayed(al) > 0],
  off:    ['端末',          al => albumOffline(al)],
  iffy:   ['要確認',        al => { const c = S.covers[al.id]; return c && !c.manual && c.sure === false; }],
  none:   ['ジャケット無し', al => !coverOf(al)],
};
const SORTS = {
  artist:  ['アーティスト順', (a, b) => collator.compare(a.artist + a.name, b.artist + b.name)],
  name:    ['アルバム名順',   (a, b) => collator.compare(a.name, b.name)],
  yearNew: ['新しい順',       (a, b) => (albumYear(b) || '0000').localeCompare(albumYear(a) || '0000')],
  yearOld: ['古い順',         (a, b) => (albumYear(a) || '9999').localeCompare(albumYear(b) || '9999')],
  tracks:  ['曲数の多い順',   (a, b) => b.tracks.length - a.tracks.length],
  last:    ['最近聴いた順',   (a, b) => lastPlayed(b) - lastPlayed(a)],
  most:    ['よく聴く順',     (a, b) => playCount(b) - playCount(a)],
};
function genreList() {
  const m = new Map();
  for (const al of S.albums) {
    const g = albumGenre(al); if (!g) continue;
    m.set(g, (m.get(g) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function shownAlbums() {
  const f = (FILTERS[S.filter] || FILTERS.all)[1];
  let list = S.albums.filter(f);
  if (S.genre) list = list.filter(al => albumGenre(al) === S.genre);
  return list.sort((SORTS[S.sort] || SORTS.artist)[1]);
}

/* 棚の札を描く。掘った先でも同じものを使う。 */
function gridOf(list) {
  return `<div class="grid">${list.map(al => {
    const cv = coverOf(al), c = S.covers[al.id];
    const badge = c && !c.manual && c.sure === false
                ? `<button class="badge auto" data-fix="${al.id}">要確認 ›</button>`
                : albumOffline(al) ? '<span class="badge off">端末</span>' : '';
    const star = isFav('a' + al.id) ? '<span class="badge star">★</span>' : '';
    const y = albumYear(al);
    return `<div class="al" data-open="${al.id}" role="button" tabindex="0">
      <div class="cov">${cv ? `<img loading="lazy" src="${esc(cv)}" onerror="this.style.display='none'">`
                            : `<span class="made" style="${madeCover(al)}">${esc(al.name)}</span>`}${badge}${star}
        <button class="dots" data-menu="${al.id}" aria-label="操作">⋮</button>
        <button class="go" data-play="${al.id}" aria-label="再生">▶</button>
      </div>
      <div class="t">${esc(al.name)}</div>
      <div class="a">${esc(artistOf(al))}${y ? ' · ' + esc(y) : ''} · ${al.tracks.length}曲</div>
    </div>`;
  }).join('')}</div>`;
}
function wireGrid() {
  const byId = id => S.albums.find(a => String(a.id) === String(id));
  main().querySelectorAll('[data-open]').forEach(b => b.onclick = e => {
    if (e.target.closest('[data-play],[data-menu],[data-fix]')) return;
    go('#/album/' + b.dataset.open);
  });
  main().querySelectorAll('[data-play]').forEach(b => b.onclick = e => {
    e.stopPropagation(); const al = byId(b.dataset.play); if (al) play(al, 0);
  });
  main().querySelectorAll('[data-fix]').forEach(b => b.onclick = e => {
    e.stopPropagation(); go('#/cover/' + b.dataset.fix);
  });
  main().querySelectorAll('[data-menu]').forEach(b => b.onclick = e => {
    e.stopPropagation(); const al = byId(b.dataset.menu); if (al) albumSheet(al);
  });
}
/* 棚・アーティスト・ジャンルの行き来。上に貼り付いて流れない。 */
const tabsOf = cur2 => `<div class="chips">${
  [['lib','棚'],['artists','アーティスト'],['genres','ジャンル']].map(([k, n]) =>
    `<button class="hbtn ${cur2 === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>`;
function wireTabs() {
  main().querySelectorAll('[data-tab]').forEach(b => b.onclick = () =>
    go(b.dataset.tab === 'lib' ? '#/lib' : '#/' + b.dataset.tab));
}

async function screenLib() {
  $('#hdr').classList.remove('hide');
  $('#title').textContent = S.rootName || '音楽棚';
  $('#btnCovers').classList.remove('hide'); $('#btnMenu').classList.remove('hide');
  $('#btnSearch').classList.remove('hide');
  $('#back').classList.add('hide');
  if (!S.albums.length) {
    main().innerHTML = '<div class="empty">棚を読んでいます…<br>（初回は少しかかります）</div>';
    try { S.albums = await scanLibrary(S.rootId); }
    catch (e) {
      main().innerHTML = `<div class="empty">読めません: ${esc(e.message)}<br><br>
        <button class="hbtn" onclick="location.hash='#/pick/0'">フォルダを選び直す</button></div>`;
      return;
    }
  }
  const sw = S.sweep ? `<div class="sweep"><div class="bar"><i id="swbar"></i></div>
      <span id="swtxt"></span><button class="hbtn" id="swstop">やめる</button></div>` : '';
  const counts = {};
  for (const k of Object.keys(FILTERS)) counts[k] = S.albums.filter(FILTERS[k][1]).length;
  const labels = { all: 'すべて', fav: '★', recent: '最近聴いた', off: '端末',
                   iffy: '要確認', none: 'ジャケット無し' };
  const gl = genreList();
  const shown = shownAlbums();
  main().innerHTML = sw + `<div class="libbar">
      <div class="row1">
        <button class="hbtn on" data-tab="lib">棚</button>
        <button class="hbtn" data-tab="artists">アーティスト</button>
        <button class="hbtn" data-tab="genres">ジャンル</button>
        <button class="hbtn" data-tab="moods">雰囲気</button>
        <span class="sep"></span>
        <select id="sortsel">${Object.keys(SORTS).map(k =>
          `<option value="${k}"${S.sort === k ? ' selected' : ''}>${SORTS[k][0]}</option>`).join('')}</select>
        <select id="gensel">
          <option value="">ジャンル：すべて</option>
          ${gl.map(([g, n]) => `<option value="${esc(g)}"${S.genre === g ? ' selected' : ''}>${esc(g)}（${n}）</option>`).join('')}
        </select>
        <button class="hbtn" id="cell">${{ s: '小', m: '中', l: '大' }[S.cell]}</button>
        <button class="hbtn" id="shufAll">🔀</button>
        <button class="hbtn" id="smart">条件</button>
        <button class="hbtn" id="carbtn">🚗 車</button>
        <button class="hbtn" id="jukebtn">🎰 ジューク</button>
      </div>
      <div class="chips">${Object.keys(FILTERS).map(k =>
        `<button class="hbtn ${S.filter === k ? 'on' : ''}" data-f="${k}">${labels[k]}${counts[k] ? ' ' + counts[k] : ''}</button>`).join('')}</div>
    </div>` + gridOf(shown) +
    (shown.length ? '' : `<div class="empty">${S.albums.length ? 'この条件に当てはまるものはありません' : '音楽ファイルが見つかりません'}</div>`);

  wireTabs(); wireGrid();
  const redraw = () => { scrollMem['#/lib'] = 0; screenLib(); window.scrollTo(0, 0); };
  main().querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    S.filter = b.dataset.f; LS.set('filter', S.filter); redraw();
  });
  $('#sortsel').onchange = e => { S.sort = e.target.value; LS.set('sort', S.sort); redraw(); };
  $('#gensel').onchange  = e => { S.genre = e.target.value; LS.set('genre', S.genre); redraw(); };
  $('#cell').onclick = () => {
    S.cell = { s: 'm', m: 'l', l: 's' }[S.cell];
    LS.set('cell', S.cell); document.body.dataset.cell = S.cell; screenLib();
  };
  $('#shufAll').onclick = () => startQueue(shuffle(shown.flatMap(albumRefs)), 0);
  $('#smart').onclick   = () => go('#/smart');
  $('#jukebtn').onclick = () => go('#/juke');
  $('#carbtn').onclick  = () => {
    if (!cur()) startQueue(shuffle(shown.flatMap(albumRefs)), 0);
    go('#/car');
  };
  const stop = $('#swstop'); if (stop) stop.onclick = () => { S.sweep.stop = true; toast('止めます'); };
  updateSweepBar();
}

/* ============ 雰囲気 ============ */
/* Deezer が曲ごとに BPM と音量を持っている（鍵不要）。
   それとジャンル・年代から、機械的に雰囲気を決める。
   手で付けた札があれば、そちらを優先する。 */
const MOODS = {
  calm:  ['静か',   'BPM 90 未満・音量控えめ'],
  warm:  ['落ち着く', 'BPM 90〜105'],
  easy:  ['心地よい', 'BPM 105〜120'],
  up:    ['弾む',   'BPM 120〜140'],
  hot:   ['激しい', 'BPM 140 以上・音量大'],
};
function autoMood(m) {
  if (!m || !m.bpm) return null;
  const b = m.bpm, g = m.gain == null ? -12 : m.gain;
  if (b >= 140 || (b >= 128 && g > -9)) return 'hot';
  if (b >= 120) return 'up';
  if (b >= 105) return 'easy';
  if (b >= 90)  return 'warm';
  return 'calm';
}
const moodOf = al => {
  const m = S.mood[al.id];
  if (!m) return null;
  if (m.hand && m.hand.length) return m.hand[0];
  return m.tag || autoMood(m);
};
const moodLabel = k => (MOODS[k] ? MOODS[k][0] : k);

/* Deezer から BPM と音量を拾う。アルバム1枚につき1往復。 */
async function fetchMood(al) {
  const q = albumQuery(al);
  if (!q) return null;
  const cands = await deezerSearch(q, 3);
  if (!cands.length) return null;
  try {
    const r = await new Promise(res => {
      const cb = 'mz' + (++jsonpSeq), sc = document.createElement('script');
      const done = v => { delete window[cb]; sc.remove(); clearTimeout(tm); res(v); };
      const tm = setTimeout(() => done(null), 7000);
      window[cb] = j => done(j);
      sc.onerror = () => done(null);
      /* 候補の1枚目のアルバムから、代表の曲を1つ取る */
      sc.src = 'https://api.deezer.com/search/track?output=jsonp&limit=1&callback=' + cb +
               '&q=' + encodeURIComponent(q);
      document.body.appendChild(sc);
    });
    const t = r && r.data && r.data[0];
    if (!t || !t.id) return null;
    const det = await new Promise(res => {
      const cb = 'mt' + (++jsonpSeq), sc = document.createElement('script');
      const done = v => { delete window[cb]; sc.remove(); clearTimeout(tm); res(v); };
      const tm = setTimeout(() => done(null), 7000);
      window[cb] = j => done(j);
      sc.onerror = () => done(null);
      sc.src = 'https://api.deezer.com/track/' + t.id + '?output=jsonp&callback=' + cb;
      document.body.appendChild(sc);
    });
    if (!det || !det.bpm) return null;
    return { bpm: det.bpm, gain: det.gain, tag: null };
  } catch (e) { return null; }
}

async function sweepMood() {
  if (S.sweep) { S.sweep.stop = true; return; }
  const targets = S.albums.filter(al => !S.mood[al.id]);
  if (!targets.length) { toast('全部そろっています'); return; }
  S.sweep = { done: 0, total: targets.length, hit: 0, iffy: 0, stop: false, t0: Date.now(), note: '' };
  go('#/lib');
  for (const al of targets) {
    if (S.sweep.stop) break;
    S.sweep.note = '雰囲気を測っています：' + al.name.slice(0, 18);
    const m = await fetchMood(al);
    if (m) { S.mood[al.id] = m; S.sweep.hit++; }
    S.sweep.done++;
    if (S.sweep.done % 10 === 0) { saveMood(); updateSweepBar(); }
  }
  const r = S.sweep; S.sweep = null; saveMood();
  toast(`${r.hit} / ${r.total} 枚に雰囲気を付けました`, 3500);
  renderRoute();
}

/* 「この雰囲気で流す」。いま鳴っているものに近いものを次々つなぐ。 */
function moodQueue(seed, n = 60) {
  const m0 = S.mood[seed.id] || {};
  const k0 = moodOf(seed);
  const g0 = albumGenre(seed);
  const b0 = m0.bpm || 0;
  const scored = S.albums.filter(al => al.id !== seed.id).map(al => {
    const m = S.mood[al.id] || {};
    let sc = 0;
    if (k0 && moodOf(al) === k0) sc += 3;
    if (g0 && albumGenre(al) === g0) sc += 2;
    if (b0 && m.bpm) sc += Math.max(0, 1.6 - Math.abs(m.bpm - b0) / 22);
    if (isFav('a' + al.id)) sc += 0.4;
    return { al, sc: sc + Math.random() * 0.5 };
  }).filter(x => x.sc > 1.2).sort((a, b) => b.sc - a.sc);
  const out = [], seen = new Set();
  let lastArtist = null;
  for (const x of scored) {
    if (out.length >= n) break;
    const a2 = x.al.artist || x.al.name;
    if (a2 === lastArtist) continue;
    if (seen.has(x.al.id)) continue;
    seen.add(x.al.id); lastArtist = a2;
    const t = x.al.tracks[Math.floor(Math.random() * x.al.tracks.length)];
    out.push({ al: x.al, i: x.al.tracks.indexOf(t) });
  }
  return out;
}

/* 掘る。1535枚を上から眺めるのは無理なので、まとまりから入る。 */
function keyOf(kind, al) {
  return kind === 'artist' ? artistOf(al)
       : kind === 'genre'  ? albumGenre(al)
                           : moodLabel(moodOf(al) || '');
}
function groupsOf(kind) {
  const m = new Map();
  for (const al of S.albums) {
    const k = keyOf(kind, al);
    if (!k) continue;
    const g = m.get(k) || { n: 0, al: null, tracks: 0 };
    g.n++; g.tracks += al.tracks.length;
    if (!g.al || (!coverOf(g.al) && coverOf(al))) g.al = al;
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => b[1].n - a[1].n || collator.compare(a[0], b[0]));
}
function screenBrowse(kind) {
  $('#hdr').classList.remove('hide'); $('#back').classList.add('hide');
  $('#title').textContent = { artist: 'アーティスト', genre: 'ジャンル', mood: '雰囲気' }[kind];
  $('#btnCovers').classList.add('hide'); $('#btnSearch').classList.remove('hide');
  $('#btnMenu').classList.remove('hide');
  const gs = groupsOf(kind);
  const none = S.albums.filter(al => !keyOf(kind, al)).length;
  main().innerHTML = `<div class="libbar">
      <div class="row1">
        <button class="hbtn ${kind === 'artist' ? '' : ''}" data-tab="lib">棚</button>
        <button class="hbtn ${kind === 'artist' ? 'on' : ''}" data-tab="artists">アーティスト</button>
        <button class="hbtn ${kind === 'genre' ? 'on' : ''}" data-tab="genres">ジャンル</button>
        <button class="hbtn ${kind === 'mood' ? 'on' : ''}" data-tab="moods">雰囲気</button>
        <span class="sep"></span>
        <span style="color:var(--dim);font-size:12px">${gs.length} 組</span>
      </div>
      <div class="srch"><input id="bq" placeholder="${{artist:'アーティストを絞る',genre:'ジャンルを絞る',mood:'雰囲気を絞る'}[kind]}"
        autocapitalize="off"></div></div>
    <div id="blist"></div>
    ${kind === 'genre' && none ? `<div class="note" style="padding:12px 2px 0">
      ジャンルが入っていないものが ${none} 枚あります。⋯ →「ジャンルと年代を集める」で埋まります。</div>` : ''}`;
  const draw = () => {
    const q = norm(($('#bq') || {}).value || '');
    const list = gs.filter(([k]) => !q || norm(k).includes(q));
    $('#blist').innerHTML = list.map(([k, g]) => `
      <button class="hit2" data-g="${esc(k)}">
        ${coverOf(g.al) ? `<img loading="lazy" src="${esc(coverOf(g.al))}">`
                        : `<img alt="" style="${madeCover(g.al)}">`}
        <span class="t2"><span class="n2">${esc(k)}</span>
          <span class="a2">${g.n} アルバム · ${g.tracks} 曲</span></span>
      </button>`).join('') || '<div class="empty">見つかりません</div>';
    $('#blist').querySelectorAll('[data-g]').forEach(b => b.onclick = () =>
      go('#/by/' + kind + '/' + encodeURIComponent(b.dataset.g)));
  };
  let t2 = null;
  $('#bq').oninput = () => { clearTimeout(t2); t2 = setTimeout(draw, 140); };
  draw(); wireTabs();
}
function screenBy(kind, key) {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = key;
  $('#btnCovers').classList.add('hide'); $('#btnSearch').classList.remove('hide');
  const list = S.albums.filter(al => keyOf(kind, al) === key)
    .sort((SORTS[S.sort] || SORTS.artist)[1]);
  main().innerHTML = `<div class="libbar"><div class="row1">
      <button class="hbtn" id="pall2">▶ 通して聴く</button>
      <button class="hbtn" id="shuf2">🔀 シャッフル</button>
      <span style="color:var(--dim);font-size:12px">${list.length} アルバム</span>
    </div></div>` + gridOf(list);
  wireGrid();
  $('#pall2').onclick = () => startQueue(list.flatMap(albumRefs), 0);
  $('#shuf2').onclick = () => startQueue(shuffle(list.flatMap(albumRefs)), 0);
  $('#back').onclick  = () => go({ artist: '#/artists', genre: '#/genres', mood: '#/moods' }[kind]);
}

function screenAlbum(id) {
  const al = S.albums.find(a => String(a.id) === String(id));
  if (!al) { go('#/lib'); return; }
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = al.name;
  $('#btnCovers').classList.add('hide');
  const cv = coverOf(al), fav = isFav('a' + al.id);
  const g = albumGenre(al), y = albumYear(al), pc = playCount(al);
  main().innerHTML = `
    <div class="albumhead">
      <div class="cov">${cv ? `<img src="${esc(cv)}">` : `<span class="made" style="${madeCover(al)}">${esc(al.name)}</span>`}</div>
      <div class="meta">
        <h2>${esc(al.name)}</h2>
        <div class="a">${esc(artistOf(al))}</div>
        <div class="a">${esc([g, y, al.tracks.length + ' 曲', pc ? '聴いた ' + pc + ' 回' : ''].filter(Boolean).join(' · '))}</div>
        <div class="acts">
          <button class="hbtn" id="pall">▶ 通して聴く</button>
          <button class="hbtn" id="pshuf">🔀</button>
          <button class="hbtn ${fav ? 'on' : ''}" id="fav">${fav ? '★' : '☆'}</button>
          <button class="hbtn" id="qnext">次に再生</button>
          <button class="hbtn" id="qend">列に足す</button>
          <button class="hbtn" id="cov">ジャケット</button>
          <button class="hbtn" id="dl">${albumOffline(al) ? '端末から消す' : '端末に入れる'}</button>
        </div>
      </div>
    </div>
    <div>${al.tracks.map((t, i) => `
      <div class="tk ${P.album && P.album.id === al.id && P.i === i ? 'playing' : ''} ${S.offline[t.id] ? 'cached' : ''}">
        <button class="hit" data-i="${i}"><span class="n">${i + 1}</span><span class="nm">${esc(trackTitle(t))}</span></button>
        <button class="star ${isFav('t' + t.id) ? 'on' : ''}" data-star="${t.id}">${isFav('t' + t.id) ? '★' : '☆'}</button>
        <button class="dots" data-tmenu="${i}">⋮</button>
      </div>`).join('')}</div>`;
  main().querySelectorAll('[data-i]').forEach(b => b.onclick = () => play(al, +b.dataset.i));
  main().querySelectorAll('[data-tmenu]').forEach(b => b.onclick = () => trackSheet(al, +b.dataset.tmenu));
  main().querySelectorAll('[data-star]').forEach(b => b.onclick = () => {
    toggleFav('t' + b.dataset.star);
    b.classList.toggle('on'); b.textContent = b.classList.contains('on') ? '★' : '☆';
  });
  $('#pall').onclick  = () => play(al, 0);
  $('#pshuf').onclick = () => startQueue(shuffle(albumRefs(al)), 0);
  $('#qnext').onclick = () => enqueueNext(albumRefs(al));
  $('#qend').onclick  = () => enqueueEnd(albumRefs(al));
  $('#fav').onclick   = () => { toggleFav('a' + al.id); screenAlbum(id); };
  $('#cov').onclick   = () => go('#/cover/' + al.id);
  $('#dl').onclick    = e => (albumOffline(al) ? removeAlbum(al) : downloadAlbum(al, e.currentTarget));
  $('#back').onclick  = () => go('#/lib');
}

/* いま並んでいるもの。YouTube Music の「次に再生」に相当する。 */
function screenQueue() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '次に流れるもの';
  $('#btnCovers').classList.add('hide');
  if (!P.q.length) { main().innerHTML = '<div class="empty">まだ何も流していません</div>'; $('#back').onclick = () => go('#/lib'); return; }
  const rep = { off: ['↻', '繰り返さない'], all: ['🔁', 'ぜんぶ繰り返す'], one: ['🔂', '1曲を繰り返す'] }[P.repeat];
  const row = (r, i) => `
    <div class="tk ${i === P.qi ? 'playing' : ''}">
      <button class="hit" data-q="${i}">
        <span class="n">${i === P.qi ? '▶' : i + 1}</span>
        <span class="nm">${esc(trackTitle(r.al.tracks[r.i]))}<br>
          <span class="a" style="font-size:11.5px">${esc(r.al.artist)} — ${esc(r.al.name)}</span></span>
      </button>
      <button class="star" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="star" data-rm="${i}">✕</button>
    </div>`;
  const past = P.q.slice(0, P.qi), now = P.q[P.qi], next = P.q.slice(P.qi + 1);
  main().innerHTML = `
    <div class="tools">
      <button class="hbtn" id="qshuf">🔀 並べ直す</button>
      <button class="hbtn ${P.repeat !== 'off' ? 'on' : ''}" id="qrep">${rep[0]} ${rep[1]}</button>
      <button class="hbtn" id="qclear">空にする</button>
    </div>
    ${now ? `<div class="label" style="color:var(--dim);font-size:12px;margin:4px 0 6px">いま流れている</div>
      ${row(now, P.qi)}` : ''}
    ${next.length ? `<div class="label" style="color:var(--dim);font-size:12px;margin:18px 0 6px">
      次に流れる（${next.length}）</div>${next.map((r, k) => row(r, P.qi + 1 + k)).join('')}` : ''}
    ${past.length ? `<div class="label" style="color:var(--dim);font-size:12px;margin:18px 0 6px">
      流し終えた（${past.length}）</div>${past.map((r, k) => row(r, k)).join('')}` : ''}`;
  main().querySelectorAll('[data-q]').forEach(b => b.onclick = () => playAt(+b.dataset.q));
  main().querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    const i = +b.dataset.rm;
    P.q.splice(i, 1);
    if (i < P.qi) P.qi--; else if (i === P.qi) P.qi = Math.min(P.qi, P.q.length - 1);
    paintPlayer(); screenQueue();
  });
  main().querySelectorAll('[data-up]').forEach(b => b.onclick = () => {
    const i = +b.dataset.up; if (i < 1) return;
    [P.q[i - 1], P.q[i]] = [P.q[i], P.q[i - 1]];
    if (P.qi === i) P.qi--; else if (P.qi === i - 1) P.qi++;
    paintPlayer(); screenQueue();
  });
  $('#qshuf').onclick  = () => { const c = cur(); P.q = shuffle(P.q); P.qi = c ? P.q.indexOf(c) : 0; screenQueue(); };
  $('#qrep').onclick   = () => {
    P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat];
    LS.set('repeat', P.repeat); screenQueue();
  };
  $('#qclear').onclick = () => { P.q = []; P.qi = -1; au.pause(); paintPlayer(); screenQueue(); };
  $('#back').onclick   = () => go('#/lib');
}

/* 条件で組む。1535枚を死蔵させないための本命。 */
const SMART = LS.get('smart', { fav: false, unheard: false, stale: false, off: false, spread: true, n: 60 });
function screenSmart() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '条件で組む';
  $('#btnCovers').classList.add('hide');
  const gl = genreList();
  const row = (k, label, sub) => `
    <button class="row" data-k="${k}">
      <span class="nm">${label}${sub ? `<br><span class="sub">${sub}</span>` : ''}</span>
      <span class="chk ${SMART[k] ? 'on' : ''}">${SMART[k] ? '✓' : ''}</span>
    </button>`;
  main().innerHTML = `
    <div class="rowlist">
      ${row('fav', '★ を付けたものだけ')}
      ${row('unheard', 'まだ聴いていないもの', '買ったまま忘れている盤が出てきます')}
      ${row('stale', '30日以上開いていないもの', '棚を死蔵させないための条件')}
      ${row('off', '端末に入れてあるものだけ', '圏外用。通信を当てにしません')}
      ${row('spread', '同じアーティストを続けない')}
    </div>
    <div class="tools" style="margin-top:14px">
      <select id="sg"><option value="">ジャンル：すべて</option>
        ${gl.map(([g, n]) => `<option value="${esc(g)}"${SMART.g === g ? ' selected' : ''}>${esc(g)}（${n}）</option>`).join('')}</select>
      <select id="sd"><option value="">年代：すべて</option>
        ${['1960','1970','1980','1990','2000','2010','2020'].map(d =>
          `<option value="${d}"${SMART.d === d ? ' selected' : ''}>${d}年代</option>`).join('')}</select>
      <select id="sn">${[20, 40, 60, 100, 200].map(n =>
        `<option value="${n}"${SMART.n === n ? ' selected' : ''}>${n} 曲</option>`).join('')}</select>
    </div>
    <div style="height:14px"></div>
    <button class="primary" id="build">この条件で流す</button>
    <div class="msg" id="sm"></div>
    <div class="note" style="padding:0 2px">条件は端末に覚えさせます。次に開いたときも同じ状態から始められます。</div>`;
  main().querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    SMART[b.dataset.k] = !SMART[b.dataset.k]; LS.set('smart', SMART); screenSmart();
  });
  $('#sg').onchange = e => { SMART.g = e.target.value; LS.set('smart', SMART); };
  $('#sd').onchange = e => { SMART.d = e.target.value; LS.set('smart', SMART); };
  $('#sn').onchange = e => { SMART.n = +e.target.value; LS.set('smart', SMART); };
  $('#build').onclick = () => {
    const list = buildSmart();
    if (!list.length) { $('#sm').className = 'msg err'; $('#sm').textContent = '条件に合う曲がありません。少し緩めてください'; return; }
    startQueue(list, 0); go('#/queue');
  };
  $('#back').onclick = () => go('#/lib');
}
function buildSmart() {
  const now = Date.now(), MONTH = 30 * 864e5;
  let als = S.albums.filter(al => {
    if (SMART.fav && !isFav('a' + al.id)) return false;
    if (SMART.unheard && playCount(al) > 0) return false;
    if (SMART.stale && lastPlayed(al) > now - MONTH) return false;
    if (SMART.off && !albumOffline(al)) return false;
    if (SMART.g && albumGenre(al) !== SMART.g) return false;
    if (SMART.d) { const y = +albumYear(al); if (!y || y < +SMART.d || y >= +SMART.d + 10) return false; }
    return true;
  });
  let refs = shuffle(als.flatMap(albumRefs));
  if (SMART.spread) {
    /* 同じアーティストが続かないように、後ろへ送りながら取り出す */
    const out = [], pool = refs.slice();
    let lastArtist = null;
    while (pool.length && out.length < SMART.n) {
      let k = pool.findIndex(r => (r.al.artist || r.al.name) !== lastArtist);
      if (k < 0) k = 0;
      const r = pool.splice(k, 1)[0];
      out.push(r); lastArtist = r.al.artist || r.al.name;
    }
    return out;
  }
  return refs.slice(0, SMART.n);
}

/* ジャケットの選び直し。違うものが付く前提で、直しやすさを最優先にする。 */
async function screenCover(id) {
  const al = S.albums.find(a => String(a.id) === String(id));
  if (!al) { go('#/lib'); return; }
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = 'ジャケットを選ぶ';
  $('#btnCovers').classList.add('hide');
  const cur0 = S.covers[al.id] || {};
  const me = parseAlbum(al);
  /* 探し方の当て方を変える札。1回で当たらないときはここを押す。 */
  const bare = me.album
    .replace(/\[?Disc\s*\d+\]?/ig, ' ')
    .replace(/(ORIGINAL\s*)?SOUND\s*TRACK|オリジナル・?サウンドトラック|サウンドトラック|OST/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  const chips = [
    ['そのまま', albumQuery(al)],
    ['アルバム名だけ', me.album],
    ['巻数を外す', bare],
    ['サントラとして', bare + ' サウンドトラック'],
    ['アーティストだけ', me.artist],
    ['1曲目の名前で', trackTitle(al.tracks[0] || { name: '' })],
    ['英語表記で', (me.artist + ' ' + me.album).replace(/[ぁ-んァ-ヶ一-龠]/g, '').trim()],
  ].filter(c => c[1] && c[1].length > 1 && c[1] !== albumQuery(al));
  chips.unshift(['そのまま', albumQuery(al)]);
  let q = cur0.q || albumQuery(al);
  const iffy = S.albums.filter(x => { const c = S.covers[x.id]; return c && !c.manual && c.sure === false; });
  const nextIffy = iffy.find(x => String(x.id) !== String(al.id));

  const draw = (cands, loading) => {
    const c0 = S.covers[al.id] || {};
    main().innerHTML = `
      <div class="albumhead" style="margin-bottom:12px">
        <div class="cov">${c0.url ? `<img src="${esc(c0.url)}">` : '<span class="ph">♪</span>'}</div>
        <div class="meta">
          <h2>${esc(al.name)}</h2>
          <div class="a">${esc(al.artist)} · ${al.tracks.length}曲</div>
          <div class="a">${c0.url ? 'いま: ' + esc(c0.src || '手動') + (c0.score != null ? '（' + Math.round(c0.score * 100) + '%）' : '') : 'まだ付いていません'}</div>
          <div class="acts">
            ${c0.url ? '<button class="hbtn" id="clr">外す</button>' : ''}
            ${al.folderCover ? '<button class="hbtn" id="usefolder">フォルダの画像</button>' : ''}
            <button class="hbtn" id="pick">端末の画像</button>
            ${nextIffy ? `<button class="hbtn" id="nextiffy">次の要確認 ›</button>` : ''}
          </div>
        </div>
      </div>
      <div class="chips">${chips.map((c, i) =>
        `<button class="hbtn" data-c="${i}">${esc(c[0])}</button>`).join('')}</div>
      <div class="searchrow"><input id="q" value="${esc(q)}"><button class="hbtn" id="rs">探す</button></div>
      <div class="chips" style="margin-top:10px">
        <span style="color:var(--dim);font-size:12px;align-self:center;margin-right:2px">外で探す：</span>
        <button class="hbtn" data-web="g">Google 画像</button>
        <button class="hbtn" data-web="a">Amazon</button>
        <button class="hbtn" data-web="y">Yahoo 画像</button>
      </div>
      <div id="drop" class="drop">
        画像をここに<b>ドラッグ</b>、または <b>⌘V で貼り付け</b><br>
        <span class="sub">画像そのものでも、画像のURLでも構いません</span>
      </div>
      <input id="url" placeholder="画像のURLを直接貼る" style="width:100%;margin-top:8px;padding:10px 12px;border-radius:10px;background:#0c0c10;border:1px solid var(--line);color:var(--fg)">
      <input id="file" type="file" accept="image/*" class="hide">
      ${loading ? '<div class="empty">探しています…</div>' : `
      <div class="cands">${cands.map((c, i) => `
        <button class="cand ${c0.url === c.url ? 'sel' : ''}" data-i="${i}">
          <img loading="lazy" src="${esc(c.thumb || c.url)}" onerror="this.closest('.cand').style.display='none'">
          <div class="cl">${esc(c.label)}<br>${esc(c.src)}${c.n ? ' ' + c.n + '曲' : ''}${c.score != null ? ' ・ ' + Math.round(c.score * 100) + '%' : ''}</div>
        </button>`).join('') || '<div class="empty">候補がありません。上の札か言葉を変えてください。</div>'}</div>`}
      <div class="note" style="padding:14px 2px 0">選ばなかった候補は残しません。
        あとで選び直せるよう、探した言葉だけ控えます。</div>`;

    const put = (url, src) => {
      S.covers[al.id] = { url, src, q: ($('#q') || {}).value || q, manual: true, sure: true,
                          score: (S.covers[al.id] || {}).score };
      saveCovers();
      if (LS.full) toast('★端末の記憶が一杯です。索引を pCloud に控えてください', 4000);
      else toast('決めました');
    };
    main().querySelectorAll('.cand').forEach(b => b.onclick = () => {
      const c = cands[+b.dataset.i];
      put(c.url, c.src);
      if (c.g || c.y) { S.meta[al.id] = { g: c.g || '', y: c.y || '' }; saveMeta(); }
      nextIffy ? go('#/cover/' + nextIffy.id) : go('#/album/' + al.id);
    });
    main().querySelectorAll('[data-c]').forEach(b => b.onclick = async () => {
      q = chips[+b.dataset.c][1];
      draw([], true);
      draw(await findCandidates(q, al, true), false);
    });
    $('#rs').onclick = async () => {
      q = $('#q').value; draw([], true); draw(await findCandidates(q, al, true), false);
    };
    $('#url').onchange = () => {
      const v = $('#url').value.trim();
      if (/^https?:\/\//.test(v)) { put(v, '手動'); go('#/album/' + al.id); }
    };
    /* 外の検索を開く。見つけた絵は「コピー」して ⌘V、またはここへドラッグ。 */
    const q2 = encodeURIComponent((cleanName(al.artist) + ' ' + cleanName(al.name)).trim());
    const webs = {
      g: 'https://www.google.com/search?tbm=isch&q=' + q2,
      a: 'https://www.amazon.co.jp/s?i=popular&k=' + q2,
      y: 'https://search.yahoo.co.jp/image/search?p=' + q2,
    };
    main().querySelectorAll('[data-web]').forEach(b => b.onclick = () => {
      window.open(webs[b.dataset.web], '_blank', 'noopener');
    });

    /* 画像そのものを受け取る道を3つ用意する。どれでも同じ結果になる。 */
    const useBlobOrUrl = src => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        const n2 = 500, cv2 = document.createElement('canvas');
        cv2.width = cv2.height = n2;
        const g2 = cv2.getContext('2d');
        const sd = Math.min(im.width, im.height);
        g2.drawImage(im, (im.width - sd) / 2, (im.height - sd) / 2, sd, sd, 0, 0, n2, n2);
        let out;
        try { out = cv2.toDataURL('image/jpeg', 0.84); }
        catch (e) { out = src; }        /* 読めない絵はURLのまま使う */
        put(out, '手動');
        go('#/album/' + al.id);
      };
      im.onerror = () => {
        /* 縮められない絵（別の場所のもの）は、URL のまま使う */
        if (/^https?:/.test(src)) { put(src, '手動'); go('#/album/' + al.id); }
        else toast('その画像は読めません');
      };
      im.src = src;
    };
    const fromFile = f => {
      const r2 = new FileReader();
      r2.onload = () => useBlobOrUrl(r2.result);
      r2.readAsDataURL(f);
    };
    const dz = $('#drop');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.add('on');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); dz.classList.remove('on');
    }));
    dz.addEventListener('drop', e => {
      const dt = e.dataTransfer;
      const f = dt.files && dt.files[0];
      if (f && /^image\//.test(f.type)) return fromFile(f);
      const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri && /^https?:/.test(uri.trim())) return useBlobOrUrl(uri.trim());
      const html = dt.getData('text/html');
      const m2 = html && html.match(/<img[^>]+src="([^"]+)"/i);
      if (m2) return useBlobOrUrl(m2[1]);
      toast('画像として受け取れませんでした');
    });
    dz.onclick = () => $('#file').click();
    const onPaste = e => {
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) { fromFile(it.getAsFile()); e.preventDefault(); return; }
      }
      const txt = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : '';
      if (txt && /^https?:\/\/\S+$/.test(txt.trim()) && e.target.id !== 'url' && e.target.id !== 'q') {
        useBlobOrUrl(txt.trim()); e.preventDefault();
      }
    };
    document.removeEventListener('paste', window.__onPaste || (() => {}));
    window.__onPaste = onPaste;
    document.addEventListener('paste', onPaste);

    $('#pick').onclick = () => $('#file').click();
    $('#file').onchange = e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      const im = new Image();
      im.onload = () => {
        /* 端末に抱えるので小さくする。1500枚ぶん貯めても溢れない大きさに。 */
        const n = 400, cv = document.createElement('canvas');
        cv.width = cv.height = n;
        const x = cv.getContext('2d');
        const s2 = Math.min(im.width, im.height);
        x.drawImage(im, (im.width - s2) / 2, (im.height - s2) / 2, s2, s2, 0, 0, n, n);
        put(cv.toDataURL('image/jpeg', 0.82), '端末の画像');
        go('#/album/' + al.id);
      };
      im.onerror = () => toast('その画像は読めません');
      im.src = URL.createObjectURL(f);
    };
    const uf = $('#usefolder'); if (uf) uf.onclick = () => {
      put(thumbUrl(al.folderCover, 600), 'フォルダ'); go('#/album/' + al.id);
    };
    const cl = $('#clr'); if (cl) cl.onclick = () => { delete S.covers[al.id]; saveCovers(); draw(cands, false); };
    const ni = $('#nextiffy'); if (ni) ni.onclick = () => go('#/cover/' + nextIffy.id);
  };
  draw([], true);
  draw(await findCandidates(q, al, true), false);
  $('#back').onclick = () => go('#/album/' + al.id);
}

function screenLists() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = 'プレイリスト';
  $('#btnCovers').classList.add('hide');
  const names = Object.keys(S.lists);
  main().innerHTML = `
    ${P.q.length ? `<button class="primary" id="fromq">いま流れている ${P.q.length} 曲を保存する</button><div style="height:16px"></div>` : ''}
    <div class="rowlist">${names.map(n => `
      <button class="row" data-n="${esc(n)}">
        <span class="nm">${esc(n)}<br><span class="sub">${S.lists[n].length} 曲</span></span>
        <span class="sub">›</span>
      </button>`).join('') || '<div class="empty">まだありません</div>'}</div>
    <div class="note" style="padding:0 2px">曲そのものは複製しません。棚のどの曲かを覚えているだけなので、いくつ作っても軽いままです。</div>`;
  const fq = $('#fromq');
  if (fq) fq.onclick = () => {
    const n = prompt('名前を付けてください', new Date().toLocaleDateString('ja-JP') + ' の組み合わせ');
    if (!n) return;
    S.lists[n] = P.q.map(r => ({ a: r.al.id, t: r.al.tracks[r.i].id }));
    saveLists(); toast('保存しました'); screenLists();
  };
  main().querySelectorAll('[data-n]').forEach(b => b.onclick = () => {
    const n = b.dataset.n, refs = [];
    for (const e of S.lists[n]) {
      const al = S.albums.find(x => String(x.id) === String(e.a));
      if (!al) continue;
      const i = al.tracks.findIndex(t => String(t.id) === String(e.t));
      if (i >= 0) refs.push({ al, i });
    }
    if (!refs.length) { toast('棚の中に見つかりませんでした'); return; }
    startQueue(refs, 0); go('#/queue');
  });
  $('#back').onclick = () => go('#/lib');
}

function screenHistory() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '聴いた履歴';
  $('#btnCovers').classList.add('hide');
  const rows = S.hist.slice(0, 120).map(h => {
    const al = S.albums.find(x => String(x.id) === String(h.a));
    if (!al) return '';
    const i = al.tracks.findIndex(t => String(t.id) === String(h.t));
    if (i < 0) return '';
    const d = new Date(h.at);
    return `<button class="tk" data-a="${al.id}" data-i="${i}">
      <span class="nm">${esc(trackTitle(al.tracks[i]))}<br>
        <span class="a" style="font-size:11.5px">${esc(al.artist)} — ${esc(al.name)}</span></span>
      <span class="d">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span>
    </button>`;
  }).join('');
  main().innerHTML = rows || '<div class="empty">まだ何も聴いていません</div>';
  main().querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const al = S.albums.find(x => String(x.id) === String(b.dataset.a));
    if (al) play(al, +b.dataset.i);
  });
  $('#back').onclick = () => go('#/lib');
}

/* ジャンルと年だけを集め直す。ジャケットは触らない。
   アーティスト単位なので1535枚でも往復は200回ほどで済む。 */
async function sweepMeta() {
  if (S.sweep) { S.sweep.stop = true; return; }
  const targets = S.albums.filter(al => !S.meta[al.id]);
  if (!targets.length) { toast('全部そろっています'); return; }
  const groups = new Map();
  for (const al of targets) {
    const k = parseAlbum(al).artist;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(al);
  }
  S.sweep = { done: 0, total: targets.length, hit: 0, iffy: 0, stop: false, t0: Date.now(), note: '' };
  go('#/lib');
  for (const [artist, list] of groups) {
    if (S.sweep.stop) break;
    S.sweep.note = 'ジャンルを集めています：' + (artist || '（名前なし）');
    updateSweepBar();
    let pool = [];
    if (artist) {
      try { pool = await itunesSearch(artist, 200, latinish(artist) ? 'US' : 'JP'); } catch (e) {}
    }
    for (const al of list) {
      if (S.sweep.stop) break;
      let best = pool.length ? rank(pool, al)[0] : null;
      if (!best || best.score < SURE) {
        try { best = (await findCandidates(albumQuery(al), al))[0]; } catch (e) { best = null; }
      }
      if (best && best.score >= SURE && (best.g || best.y)) {
        S.meta[al.id] = { g: best.g || '', y: best.y || '' };
        S.sweep.hit++;
      }
      S.sweep.done++;
    }
    saveMeta(); updateSweepBar();
  }
  const r = S.sweep; S.sweep = null; saveMeta();
  toast(`${r.hit} 枚にジャンルと年を入れました`, 3200);
  renderRoute();
}

function screenMenu() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '設定';
  $('#btnCovers').classList.add('hide');
  const n = Object.keys(S.offline).length, c = Object.keys(S.covers).length;
  main().innerHTML = `
    <div class="rowlist">
      <button class="row" id="rescan"><span class="nm">棚を読み直す</span><span class="sub">${S.albums.length} アルバム</span></button>
      <button class="row" id="sweep"><span class="nm">ジャケットを一巡して探す</span><span class="sub">${c} 枚</span></button>
      <button class="row" id="sweepall"><span class="nm">自動で付けた分を探し直す</span></button>
      ${GATE ? `<button class="row" id="leave"><span class="nm">この端末を外す</span><span class="sub">合言葉を入れ直すまで</span></button>` : `<button class="row" id="code"><span class="nm">共有リンク</span><span class="sub">${S.code ? '設定済み' : '未設定'}</span></button>`}
      <button class="row" id="relay"><span class="nm">中継所</span><span class="sub">${S.relay ? '設定済み' : '未設定'}</span></button>
      <button class="row" id="routes"><span class="nm">取り出し方を調べる</span><span class="sub">再生できないとき</span></button>
      <button class="row" id="moodgo"><span class="nm">雰囲気を測る</span><span class="sub">${Object.keys(S.mood).length} 枚</span></button>
      <button class="row" id="meta"><span class="nm">ジャンルと年代を集める</span><span class="sub">${Object.keys(S.meta).length} 枚</span></button>
      <button class="row" id="juke"><span class="nm">ジュークボックス</span><span class="sub">札で選ぶ</span></button>
      <button class="row" id="car"><span class="nm">車モード</span><span class="sub">大きな的で操作する</span></button>
      <button class="row" id="lists"><span class="nm">プレイリスト</span><span class="sub">${Object.keys(S.lists).length} 本</span></button>
      <button class="row" id="hist"><span class="nm">聴いた履歴</span><span class="sub">${S.hist.length} 件</span></button>
      <button class="row" id="exp"><span class="nm">索引を書き出す</span><span class="sub">${Object.keys(S.covers).length} 枚</span></button>
      <button class="row" id="imp"><span class="nm">索引を読み込む</span><span class="sub">別の置き場から移すとき</span></button>
      <input id="impf" type="file" accept="application/json,.json" class="hide">
      <button class="row" id="save"><span class="nm">索引を pCloud に控える</span><span class="sub">${INDEX_NAME}</span></button>
      <button class="row" id="load"><span class="nm">索引を pCloud から取り込む</span></button>
      <button class="row" id="pick"><span class="nm">音楽フォルダを選び直す</span><span class="sub">${esc(S.rootName)}</span></button>
      <button class="row" id="clroff"><span class="nm">端末の音を全部消す</span><span class="sub">${n} 曲</span></button>
      ${S.auth ? `<button class="row" id="drop"><span class="nm">合鍵を捨てる<br>
        <span class="sub">符号だけで足ります。合鍵は口座まるごとの鍵なので、要らないなら消す方が安全</span></span>
        <span class="sub">›</span></button>` : ''}
      <button class="row" id="out"><span class="nm" style="color:var(--danger)">つなぎを切る</span><span class="sub">${esc(S.email || (S.code ? '共有リンク' : ''))}</span></button>
    </div>
    <div class="note">ジャケットは iTunes と Deezer の公開API から取っています。無料・鍵不要で、
    1枚あたり0.3秒ほど。サイトを見て回らないので、待たされも費用もありません。</div>`;
  $('#rescan').onclick = async () => { S.albums = []; go('#/lib'); };
  $('#sweep').onclick   = () => { go('#/lib'); setTimeout(() => sweepCovers(true), 60); };
  $('#sweepall').onclick= () => {
    for (const [k, v] of Object.entries(S.covers)) if (!v.manual) delete S.covers[k];
    saveCovers(); go('#/lib'); setTimeout(() => sweepCovers(true), 60);
  };
  const lv = $('#leave'); if (lv) lv.onclick = () => { location.href = '/logout'; };
  const cd2 = $('#code'); if (cd2) cd2.onclick = () => go('#/code');
  $('#relay').onclick  = () => go('#/relay');
  $('#routes').onclick = () => go('#/routes');
  $('#moodgo').onclick = () => sweepMood();
  $('#meta').onclick  = () => sweepMeta();
  $('#juke').onclick  = () => go('#/juke');
  $('#car').onclick   = () => go('#/car');
  $('#lists').onclick = () => go('#/lists');
  $('#hist').onclick  = () => go('#/history');
  $('#exp').onclick = () => exportIndex();
  $('#imp').onclick = () => $('#impf').click();
  $('#impf').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (f) importIndex(f, () => go('#/lib'));
  };
  $('#save').onclick = async () => { try { await saveIndexToCloud(); toast('控えました'); } catch (e) { toast('控えられません: ' + e.message); } };
  $('#load').onclick = async () => { try { toast(await loadIndexFromCloud() ? '取り込みました' : '控えがありません'); renderRoute(); } catch (e) { toast(e.message); } };
  $('#pick').onclick = () => go('#/pick/0');
  $('#clroff').onclick = async () => {
    if ('caches' in window) await caches.delete('tracks-v1');
    S.offline = {}; saveOffline(); toast('消しました'); renderRoute();
  };
  const dr = $('#drop');
  if (dr) dr.onclick = async () => {
    if (!S.code) { toast('先に共有リンクを設定してください'); return; }
    try { await api('logout'); } catch (e) {}       /* pCloud 側でも無効にする */
    S.auth = ''; S.email = ''; LS.del('auth'); LS.del('email');
    toast('合鍵を捨てました。以後は符号だけで動きます', 3500);
    note('合鍵を捨てた');
    screenMenu();
  };
  $('#out').onclick = () => { logout(); go('#/login'); location.reload(); };
  $('#back').onclick = () => go('#/lib');
}

function renderRoute() {
  const h = hashNow();
  const out = routeTo();
  Promise.resolve(out).then(() => restoreScroll(h)).catch(() => {});
  return out;
}
function routeTo() {
  const h = location.hash || '';
  if (!GATE && !S.auth && !S.code) {
    if (h && h !== '#/login') {
      note('合鍵が無いのでログイン画面に戻した（' + h + '）');
      lastMsg = { text: '合鍵が残らなかったので、もう一度お願いします', cls: 'err' };
    }
    screenLogin();
    return;
  }
  if (h.startsWith('#/pick/'))   return screenPick(h.slice(7));
  if (h.startsWith('#/album/'))  return screenAlbum(h.slice(8));
  if (h.startsWith('#/cover/'))  return screenCover(h.slice(8));
  if (h === '#/menu')            return screenMenu();
  if (h === '#/now')             return screenNow();
  if (h === '#/vis')             return screenVis();
  if (h === '#/search')          return screenSearch();
  if (h === '#/artists')         return screenBrowse('artist');
  if (h === '#/genres')          return screenBrowse('genre');
  if (h === '#/moods')           return screenBrowse('mood');
  if (h.startsWith('#/by/mood/'))   return screenBy('mood',   decodeURIComponent(h.slice(10)));
  if (h.startsWith('#/by/artist/')) return screenBy('artist', decodeURIComponent(h.slice(12)));
  if (h.startsWith('#/by/genre/'))  return screenBy('genre',  decodeURIComponent(h.slice(11)));
  if (h === '#/car')             return screenCar();
  if (h === '#/juke')            return screenJuke();
  if (h === '#/routes')          return screenRoutes();
  if (h === '#/relay')           return screenRelay();
  if (h === '#/code')            return screenCode();
  if (h === '#/queue')           return screenQueue();
  if (h === '#/smart')           return screenSmart();
  if (h === '#/lists')           return screenLists();
  if (h === '#/history')         return screenHistory();
  if (!S.rootId && !S.code && !GATE) return screenPick(0);
  return screenLib();
}
$('#btnMenu').onclick   = () => go('#/menu');
$('#btnSearch').onclick = () => go('#/search');
$('#btnCovers').onclick = () => sweepCovers(true);

/* 入口ごしの失敗を診る。何が返っているかを実際に取って見る。 */
async function diagnoseGate(t) {
  const L = ['曲: ' + t.name.slice(-38)];
  try {
    /* nored=1 で「端末へ投げ直す」のを止め、入口の言い分をそのまま受け取る。
       投げ直された先は CORS が無いので、読もうとすると Failed to fetch になり
       肝心の理由が隠れてしまう。 */
    const r = await fetch('/api/audio?nored=1&fileid=' + encodeURIComponent(t.id),
      { headers: { Range: 'bytes=0-99' }, credentials: 'same-origin' });
    const ct = r.headers.get('content-type') || '(種別なし)';
    L.push('/api/audio ' + r.status + ' ' + ct);
    if (ct.includes('json')) {
      const txt = await r.text();
      L.push('入口の言い分: ' + txt.slice(0, 300));
      note('入口診断: ' + L.join(' / '));
      shout('入口', L.join('  /  '));
      return;
    }
    const buf = await r.arrayBuffer();
    const b = new Uint8Array(buf.slice(0, 8));
    const asc = [...b].map(x => (x >= 32 && x < 127) ? String.fromCharCode(x) : '.').join('');
    L.push(buf.byteLength + 'バイト 先頭「' + asc + '」');
    if (asc.startsWith('{')) L.push('→ 音ではなく文字（入口かpCloudが断っている）');
    else if (asc.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) L.push('→ mp3 の中身');
    else if (asc.includes('ftyp')) L.push('→ m4a の中身');
    else if (asc.startsWith('fLaC')) L.push('→ flac の中身');
    else if (asc.startsWith('RIFF')) L.push('→ wav の中身');
    else if (asc.slice(0,4) === '0&\u00b2v' || b[0] === 0x30) L.push('→ wma の可能性（ブラウザでは鳴らせません）');
    else L.push('→ 見覚えのない中身');
  } catch (e) { L.push('取れません: ' + (e.message || e)); }
  const el = document.createElement('audio');
  const ext = t.name.slice(t.name.lastIndexOf('.') + 1).toLowerCase();
  const mime = { mp3:'audio/mpeg', m4a:'audio/mp4', flac:'audio/flac', wav:'audio/wav',
                 ogg:'audio/ogg', opus:'audio/ogg', wma:'audio/x-ms-wma', aac:'audio/aac' }[ext];
  if (mime) L.push('この形式（' + ext + '）を鳴らせるか: ' + (el.canPlayType(mime) || 'いいえ'));
  if (au.error) L.push('音の側: error ' + au.error.code);
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    L.push('★横取り役がまだ居ます');
  }
  note('入口診断: ' + L.join(' / '));
  shout('入口', L.join('  /  '));
}

/* 中継所が返しているものを、実際に取って見る。推測で往復しないため。 */
async function diagnoseRelay(t) {
  const L = [];
  try {
    const r = await fetch(relayUrl('/link', t), { referrerPolicy: 'no-referrer' });
    const ct = r.headers.get('content-type') || '(種別なし)';
    const txt = await r.text();
    L.push('/link ' + r.status + ' ' + ct);
    if (/Hello World/i.test(txt)) {
      shout('中継所', '中身がまだ Hello World のままです。貼り替えて Deploy し直してください');
      return;
    }
    try {
      const j = JSON.parse(txt);
      L.push(j.error ? ('断られた: ' + (j.result || '') + ' ' + j.error +
                        (j.tried ? ' 試した配信元=' + j.tried.join(',') : ''))
                     : ('リンクは取れた type=' + (j.type || 'なし') +
                        (j.urls ? ' 配信元' + j.urls.length + '個' : '')));
    } catch (e) { L.push('JSON ではない: ' + txt.slice(0, 70)); }
  } catch (e) { shout('中継所につながりません', e.message || String(e)); return; }

  /* 音そのものを100バイトだけ取って、何が返っているかを見る。 */
  try {
    const r2 = await fetch(relayUrl('/audio', t),
      { headers: { Range: 'bytes=0-99' }, referrerPolicy: 'no-referrer' });
    const ct2 = r2.headers.get('content-type') || '(種別なし)';
    const buf = await r2.arrayBuffer();
    L.push('/audio ' + r2.status + ' ' + ct2 + ' ' + buf.byteLength + 'バイト');
    const b = new Uint8Array(buf.slice(0, 6));
    const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join(' ');
    const asc = [...b].map(x => (x >= 32 && x < 127) ? String.fromCharCode(x) : '.').join('');
    L.push('先頭 ' + hex + ' 「' + asc + '」');
    if (asc.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) L.push('→ mp3 の中身です');
    else if (asc.includes('ftyp')) L.push('→ m4a の中身です');
    else if (asc.startsWith('fLaC')) L.push('→ flac の中身です');
    else if (asc.startsWith('{') || asc.startsWith('<')) L.push('→ 音ではなく文字が返っています');
  } catch (e) { L.push('/audio 取得失敗: ' + (e.message || e)); }

  try {
    const r3 = await fetch(relayUrl('/link', t), { referrerPolicy: 'no-referrer' });
    const j3 = await r3.json();
    if (j3.url) {
      const p3 = await fetch(j3.url, { headers: { Range: 'bytes=0-99' }, referrerPolicy: 'no-referrer' });
      L.push('ブラウザが直接: ' + p3.status);
    }
  } catch (e) { L.push('ブラウザが直接: ' + (e.message || e).slice(0, 40)); }
  note('中継所診断: ' + L.join(' / '));
  shout('中継所', L.join('  /  '));
}

/* ============ 取り出し方を総当たりする ============ */
/* 直リンクも読み出しも断られたので、どれなら通るのかを実ファイルで確かめる。
   公開リンクを作る手は、本人が選んだときだけ試す（外から取れる状態を作るため）。 */
async function probeRoutes(withPublink) {
  const al = S.albums.find(a => a.tracks.length);
  if (!al) return '棚に曲がありません';
  const t = al.tracks[0];
  const L = ['調べた曲: ' + t.name.slice(0, 40), 'fileid: ' + t.id, ''];
  const tryIt = async (name, fn) => {
    const t0 = Date.now();
    try { const r = await fn(); L.push('○ ' + name + ' — ' + r + ' (' + (Date.now() - t0) + 'ms)'); return true; }
    catch (e) { L.push('× ' + name + ' — ' + (e.code != null ? e.code + ' ' : '') + (e.message || e)); return false; }
  };
  await tryIt('checksumfile（読めるかの確認）', async () => {
    const r = await api('checksumfile', { fileid: t.id });
    return 'sha1=' + String(r.sha1 || r.md5 || '').slice(0, 10);
  });
  await tryIt('stat（大きさの確認）', async () => {
    const r = await api('stat', { fileid: t.id });
    return Math.round((r.metadata.size || 0) / 1048576) + 'MB';
  });
  for (const m of ['getfilelink', 'getaudiolink', 'getvideolink']) {
    await tryIt(m, async () => {
      const r = await api(m, { fileid: t.id, forcedownload: 0 });
      return (r.hosts || []).length + '個のあて先';
    });
  }
  for (const fl of [0, 1, 2]) {
    const ok = await tryIt('file_open flags=' + fl, async () => {
      const r = await api('file_open', { fileid: t.id, flags: fl });
      try { await api('file_close', { fd: r.fd }); } catch (e) {}
      return 'fd=' + r.fd;
    });
    if (ok) break;
  }
  await tryIt('file_open（path 指定）', async () => {
    const r = await api('file_open', { path: '/' + t.name, flags: 0 });
    try { await api('file_close', { fd: r.fd }); } catch (e) {}
    return 'fd=' + r.fd;
  });
  if (withPublink) {
    L.push('');
    await tryIt('getfilepublink（公開リンクを作る）', async () => {
      const r = await api('getfilepublink', { fileid: t.id });
      S.plTest = r;
      return 'code=' + String(r.code || '').slice(0, 6) + '…';
    });
    if (S.plTest && S.plTest.code) {
      await tryIt('getpublinkdownload（作ったリンクから取る）', async () => {
        const r = await api('getpublinkdownload', { code: S.plTest.code });
        return (r.hosts || []).length + '個のあて先';
      });
      await tryIt('作ったリンクを消す', async () => {
        await api('deletepublink', { linkid: S.plTest.linkid });
        return '消しました';
      });
    }
  }
  return L.join('\n');
}

/* 共有リンクの符号で使う。合鍵より制限が少なく、Mac も中継所も要らない。 */
function parseCode(v) {
  v = String(v || '').trim();
  let host = null, code = v;
  const m = v.match(/^https?:\/\/([a-z0-9.-]*pcloud\.(?:link|com))\/[^?]*\?(.*)$/i);
  if (m) {
    host = /^e\./i.test(m[1]) || /^eapi/i.test(m[1]) ? 'eapi.pcloud.com' : 'api.pcloud.com';
    const q = new URLSearchParams(m[2]);
    code = q.get('code') || '';
  }
  return { code: code.replace(/[^A-Za-z0-9]/g, ''), host };
}

function screenCode() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '共有リンクで使う';
  $('#btnCovers').classList.add('hide');
  main().innerHTML = `
    <div class="note" style="padding:0 2px 14px">
      pCloud は合鍵で出したリンクを、ブラウザからだと弾きます（7010）。
      <b>共有リンクの符号なら弾かれません。</b>これが耳読が Mac 無しで鳴っている仕組みで、
      中継所も合鍵も要らなくなります。</div>
    ${S.code ? `<div class="rowlist" style="margin-bottom:14px"><div class="row">
      <span class="nm">いまの符号<br><span class="sub">${esc(S.code.slice(0,3))}••••••${esc(S.code.slice(-2))}
      ${S.linkpw ? '・合言葉あり' : '・合言葉なし'}</span></span></div></div>` : ''}
    <div class="field"><label>音楽フォルダの共有リンク${S.code ? '（変えるときだけ）' : ''}</label>
      <input id="cd" placeholder="https://u.pcloud.link/publink/show?code=…"
        autocapitalize="off" autocorrect="off" spellcheck="false"></div>
    <div class="field"><label>合言葉（掛けていなければ空のまま）</label>
      <input id="cpw" type="password" placeholder="${S.linkpw ? '設定済み。変えるときだけ' : ''}" autocomplete="off"></div>
    <button class="primary" id="ctest">つないで棚を読む</button>
    <div class="msg" id="cm"></div>
    ${S.code ? '<div style="height:10px"></div><button class="hbtn" id="cclr" style="width:100%;padding:10px;border-radius:10px">符号を忘れる</button>' : ''}
    <div class="note" style="padding:16px 2px 0;line-height:1.9">
      <b>誰に何が見えるか</b><br>
      ・このページを開いただけの人には<b>何も見えません</b>。符号はこの端末の中にだけあります<br>
      ・<b>符号を知っている人は、音楽フォルダを開いて落とせます</b>。これは共有リンクの性質そのもの<br>
      ・気になるなら pCloud 側で<b>リンクに合言葉</b>を掛け、上の欄に入れてください。
        符号だけでは開けなくなります<br>
      ・pCloud のリンク設定で<b>期限</b>も付けられます。切れたら作り直して貼り替えるだけです<br><br>
      <b>共有リンクの作り方</b><br>
      1. pCloud で <b>音楽</b> フォルダを右クリック → 共有 → リンクを取得<br>
      2. 出てきた URL をそのまま上に貼る<br><br>
      リンクを知っている人はフォルダを開けます。気になるときは
      <b>pCloud 側でリンクに合言葉を掛けて</b>、それを下の欄に入れてください。
    </div>`;
  const run = async () => {
    const typed = $('#cd').value.trim();
    const { code, host } = typed ? parseCode(typed) : { code: S.code, host: null };
    if (!code) { $('#cm').className = 'msg err'; $('#cm').textContent = '符号が読み取れません'; return; }
    const pw = $('#cpw').value || (typed ? '' : S.linkpw);
    const before = { code: S.code, pw: S.linkpw, host: S.host };
    S.code = code; S.linkpw = pw; if (host) S.host = host;
    $('#cm').className = 'msg'; $('#cm').textContent = '読んでいます…';
    try {
      const r = await apiPub('showpublink', { recursive: 1 });
      const out = [];
      walk(r.metadata, [], out);
      LS.set('code', S.code); LS.set('linkpw', S.linkpw); LS.set('host', S.host);
      LS.set('rootName', S.rootName = r.metadata.name || '音楽');
      S.albums = out.sort((a, b) => collator.compare(a.artist + a.name, b.artist + b.name));
      note('符号で棚を読めた: ' + S.albums.length + 'アルバム');
      $('#cm').className = 'msg ok';
      $('#cm').textContent = S.albums.length + ' アルバム読めました';
      setTimeout(() => go('#/lib'), 700);
    } catch (e) {
      S.code = before.code; S.linkpw = before.pw; S.host = before.host;
      $('#cm').className = 'msg err';
      $('#cm').innerHTML = esc(e.code === 2000 || e.code === 2261 ? '合言葉が違うか、リンクが見つかりません' : (e.message || '読めません')) +
        (e.code > 0 ? `<br><span style="color:var(--dim);font-size:11.5px">pCloud の返事: ${e.code}</span>` : '');
    }
  };
  $('#ctest').onclick = run;
  $('#cpw').onkeydown = e => { if (e.key === 'Enter') run(); };
  const c = $('#cclr'); if (c) c.onclick = () => {
    S.code = ''; S.linkpw = ''; LS.del('code'); LS.del('linkpw'); S.albums = []; screenCode();
  };
  $('#back').onclick = () => go(S.auth || S.code ? '#/lib' : '#/login');
}

function screenRelay() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '中継所';
  $('#btnCovers').classList.add('hide');
  main().innerHTML = `
    <div class="note" style="padding:0 2px 14px">pCloud は、ブラウザから直接だと音のリンクを出しません
      （<b>pcloud.com 以外の場所からは原理的に取れない</b>仕組みです）。
      サーバーから頼めば普通に出るので、あなたの中継所を1つ置いてそこ経由にします。
      置き方は下に。無料枠で足ります。</div>
    <div class="field"><label>中継所のURL</label>
      <input id="rl" placeholder="https://ongakudana.○○○.workers.dev"
        value="${esc(S.relay)}" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
    <div class="setrow" style="display:flex;gap:8px">
      <button class="primary" id="rsave" style="flex:1">覚えて試す</button>
      ${S.relay ? '<button class="hbtn" id="rclr">やめる</button>' : ''}
    </div>
    <div class="msg" id="rm"></div>
    <div style="height:18px"></div>
    <div class="rowlist">
      <button class="row" id="pub">
        <span class="nm">公開リンクを使う（最後の手段）<br>
          <span class="sub">直リンクが断られるときだけ。曲ごとに「リンクを知っていれば誰でも取得できる状態」を作ります</span></span>
        <span class="chk ${S.pub ? 'on' : ''}">${S.pub ? '✓' : ''}</span>
      </button>
      <button class="row" id="pubclean"><span class="nm">作った公開リンクを全部消す</span><span class="sub">›</span></button>
    </div>
    <div class="note" style="padding:14px 2px 0;line-height:1.9">
      <b>置き方</b><br>
      1. dash.cloudflare.com を開く（アカウントが無ければ作る）<br>
      2. Workers &amp; Pages → Create → Start with Hello World → Deploy<br>
      3. Edit code を開き、中身を全部消して <b>worker.js</b> の中身を貼る → Deploy<br>
      4. 出てきた <b>…workers.dev</b> のURLをここに入れる<br><br>
      中継所には pCloud の合鍵が渡ります（あなたのものです）。記録は残さない作りにしてあります。
    </div>`;
  const test = async () => {
    const v = $('#rl').value.trim().replace(/\/+$/, '');
    if (!v) return;
    $('#rm').className = 'msg'; $('#rm').textContent = '試しています…';
    try {
      const r = await fetch(v + '/', { referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.relay = v; LS.set('relay', v);
      /* 実際に1曲ぶんの頭を取ってみる */
      const al = S.albums.find(a => a.tracks.length);
      if (al) {
        const rr = await fetch(relayUrl('/link', al.tracks[0]), { referrerPolicy: 'no-referrer' });
        const j = await rr.json();
        if (!j.url) throw new Error(j.error || 'リンクを取れません');
      }
      $('#rm').className = 'msg ok'; $('#rm').textContent = '通りました。これで聴けます';
      note('中継所が通った: ' + v);
    } catch (e) {
      $('#rm').className = 'msg err'; $('#rm').textContent = '駄目でした: ' + (e.message || e);
    }
  };
  $('#rsave').onclick = test;
  $('#rl').onkeydown = e => { if (e.key === 'Enter') test(); };
  const c = $('#rclr'); if (c) c.onclick = () => { S.relay = ''; LS.del('relay'); screenRelay(); };
  $('#pub').onclick = () => {
    S.pub = !S.pub; LS.set('pub', S.pub); V.direct = null;
    toast(S.pub ? '公開リンク経由にしました' : '公開リンクを使わない設定にしました');
    screenRelay();
  };
  $('#pubclean').onclick = async () => {
    $('#rm').className = 'msg'; $('#rm').textContent = '消しています…';
    try {
      const l = await api('listpublinks');
      const links = l.publinks || [];
      let n = 0;
      for (const p of links) { try { await api('deletepublink', { linkid: p.linkid }); n++; } catch (e) {} }
      $('#rm').className = 'msg ok'; $('#rm').textContent = n + ' 本消しました（全' + links.length + '本）';
    } catch (e) { $('#rm').className = 'msg err'; $('#rm').textContent = '消せません: ' + (e.message || e); }
  };
  $('#back').onclick = () => go('#/lib');
}

function screenRoutes() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '取り出し方を調べる';
  $('#btnCovers').classList.add('hide');
  main().innerHTML = `
    <div class="note" style="padding:0 2px 14px">棚の最初の曲を使って、pCloud のどの取り出し方が通るかを一通り試します。
      曲は再生しません。読み取りだけです。</div>
    <button class="primary" id="run">調べる</button>
    <div style="height:12px"></div>
    <button class="hbtn" id="runp" style="width:100%;padding:11px;border-radius:10px">
      公開リンクを作る手も含めて調べる</button>
    <div class="note" style="padding:8px 2px 0">
      こちらは <b>その曲について「リンクを知っていれば誰でも取得できる状態」を一時的に作ります</b>
      （符号は推測できない長さで、試した直後に消します）。pCloud 自身がウェブアプリ向けに案内している方法です。
      作りたくなければ上のボタンだけ押してください。</div>
    <pre id="out" class="hide" style="white-space:pre-wrap;font-size:11.5px;color:var(--dim);
      background:#0c0c10;border:1px solid var(--line);border-radius:9px;padding:12px;margin-top:16px;line-height:1.75"></pre>`;
  const run = async withPub => {
    const o = $('#out'); o.classList.remove('hide'); o.textContent = '調べています…';
    try { o.textContent = await probeRoutes(withPub); }
    catch (e) { o.textContent = '調べられません: ' + (e.message || e); }
  };
  $('#run').onclick  = () => run(false);
  $('#runp').onclick = () => run(true);
  $('#back').onclick = () => go('#/lib');
}

/* ============ 何があっても黙らせない ============ */
/* 押しても何も出ない、が一番困る。拾えなかった失敗は画面の下に出す。 */
function shout(what, detail) {
  let b = document.getElementById('shout');
  if (!b) {
    b = document.createElement('div');
    b.id = 'shout';
    b.style.cssText = 'position:fixed;left:10px;right:10px;bottom:10px;z-index:99;background:#3a1f22;' +
      'border:1px solid #6b3238;color:#f0d5d7;padding:11px 13px;border-radius:11px;font-size:12px;' +
      'line-height:1.6;word-break:break-word;max-height:42vh;overflow:auto';
    b.onclick = () => b.remove();
    document.body.appendChild(b);
  }
  b.textContent = what + ': ' + detail + '（触ると消えます）';
}
window.addEventListener('error', e => shout('落ちました', (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
window.addEventListener('unhandledrejection', e => {
  const r = e.reason || {};
  shout('拾えなかった失敗', (r.code != null ? 'code=' + r.code + ' ' : '') + (r.message || String(r)));
});

/* 何が使えて何が駄目かを、画面だけで確かめられるようにする。 */
async function selftest() {
  const L = [];
  L.push('開き方: ' + location.protocol + '//' + location.host);
  L.push('暗号(crypto.subtle): ' + (window.crypto && crypto.subtle ? 'ある' : '★ない'));
  L.push('控え(Cache Storage): ' + ('caches' in window ? 'ある' : 'ない'));
  try { localStorage.setItem('pm.t', '1'); localStorage.removeItem('pm.t'); L.push('端末の記憶: 書ける'); }
  catch (e) { L.push('端末の記憶: ★書けない（' + e.name + '）'); }
  for (const h of ['api.pcloud.com', 'eapi.pcloud.com']) {
    const t = Date.now();
    try { const d = await api('getdigest', {}, h, 12000); L.push(h + ': 返事あり ' + (Date.now() - t) + 'ms'); }
    catch (e) { L.push(h + ': ★' + (e.message || e)); }
  }
  L.push('版: v62');
  L.push('波形: ' + (V.ok ? '本物（' + (V.tap || '') + '）' : S.deco ? '飾り' : '止' ));
  L.push('入口ごし: ' + (GATE ? 'はい（符号は端末に無い）' : 'いいえ'));
  L.push('共有リンク: ' + (S.code ? 'あり' : 'なし'));
  L.push('公開リンク経由: ' + (S.pub ? 'はい' : 'いいえ'));
  L.push('直接取得: ' + (V.direct === null ? '未確認' : V.direct ? 'できる' : 'できない'));
  L.push('中継所: ' + (S.relay || 'なし'));
  L.push('直リンク: ' + (V.link === null ? '未確認' : V.link ? '使える' : '使えない'));
  L.push('');
  L.push('― できごと ―');
  L.push(readLog());
  return L.join('\n');
}

/* ============ ジュークボックス ============ */
/* 選ぶこと自体を楽しむ画面。棚を「曲目札」に見立て、A1・A2… の番号で選ぶ。
   1535枚を一望する画面ではない。20枚ずつめくって、目に留まったものを押す。 */
const JB = { page: 0, per: 20, pick: '' };
const jbCode = i => String.fromCharCode(65 + Math.floor(i / 5)) + ((i % 5) + 1);

function screenJuke() {
  $('#hdr').classList.add('hide');
  const pool = shownAlbums();
  if (!pool.length) { toast('棚が空です'); go('#/lib'); return; }
  const pages = Math.max(1, Math.ceil(pool.length / JB.per));
  if (JB.page >= pages) JB.page = 0;
  const list = pool.slice(JB.page * JB.per, JB.page * JB.per + JB.per);
  const c = cur();
  main().innerHTML = `
    <div class="jb"><div class="cab">
      <div class="arch">
        <div class="tube"></div><div class="tube b"></div>
        <div class="name">音楽棚</div>
      </div>
      <div class="win">
        <div class="now2">
          ${c && coverOf(c.al) ? `<img src="${esc(coverOf(c.al))}">` : '<img alt="">'}
          <div class="t3">
            <div class="n3">${c ? esc(trackTitle(c.al.tracks[c.i])) : '— 選んでください —'}</div>
            <div class="a3">${c ? esc([artistOf(c.al), c.al.name].filter(Boolean).join(' — ')) : esc(pool.length + ' 枚から')}</div>
          </div>
          <div class="t3" style="flex:0 0 auto;text-align:right">
            <div class="n3" style="font-size:22px">${esc(JB.pick || jbCode(0))}</div>
            <div class="a3">${JB.page + 1} / ${pages} 面</div>
          </div>
        </div>
        <div class="rack">${list.map((al, i) => `
          <button class="strip ${c && c.al.id === al.id ? 'on' : ''}" data-j="${i}">
            <span class="code">${jbCode(i)}</span>
            <span class="txt">
              <span class="s1">${esc(al.name)}</span>
              <span class="s2">${esc(artistOf(al) || '—')}${albumYear(al) ? ' · ' + esc(albumYear(al)) : ''} · ${al.tracks.length}曲</span>
            </span>
          </button>`).join('')}</div>
      </div>
      <div class="keys">
        <button id="jprev">◀</button>
        <button id="jplay">${au.paused ? '▶' : '⏸'}</button>
        <button id="jnext">▶</button>
        <button id="jpage" class="wide">次の面 ⟳</button>
        <button id="jrand" class="wide">おまかせ 🔀</button>
        <button id="jclose" class="wide">とじる</button>
      </div>
      <div class="foot">札を押すとその盤が掛かります。キーボードなら A1 … D5 の番号でも選べます。</div>
    </div></div>`;
  main().querySelectorAll('[data-j]').forEach(b => b.onclick = () => {
    const al = list[+b.dataset.j];
    JB.pick = jbCode(+b.dataset.j);
    startQueue(albumRefs(al).concat(shuffle(pool.filter(x => x !== al)).slice(0, 30).flatMap(albumRefs)), 0);
    setTimeout(() => screenJuke(), 120);
  });
  $('#jprev').onclick  = () => { prevTrack(); setTimeout(screenJuke, 120); };
  $('#jnext').onclick  = () => { nextTrack(); setTimeout(screenJuke, 120); };
  $('#jplay').onclick  = () => { au.paused ? au.play().catch(() => {}) : au.pause(); setTimeout(screenJuke, 120); };
  $('#jpage').onclick  = () => { JB.page = (JB.page + 1) % pages; screenJuke(); };
  $('#jrand').onclick  = () => {
    JB.page = Math.floor(Math.random() * pages);
    screenJuke();
    const al = pool[Math.floor(Math.random() * pool.length)];
    startQueue(albumRefs(al).concat(shuffle(pool).slice(0, 30).flatMap(albumRefs)), 0);
  };
  $('#jclose').onclick = () => go('#/lib');
  /* A1 … D5 で選ぶ */
  JB.keys = e => {
    if (location.hash !== '#/juke') return;
    const k = e.key.toUpperCase();
    if (/^[A-D]$/.test(k)) { JB.buf = k; return; }
    if (/^[1-5]$/.test(k) && JB.buf) {
      const i = (JB.buf.charCodeAt(0) - 65) * 5 + (+k - 1);
      const b = main().querySelector(`[data-j="${i}"]`);
      if (b) b.click();
      JB.buf = '';
    }
  };
  removeEventListener('keydown', JB.prevKeys || (() => {}));
  JB.prevKeys = JB.keys;
  addEventListener('keydown', JB.keys);
}

/* ============ 手元の道具から操る ============ */
/* キーボード、テレビのリモコン（Fire TV など）、ゲームのコントローラ。
   どれも「送られてくる合図」は似ているので、一箇所で受ける。 */
const typing = e => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};
function nudge(sec) { try { au.currentTime = Math.max(0, au.currentTime + sec); } catch (e) {} }
function vol(d) { setVol(au.volume + d); }
function toggle() { au.paused ? au.play().catch(() => {}) : au.pause(); }

addEventListener('keydown', e => {
  if (typing(e)) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key;
  const hit = {
    ' ': toggle, 'MediaPlayPause': toggle, 'Enter': toggle, 'k': toggle,
    'MediaTrackNext': () => nextTrack(), 'MediaTrackPrevious': prevTrack,
    'ArrowRight': () => (e.shiftKey ? nextTrack() : nudge(10)),
    'ArrowLeft':  () => (e.shiftKey ? prevTrack() : nudge(-10)),
    'ArrowUp':    () => vol(0.05),
    'ArrowDown':  () => vol(-0.05),
    'n': () => nextTrack(), 'p': prevTrack,
    'j': () => nudge(-10), 'l': () => nudge(10),
    'm': () => { au.muted = !au.muted; toast(au.muted ? '消音' : '消音を解く', 900); },
    'f': () => go('#/now'), 'v': () => go('#/now'),
    'c': () => go('#/car'), 'q': () => go('#/queue'), 'b': () => go('#/juke'),
    '/': () => go('#/search'), 's': () => go('#/search'),
    'g': () => go('#/lib'),
    'Escape': () => go(location.hash === '#/lib' ? '#/lib' : '#/lib'),
    'Backspace': () => history.back(),
    'BrowserBack': () => history.back(),
  }[k];
  if (hit) { e.preventDefault(); hit(); }
}, true);

/* ゲームのコントローラ。押しっぱなしで連射しないよう、離すまで一度だけ。 */
let padPrev = [];
function padLoop() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p) continue;
    const now = p.buttons.map(b => b.pressed);
    const was = padPrev[p.index] || [];
    const down = i => now[i] && !was[i];
    if (down(0)) toggle();                  /* A */
    if (down(1)) history.back();            /* B */
    if (down(5) || down(15)) nextTrack();   /* R / 右 */
    if (down(4) || down(14)) prevTrack();   /* L / 左 */
    if (down(12)) vol(0.05);                /* 上 */
    if (down(13)) vol(-0.05);               /* 下 */
    if (down(3)) go('#/now');               /* Y */
    if (down(2)) go('#/queue');             /* X */
    if (down(9)) go('#/car');               /* Start */
    padPrev[p.index] = now;
  }
  requestAnimationFrame(padLoop);
}
addEventListener('gamepadconnected', e => {
  toast('コントローラをつなぎました: ' + (e.gamepad.id || '').slice(0, 24), 3000);
  note('コントローラ: ' + (e.gamepad.id || ''));
});
if (navigator.getGamepads) requestAnimationFrame(padLoop);

/* ============ 起動 ============ */
note('画面を開いた（' + (location.hash || 'ハッシュなし') + '）');
/* Service Worker はやめた。同じ置き場への要求を横取りする性質が、
   音（部分取得）と相性が悪く、古いものが居座ると原因が見えなくなる。
   曲のオフライン保存は Cache Storage を自分で扱っているので影響しない。
   居座っているものは見つけ次第そのまま外す。 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(rs => {
    if (!rs.length) return;
    Promise.all(rs.map(r => r.unregister())).then(() => {
      caches.keys().then(ks => Promise.all(
        ks.filter(k => k.indexOf('shell') === 0 || k.indexOf('portal') === 0).map(k => caches.delete(k))
      )).then(() => { note('古い横取り役を外した: ' + rs.length); location.reload(); });
    });
  }).catch(() => {});
}
LS.del('link'); LS.del('cors');   /* 前の版が残した判定は捨てる */
document.body.dataset.cell = S.cell;
renderRoute();
paintPlayer();
