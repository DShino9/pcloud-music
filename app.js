'use strict';
/* 音楽棚 — pCloud の音楽をブラウザだけで聴く。
   マウントは一切使わない。すべて pCloud の HTTP API 経由。 */

/* ============ 小道具 ============ */
const $  = s => document.querySelector(s);
const main = () => $('#main');
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
  relay:  LS.get('relay', ''),      // 中継所のURL
  sweep:  null,
};
const saveMeta  = () => LS.set('meta', S.meta);
const saveFav   = () => LS.set('fav', S.fav);
const savePlays = () => LS.set('plays', S.plays);
const saveLists = () => LS.set('lists', S.lists);
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
  ['auth', 'email', 'rootId', 'rootName', 'covers', 'offline'].forEach(LS.del);
  Object.assign(S, { auth: '', email: '', rootId: null, rootName: '', albums: [], covers: {}, offline: {} });
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
  const r = await api('listfolder', { folderid, recursive: 1 });
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
async function findCandidates(term, al) {
  const seen = new Set();
  let out = [];
  const add = arr => { for (const c of arr) if (!seen.has(c.label)) { seen.add(c.label); out.push(c); } };
  const best = () => (al ? ((rank(out, al)[0] || {}).score || 0) : (out.length ? 1 : 0));
  const first = latinish(term) ? 'US' : 'JP', second = first === 'US' ? 'JP' : 'US';

  try { add(await itunesSearch(term, 15, first)); } catch (e) {}
  if (best() < SURE) { try { add(await itunesSearch(term, 15, second)); } catch (e) {} }
  if (best() < SURE) add(await deezerSearch(term, 8));
  return (al ? rank(out, al) : out).slice(0, 10);
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
        S.covers[al.id] = { url: best.url, src: best.src, q: albumQuery(al),
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
        S.covers[al.id] = { url: top.url, src: top.src, q, manual: false,
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
  if (al.folderCover) return thumbUrl(al.folderCover, 400);
  return null;
};

/* ============ 再生 ============ */
/* 待ち行列を器にする。アルバムを通して聴くのも、棚全体のシャッフルも、
   条件で組んだものも、すべて同じ「並んだ曲」として扱う。 */
const au = $('#au');
const P = { q: [], qi: -1, linkCache: new Map(), shuffled: false };
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
  const r = await api('getfilelink', { fileid, forcedownload: 0, skipfilename: 0 });
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
    au.crossOrigin = (V.ok && !so.local && so.cors !== false) ? 'anonymous' : null;
    src = so.url;
  } catch (e) {
    note('場所が分からない: ' + (e.code != null ? 'code=' + e.code + ' ' : '') + (e.message || e));
    const two = V.link === false;
    toast(two ? '直リンクも読み出しも断られました（' + (e.code || '') + '）' : '曲の場所が分かりません: ' + (e.message || e), 5000);
    return;
  }
  try {
    au.src = src;
    await au.play();
    pending = null;
  } catch (e) {
    note('鳴らせない: ' + e.name + ' ' + (e.message || ''));
    if (e.name === 'NotAllowedError') {
      pending = qi;
      toast('もう一度押してください（音を出す許可が要ります）', 4000);
    } else {
      toast('再生できません: ' + e.name + ' — ' + (e.message || e), 5000);
      if (S.relay) diagnoseRelay(t);
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
  if (!c) { p.classList.add('gone'); return; }
  p.classList.remove('gone');
  const t = c.al.tracks[c.i];
  $('#pti').textContent = trackTitle(t);
  $('#par').textContent = [c.al.artist, c.al.name].filter(Boolean).join(' — ');
  const cv = coverOf(c.al);
  $('#pcov').src = cv || '';
  $('#pcov').style.visibility = cv ? 'visible' : 'hidden';
  $('#play').textContent = au.paused ? '▶' : '⏸';
}
function setMediaSession() {
  const c = cur();
  if (!('mediaSession' in navigator) || !c) return;
  const t = c.al.tracks[c.i], cv = coverOf(c.al);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: trackTitle(t),
    artist: c.al.artist || '',
    album: c.al.name,
    artwork: cv ? [{ src: cv, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
  const set = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
  set('play',  () => au.play());
  set('pause', () => au.pause());
  set('previoustrack', prevTrack);
  set('nexttrack', nextTrack);
  set('seekbackward', d => { au.currentTime = Math.max(0, au.currentTime - ((d && d.seekOffset) || 15)); });
  set('seekforward',  d => { au.currentTime = au.currentTime + ((d && d.seekOffset) || 15); });
  set('seekto', d => { if (d && d.seekTime != null) au.currentTime = d.seekTime; });
}
function nextTrack() { if (P.qi + 1 < P.q.length) playAt(P.qi + 1); }
function prevTrack() {
  if (P.qi < 0) return;
  if (au.currentTime > 3) { au.currentTime = 0; return; }
  if (P.qi > 0) playAt(P.qi - 1);
}
/* 形式が合わない・読めない、は play() の失敗ではなく要素の error に出る。 */
au.addEventListener('error', () => {
  const e = au.error; if (!e || au.src === SILENT) return;
  const why = { 1:'読み込みを中断した', 2:'通信が切れた', 3:'音の中身を解けない',
                4:'この形式は再生できません' }[e.code] || ('error ' + e.code);
  const c = cur(), nm = c ? c.al.tracks[c.i].name : '';
  note('音が鳴らない: ' + why + ' / ' + nm.slice(-24));
  toast(why + (e.code === 4 ? '（' + nm.split('.').pop() + '）' : ''), 5000);
});
au.addEventListener('ended', nextTrack);
au.addEventListener('play',  paintPlayer);
au.addEventListener('pause', paintPlayer);
au.addEventListener('timeupdate', () => {
  if (au.duration) $('#seek').style.width = (au.currentTime / au.duration * 100) + '%';
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && au.duration) {
    try { navigator.mediaSession.setPositionState(
      { duration: au.duration, position: au.currentTime, playbackRate: au.playbackRate }); } catch (e) {}
  }
});
$('#play').onclick = () => (au.paused ? au.play() : au.pause());
$('#next').onclick = nextTrack;
$('#prev').onclick = prevTrack;
$('#pcov').onclick = () => go('#/now');
$('#pti').onclick  = () => { const c = cur(); if (c) go('#/album/' + c.al.id); };

/* ============ ビジュアライザー ============ */
/* 音を解析するには、音のデータに手が届かないといけない。
   pCloud から直に流している音がブラウザに読ませてもらえるかは、
   叩いてみるまで分からない。読めない音を Web Audio に通すと
   ブラウザは「音を消す」ので、確かめる前に繋いではいけない。 */
const V = { ctx:null, src:null, aL:null, aR:null, fL:null, fR:null, td:null,
            ok:false, cors:null, link:null, direct:null, directUrl:null,
            on:false, vi:0, raf:0 };
const BANDS = 84;

async function probeCors(fileid) {
  if (V.cors !== null) return V.cors;
  try {
    const u = await fileLink(fileid);
    const r = await fetch(u, { headers: { Range: 'bytes=0-1' } });
    V.cors = r.ok || r.status === 206;
  } catch (e) { V.cors = false; }

  note('直に流した音を読めるか: ' + (V.cors ? 'はい' : 'いいえ'));
  return V.cors;
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
function readAudio(dt) {
  if (!V.ok) return false;
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
  disc:  ['回転ジャケット', false],
  ladder:['L／R レベル',    true],
  bars:  ['スペクトラム',    true],
  mirror:['鏡像',           true],
  scope: ['オシロスコープ',  true],
  ring:  ['円環',           true],
  vu:    ['アナログVU',      true],
  parts: ['粒子',           true],
};
S.vis = LS.get('vis', ['disc', 'ladder', 'bars', 'ring', 'scope']);

const VD = {
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
      <canvas id="vcv"></canvas>
      <div class="nowname" id="vname"></div>
      <div class="nowbar"><i id="nseek"></i></div>
      <div class="nowctl">
        <button id="nprev">⏮</button><button id="nplay">▶</button><button id="nnext">⏭</button>
        <button class="hbtn" id="nq">並び</button>
      </div>
      <div class="msg" id="nmsg"></div>
    </div>`;
  const cv = $('#vcv'), ctx = cv.getContext('2d');
  const paint = () => {
    const cc = cur(); if (!cc) return;
    $('#nti').textContent = trackTitle(cc.al.tracks[cc.i]);
    $('#nar').textContent = [cc.al.artist, cc.al.name].filter(Boolean).join(' — ');
    $('#vname').textContent = (VIS[list[V.vi]] || VIS.disc)[0] + `（${V.vi + 1}/${list.length}・画面を触ると切り替え）`;
    $('#nplay').textContent = au.paused ? '▶' : '⏸';
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
  $('#nplay').onclick  = () => { au.paused ? au.play() : au.pause(); setTimeout(paint, 60); };
  $('#nq').onclick     = () => go('#/queue');
  $('#npick').onclick  = () => go('#/vis');
  au.addEventListener('play', paint); au.addEventListener('pause', paint);
  au.addEventListener('timeupdate', () => {
    const b = $('#nseek'); if (b && au.duration) b.style.width = (au.currentTime/au.duration*100)+'%';
  });
  /* 解析はここで初めて繋ぐ。読めない音を通すと無音になるので、確かめてから。 */
  (async () => {
    const cc = cur(); if (!cc) return;
    const tid = cc.al.tracks[cc.i].id;
    /* api 経由で読んだ音は手元にあるので、解析はいつでも通る。 */
    const local = !!(await cachedResponse(tid)) || blobs.has(tid) || !!S.relay;
    const cached = local;
    const ok = local ? true : await probeCors(tid);
    if (!ok) {
      $('#nmsg').className = 'msg';
      $('#nmsg').innerHTML = '直に流している音は解析できません。<b>アルバムを「端末に入れる」と、全部の絵が動きます。</b>';
      return;
    }
    if (!V.ok) {
      /* いま鳴っている曲は CORS の印なしで読み込まれている。
         そのまま解析器に繋ぐとブラウザが音を消すので、同じ位置で読み込み直す。 */
      if (!cached) {
        const pos = au.currentTime, wasPlaying = !au.paused, src = au.src;
        au.crossOrigin = 'anonymous';
        au.src = src;
        au.addEventListener('loadedmetadata', function once() {
          au.removeEventListener('loadedmetadata', once);
          try { au.currentTime = pos; } catch (e) {}
          if (wasPlaying) au.play().catch(() => {});
        });
      }
      initGraph();
      if (V.ctx && V.ctx.state === 'suspended') { try { await V.ctx.resume(); } catch (e) {} }
      if (!V.ok) {
        $('#nmsg').className = 'msg';
        $('#nmsg').textContent = '解析器を作れませんでした。回転ジャケットなら動きます';
      }
    }
  })();
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
    <div class="note" style="padding:0 2px">選んだものを、再生画面で触るたびに順に切り替えます。
    解析が要るものは、直に流している音では動かないことがあります（端末に入れた曲なら確実に動きます）。</div>`;
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
  '&auth=' + encodeURIComponent(S.auth);

/* 中継所が出したリンクを、ブラウザが直接取れるかどうか試す。 */
async function tryDirect(t) {
  try {
    const r = await fetch(relayUrl('/link', t), { referrerPolicy: 'no-referrer' });
    const j = await r.json();
    if (!j.url) return false;
    const probe = await fetch(j.url, { headers: { Range: 'bytes=0-99' }, referrerPolicy: 'no-referrer' });
    if (probe.ok || probe.status === 206) {
      const b = new Uint8Array(await probe.arrayBuffer());
      const txt = String.fromCharCode(...b.slice(0, 4));
      if (txt.startsWith('<htm') || txt.startsWith('{')) { note('直接取得: 中身が音でない'); return false; }
      V.directUrl = j.url;
      note('直接取得できる（' + probe.status + '）');
      return true;
    }
    note('直接取得は ' + probe.status + ' で断られた');
  } catch (e) { note('直接取得できない: ' + (e.message || e)); }
  return false;
}

async function trackSource(t) {
  const hit = await cachedResponse(t.id);
  if (hit) return { url: URL.createObjectURL(await hit.blob()), local: true };
  if (blobs.has(t.id)) return { url: blobs.get(t.id), local: true };
  /* 中継所がある場合、道は2つ。
     ① 中継所にリンクだけ出してもらい、ブラウザが直接 pCloud から取る（速い）
     ② 中継所に中身ごと流してもらう
     pCloud のリンクは要求した相手に紐づくらしく、②が 410 で断られることがある。
     どちらが通るかは相手次第なので、一度試して通った方を覚える。 */
  if (S.relay) {
    V.directUrl = null;
    const okDirect = (V.direct === false) ? false : await tryDirect(t);
    if (V.direct === null) V.direct = okDirect;
    if (okDirect && V.directUrl) return { url: V.directUrl, local: false, cors: true };
    return { url: relayUrl('/audio', t), local: false, cors: true };
  }
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

/* ============ 画面 ============ */
/* ハッシュが同じだと hashchange が飛ばない。
   #/pick/0 が付いたまま開き直してログインすると、成功しても画面が変わらず
   「つないでいます…」のまま固まる（実際に踏んだ）。同じときは自分で描き直す。 */
function go(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}
window.addEventListener('hashchange', renderRoute);

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

async function screenLib() {
  $('#hdr').classList.remove('hide');
  $('#title').textContent = S.rootName || '音楽棚';
  $('#btnCovers').classList.remove('hide'); $('#btnMenu').classList.remove('hide');
  $('#back').classList.add('hide');
  if (!S.albums.length) {
    main().innerHTML = '<div class="empty">棚を読んでいます…<br>（初回は少しかかります）</div>';
    try {
      S.albums = await scanLibrary(S.rootId);
    } catch (e) {
      main().innerHTML = `<div class="empty">読めません: ${esc(e.message)}<br><br>
        <button class="hbtn" onclick="location.hash='#/pick/0'">フォルダを選び直す</button></div>`;
      return;
    }
  }
  const sw = S.sweep ? `<div class="sweep"><div class="bar"><i id="swbar"></i></div>
      <span id="swtxt"></span><button class="hbtn" id="swstop">やめる</button></div>` : '';
  const counts = {};
  for (const k of Object.keys(FILTERS)) counts[k] = S.albums.filter(FILTERS[k][1]).length;
  const chips = `<div class="chips">` +
    Object.keys(FILTERS).map(k =>
      `<button class="hbtn ${S.filter === k ? 'on' : ''}" data-f="${k}">${FILTERS[k][0]} ${counts[k]}</button>`).join('') +
    `</div>`;
  const gl = genreList();
  const bar = `<div class="tools">
      <select id="sortsel">${Object.keys(SORTS).map(k =>
        `<option value="${k}"${S.sort === k ? ' selected' : ''}>${SORTS[k][0]}</option>`).join('')}</select>
      <select id="gensel">
        <option value="">ジャンル：すべて</option>
        ${gl.map(([g, n]) => `<option value="${esc(g)}"${S.genre === g ? ' selected' : ''}>${esc(g)}（${n}）</option>`).join('')}
      </select>
      <button class="hbtn" id="shufAll">🔀 シャッフル</button>
      <button class="hbtn" id="smart">条件で組む</button>
    </div>`;
  const shown = shownAlbums();
  main().innerHTML = sw + chips + bar + `<div class="grid">${shown.map(al => {
    const cv = coverOf(al), c = S.covers[al.id];
    const badge = c && !c.manual && c.sure === false ? '<span class="badge auto">要確認</span>'
                : albumOffline(al) ? '<span class="badge off">端末</span>' : '';
    const star = isFav('a' + al.id) ? '<span class="badge star">★</span>' : '';
    const y = albumYear(al);
    return `<button class="al" data-id="${al.id}">
      <div class="cov">${cv ? `<img loading="lazy" src="${esc(cv)}" onerror="this.style.display='none'">`
                            : '<span class="ph">♪</span>'}${badge}${star}</div>
      <div class="t">${esc(al.name)}</div>
      <div class="a">${esc(al.artist)}${y ? ' · ' + y : ''} · ${al.tracks.length}曲</div>
    </button>`;
  }).join('')}</div>` + (shown.length ? '' :
    `<div class="empty">${S.albums.length ? 'この条件に当てはまるものはありません' : '音楽ファイルが見つかりません'}</div>`);

  main().querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filter = b.dataset.f; LS.set('filter', S.filter); screenLib(); });
  $('#sortsel').onchange = e => { S.sort = e.target.value; LS.set('sort', S.sort); screenLib(); };
  $('#gensel').onchange  = e => { S.genre = e.target.value; LS.set('genre', S.genre); screenLib(); };
  $('#shufAll').onclick  = () => startQueue(shuffle(shown.flatMap(albumRefs)), 0);
  $('#smart').onclick    = () => go('#/smart');
  main().querySelectorAll('.al').forEach(b => b.onclick = () => go('#/album/' + b.dataset.id));
  const stop = $('#swstop'); if (stop) stop.onclick = () => { S.sweep.stop = true; toast('止めます'); };
  updateSweepBar();
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
      <div class="cov">${cv ? `<img src="${esc(cv)}">` : '<span class="ph">♪</span>'}</div>
      <div class="meta">
        <h2>${esc(al.name)}</h2>
        <div class="a">${esc(al.artist)}</div>
        <div class="a">${[g, y, al.tracks.length + ' 曲', pc ? '聴いた ' + pc + ' 回' : ''].filter(Boolean).join(' · ')}</div>
        <div class="acts">
          <button class="hbtn" id="pall">▶ 通して聴く</button>
          <button class="hbtn" id="pshuf">🔀</button>
          <button class="hbtn ${fav ? 'on' : ''}" id="fav">${fav ? '★' : '☆'}</button>
          <button class="hbtn" id="qnext">次に流す</button>
          <button class="hbtn" id="cov">ジャケット</button>
          <button class="hbtn" id="dl">${albumOffline(al) ? '端末から消す' : '端末に入れる'}</button>
        </div>
      </div>
    </div>
    <div>${al.tracks.map((t, i) => `
      <div class="tk ${P.album && P.album.id === al.id && P.i === i ? 'playing' : ''} ${S.offline[t.id] ? 'cached' : ''}">
        <button class="hit" data-i="${i}"><span class="n">${i + 1}</span><span class="nm">${esc(trackTitle(t))}</span></button>
        <button class="star ${isFav('t' + t.id) ? 'on' : ''}" data-star="${t.id}">${isFav('t' + t.id) ? '★' : '☆'}</button>
      </div>`).join('')}</div>`;
  main().querySelectorAll('[data-i]').forEach(b => b.onclick = () => play(al, +b.dataset.i));
  main().querySelectorAll('[data-star]').forEach(b => b.onclick = () => {
    toggleFav('t' + b.dataset.star);
    b.classList.toggle('on'); b.textContent = b.classList.contains('on') ? '★' : '☆';
  });
  $('#pall').onclick  = () => play(al, 0);
  $('#pshuf').onclick = () => startQueue(shuffle(albumRefs(al)), 0);
  $('#qnext').onclick = () => enqueueNext(albumRefs(al));
  $('#fav').onclick   = () => { toggleFav('a' + al.id); screenAlbum(id); };
  $('#cov').onclick   = () => go('#/cover/' + al.id);
  $('#dl').onclick    = e => (albumOffline(al) ? removeAlbum(al) : downloadAlbum(al, e.currentTarget));
  $('#back').onclick  = () => go('#/lib');
}

/* いま並んでいるもの */
function screenQueue() {
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = '流れているもの';
  $('#btnCovers').classList.add('hide');
  if (!P.q.length) { main().innerHTML = '<div class="empty">まだ何も流していません</div>'; $('#back').onclick = () => go('#/lib'); return; }
  main().innerHTML = `
    <div class="tools"><button class="hbtn" id="qshuf">🔀 並べ直す</button>
      <button class="hbtn" id="qclear">空にする</button>
      <span class="a" style="align-self:center">${P.q.length} 曲</span></div>
    <div>${P.q.map((r, i) => `
      <button class="tk ${i === P.qi ? 'playing' : ''}" data-q="${i}">
        <span class="n">${i === P.qi ? '▶' : i + 1}</span>
        <span class="nm">${esc(trackTitle(r.al.tracks[r.i]))}<br>
          <span class="a" style="font-size:11.5px">${esc(r.al.artist)} — ${esc(r.al.name)}</span></span>
      </button>`).join('')}</div>`;
  main().querySelectorAll('[data-q]').forEach(b => b.onclick = () => playAt(+b.dataset.q));
  $('#qshuf').onclick  = () => { const c = cur(); P.q = shuffle(P.q); P.qi = c ? P.q.indexOf(c) : 0; screenQueue(); };
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

async function screenCover(id) {
  const al = S.albums.find(a => String(a.id) === String(id));
  if (!al) { go('#/lib'); return; }
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = 'ジャケットを選ぶ';
  $('#btnCovers').classList.add('hide');
  const cur = S.covers[al.id] || {};
  const q = cur.q || albumQuery(al);
  const draw = (cands, loading) => {
    main().innerHTML = `
      <div class="crumb">${esc(al.artist)} / ${esc(al.name)}</div>
      <div class="searchrow"><input id="q" value="${esc(q)}"><button class="hbtn" id="rs">探す</button></div>
      ${cur.url ? `<div style="margin-top:14px"><div class="a" style="font-size:12px;color:var(--dim);margin-bottom:6px">いま使っているもの（${esc(cur.src || '手動')}）</div>
        <img src="${esc(cur.url)}" style="width:120px;border-radius:9px"></div>` : ''}
      ${loading ? '<div class="empty">探しています…</div>' : `
      <div class="cands">${cands.map((c, i) => `
        <button class="cand ${cur.url === c.url ? 'sel' : ''}" data-i="${i}">
          <img loading="lazy" src="${esc(c.thumb || c.url)}" onerror="this.closest('.cand').style.display='none'">
          <div class="cl">${esc(c.label)}<br>${esc(c.src)}${c.n ? ' ' + c.n + '曲' : ''}${c.score != null ? ' ・ ' + Math.round(c.score * 100) + '%' : ''}</div>
        </button>`).join('') || '<div class="empty">候補がありません。言葉を変えて探し直してください。</div>'}</div>`}
      <div style="height:16px"></div>
      <div class="rowlist">
        ${al.folderCover ? `<button class="row" id="usefolder"><span class="nm">フォルダにある画像を使う</span></button>` : ''}
        <button class="row" id="push"><span class="nm">選んだ1枚を pCloud のこのフォルダに cover.jpg として置く</span></button>
        ${cur.url ? `<button class="row" id="clr"><span class="nm" style="color:var(--danger)">ジャケットを外す</span></button>` : ''}
      </div>
      <div class="note" style="padding:0 2px">選ばなかった候補は端末にもクラウドにも残しません。
      あとで選び直せるよう、候補の在り処だけ索引に控えます。</div>`;
    main().querySelectorAll('.cand').forEach(b => b.onclick = () => {
      const c = cands[+b.dataset.i];
      S.covers[al.id] = { url: c.url, src: c.src, q: $('#q').value, cands, manual: true, sure: true };
      if (c.g || c.y) { S.meta[al.id] = { g: c.g || '', y: c.y || '' }; saveMeta(); }
      saveCovers(); toast('決めました'); go('#/album/' + al.id);
    });
    const rs = $('#rs'); if (rs) rs.onclick = async () => {
      draw([], true);
      const c = await findCandidates($('#q') ? $('#q').value : q, al);
      cur.q = q; draw(c, false);
    };
    const uf = $('#usefolder'); if (uf) uf.onclick = () => {
      S.covers[al.id] = { url: thumbUrl(al.folderCover, 600), src: 'フォルダ', q, cands: [], manual: true };
      saveCovers(); go('#/album/' + al.id);
    };
    const clr = $('#clr'); if (clr) clr.onclick = () => { delete S.covers[al.id]; saveCovers(); go('#/album/' + al.id); };
    $('#push').onclick = async () => {
      const c = S.covers[al.id];
      if (!c) { toast('先に1枚選んでください'); return; }
      try {
        const blob = await (await fetch(c.url)).blob();
        const fd = new FormData(); fd.append('file', blob, 'cover.jpg');
        const u = new URL('https://' + S.host + '/uploadfile');
        u.searchParams.set('auth', S.auth); u.searchParams.set('folderid', al.id);
        u.searchParams.set('filename', 'cover.jpg'); u.searchParams.set('nopartial', 1);
        const j = await (await fetch(u, { method: 'POST', body: fd })).json();
        toast(j.result === 0 ? 'cover.jpg を置きました' : '置けません: ' + j.error);
      } catch (e) { toast('置けません: ' + e.message); }
    };
  };
  draw(cur.cands || [], !(cur.cands && cur.cands.length));
  if (!(cur.cands && cur.cands.length)) draw(await findCandidates(q, al), false);
  $('#back').onclick = () => go('#/album/' + al.id);
}

/* プレイリスト。索引に混ぜて pCloud 経由で端末をまたがせる。 */
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
      <button class="row" id="relay"><span class="nm">中継所</span><span class="sub">${S.relay ? '設定済み' : '未設定'}</span></button>
      <button class="row" id="routes"><span class="nm">取り出し方を調べる</span><span class="sub">再生できないとき</span></button>
      <button class="row" id="meta"><span class="nm">ジャンルと年代を集める</span><span class="sub">${Object.keys(S.meta).length} 枚</span></button>
      <button class="row" id="lists"><span class="nm">プレイリスト</span><span class="sub">${Object.keys(S.lists).length} 本</span></button>
      <button class="row" id="hist"><span class="nm">聴いた履歴</span><span class="sub">${S.hist.length} 件</span></button>
      <button class="row" id="save"><span class="nm">索引を pCloud に控える</span><span class="sub">${INDEX_NAME}</span></button>
      <button class="row" id="load"><span class="nm">索引を pCloud から取り込む</span></button>
      <button class="row" id="pick"><span class="nm">音楽フォルダを選び直す</span><span class="sub">${esc(S.rootName)}</span></button>
      <button class="row" id="clroff"><span class="nm">端末の音を全部消す</span><span class="sub">${n} 曲</span></button>
      <button class="row" id="out"><span class="nm" style="color:var(--danger)">つなぎを切る</span><span class="sub">${esc(S.email)}</span></button>
    </div>
    <div class="note">ジャケットは iTunes と Deezer の公開API から取っています。無料・鍵不要で、
    1枚あたり0.3秒ほど。サイトを見て回らないので、待たされも費用もありません。</div>`;
  $('#rescan').onclick = async () => { S.albums = []; go('#/lib'); };
  $('#sweep').onclick   = () => { go('#/lib'); setTimeout(() => sweepCovers(true), 60); };
  $('#sweepall').onclick= () => {
    for (const [k, v] of Object.entries(S.covers)) if (!v.manual) delete S.covers[k];
    saveCovers(); go('#/lib'); setTimeout(() => sweepCovers(true), 60);
  };
  $('#relay').onclick  = () => go('#/relay');
  $('#routes').onclick = () => go('#/routes');
  $('#meta').onclick  = () => sweepMeta();
  $('#lists').onclick = () => go('#/lists');
  $('#hist').onclick  = () => go('#/history');
  $('#save').onclick = async () => { try { await saveIndexToCloud(); toast('控えました'); } catch (e) { toast('控えられません: ' + e.message); } };
  $('#load').onclick = async () => { try { toast(await loadIndexFromCloud() ? '取り込みました' : '控えがありません'); renderRoute(); } catch (e) { toast(e.message); } };
  $('#pick').onclick = () => go('#/pick/0');
  $('#clroff').onclick = async () => {
    if ('caches' in window) await caches.delete('tracks-v1');
    S.offline = {}; saveOffline(); toast('消しました'); renderRoute();
  };
  $('#out').onclick = () => { logout(); go('#/login'); location.reload(); };
  $('#back').onclick = () => go('#/lib');
}

function renderRoute() {
  const h = location.hash || '';
  if (!S.auth) {
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
  if (h === '#/routes')          return screenRoutes();
  if (h === '#/relay')           return screenRelay();
  if (h === '#/queue')           return screenQueue();
  if (h === '#/smart')           return screenSmart();
  if (h === '#/lists')           return screenLists();
  if (h === '#/history')         return screenHistory();
  if (!S.rootId) return screenPick(0);
  return screenLib();
}
$('#btnMenu').onclick   = () => go('#/menu');
$('#btnCovers').onclick = () => sweepCovers(true);

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
      L.push(j.error ? ('pCloud が断った: ' + (j.result || '') + ' ' + j.error)
                     : ('リンクは取れた type=' + (j.type || 'なし')));
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
  L.push('版: v18');
  L.push('直接取得: ' + (V.direct === null ? '未確認' : V.direct ? 'できる' : 'できない'));
  L.push('中継所: ' + (S.relay || 'なし'));
  L.push('直リンク: ' + (V.link === null ? '未確認' : V.link ? '使える' : '使えない'));
  L.push('直に流した音を読めるか: ' + (V.cors === null ? '未確認' : V.cors ? 'はい' : 'いいえ'));
  L.push('');
  L.push('― できごと ―');
  L.push(readLog());
  return L.join('\n');
}

/* ============ 起動 ============ */
note('画面を開いた（' + (location.hash || 'ハッシュなし') + '）');
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
LS.del('link'); LS.del('cors');   /* 前の版が残した判定は捨てる */
renderRoute();
paintPlayer();
