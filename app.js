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
  set(k, v) { try { localStorage.setItem('pm.' + k, JSON.stringify(v)); } catch (e) {} },
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
  filter: LS.get('filter', 'all'),
  sweep:  null,
};
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
  try { r = await Promise.race([fetch(u, { cache: 'no-store', signal: ac.signal }), clock]); }
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
  let lastErr = null;
  for (const host of ['api.pcloud.com', 'eapi.pcloud.com']) {
    try {
      say(host + ' に問い合わせています…');
      const dg = await api('getdigest', {}, host);
      const pd = await sha1hex(password + (await sha1hex(email.toLowerCase())) + dg.digest);
      /* logout=1 は付けない。合鍵をその場で無効にしうる余計な指示で、要らない。 */
      const r = await api('userinfo',
        { getauth: 1, username: email, digest: dg.digest, passworddigest: pd }, host);
      /* 返事が result 0 でも合鍵が入っていないことがある。
         ここで黙って先に進むと、画面の振り分けが「未ログイン」と判断して
         ログイン画面を組み直し、入力も文字も消えて無言になる（実際に起きた）。 */
      if (!r.auth) {
        /* result 0 なのに合鍵が無い。何が返ってきたのかを名前だけ控える（値は残さない）。 */
        const keys = Object.keys(r).join(', ');
        note('合鍵なし。返ってきた項目: ' + keys);
        throw new PCloudError(-6, 'pCloud が合鍵を返しませんでした。返ってきた項目: ' + keys);
      }
      S.host = host; S.auth = r.auth; S.email = r.email || email;
      LS.set('host', host); LS.set('auth', r.auth); LS.set('email', S.email);
      return r;
    } catch (e) { lastErr = e; if (e.code !== 2000 && e.code !== 1000) throw e; }
  }
  throw lastErr;
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
    const sAlb = Math.max(overlap(cAlb, me.album), overlap(cArt + ' ' + cAlb, me.artist + ' ' + me.album));
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

/* 棚ぜんぶを一巡する。止めても続きから。費用は 0 円。 */
async function sweepCovers(onlyMissing = true) {
  if (S.sweep) { S.sweep.stop = true; return; }
  const targets = S.albums.filter(a => !(onlyMissing && (S.covers[a.id] || a.folderCover)));
  if (!targets.length) { toast('付いていないジャケットはありません'); return; }
  S.sweep = { done: 0, total: targets.length, hit: 0, iffy: 0, stop: false };
  renderRoute();
  for (const al of targets) {
    if (S.sweep.stop) break;
    const q = albumQuery(al);
    try {
      const cands = await findCandidates(q, al);
      if (cands.length) {
        const top = cands[0];
        S.covers[al.id] = { url: top.url, src: top.src, q, cands, manual: false,
                            score: top.score, sure: top.score >= SURE };
        if (top.score >= SURE) S.sweep.hit++; else S.sweep.iffy++;
        saveCovers();
      }
    } catch (e) { /* 1枚の失敗で全体を止めない */ }
    S.sweep.done++;
    updateSweepBar();
  }
  const r = S.sweep; S.sweep = null;
  saveCovers();
  toast((r.stop ? '中断：' : '') + `${r.hit} / ${r.total} 枚確定、${r.iffy} 枚は要確認`, 3600);
  renderRoute();
}
function updateSweepBar() {
  const s = S.sweep; if (!s) return;
  const bar = $('#swbar'), txt = $('#swtxt');
  if (bar) bar.style.width = (s.done / s.total * 100) + '%';
  if (txt) txt.textContent = `探しています ${s.done}/${s.total}（確定 ${s.hit}・要確認 ${s.iffy}）`;
}
const coverOf = al => {
  const c = S.covers[al.id];
  if (c) return c.url;
  if (al.folderCover) return thumbUrl(al.folderCover, 400);
  return null;
};

/* ============ 再生 ============ */
const au = $('#au');
const P = { album: null, i: -1, linkCache: new Map() };

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
async function play(album, i) {
  P.album = album; P.i = i;
  const t = album.tracks[i];
  if (!t) return;
  try {
    const hit = await cachedResponse(t.id);
    au.src = hit ? URL.createObjectURL(await hit.blob()) : await fileLink(t.id);
    await au.play();
  } catch (e) {
    toast('再生できません: ' + (e.message || e));
    return;
  }
  paintPlayer();
  setMediaSession();
  if (location.hash.startsWith('#/album/')) renderRoute();
}
const trackTitle = t => t.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');
function paintPlayer() {
  const p = $('#player');
  if (!P.album) { p.classList.add('gone'); return; }
  p.classList.remove('gone');
  const t = P.album.tracks[P.i];
  $('#pti').textContent = trackTitle(t);
  $('#par').textContent = [P.album.artist, P.album.name].filter(Boolean).join(' — ');
  const cv = coverOf(P.album);
  $('#pcov').src = cv || '';
  $('#pcov').style.visibility = cv ? 'visible' : 'hidden';
  $('#play').textContent = au.paused ? '▶' : '⏸';
}
function setMediaSession() {
  if (!('mediaSession' in navigator) || !P.album) return;
  const t = P.album.tracks[P.i], cv = coverOf(P.album);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: trackTitle(t),
    artist: P.album.artist || '',
    album: P.album.name,
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
function nextTrack() { if (P.album && P.i + 1 < P.album.tracks.length) play(P.album, P.i + 1); }
function prevTrack() {
  if (!P.album) return;
  if (au.currentTime > 3) { au.currentTime = 0; return; }
  if (P.i > 0) play(P.album, P.i - 1);
}
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

/* ============ オフライン保存 ============ */
/* 直リンクが CORS を返さない場合に備え、api 経由の読み出しに落ちる道を用意する。 */
async function fetchTrackBytes(fileid) {
  try {
    const r = await fetch(await fileLink(fileid));
    if (r.ok) return r;
  } catch (e) { /* CORS で読めない → API 経由へ */ }
  const fd = (await api('file_open', { fileid, flags: 0 })).fd;
  try {
    const chunks = [];
    for (;;) {
      const u = new URL('https://' + S.host + '/file_read');
      u.searchParams.set('auth', S.auth); u.searchParams.set('fd', fd);
      u.searchParams.set('count', 4 * 1024 * 1024);
      const rr = await fetch(u);
      const buf = await rr.arrayBuffer();
      if (!buf.byteLength) break;
      chunks.push(buf);
      if (buf.byteLength < 4 * 1024 * 1024) break;
    }
    return new Response(new Blob(chunks, { type: 'audio/mpeg' }));
  } finally { try { await api('file_close', { fd }); } catch (e) {} }
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
      const res = await fetchTrackBytes(t.id);
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
  const body = JSON.stringify({ v: 1, rootId: S.rootId, covers: S.covers, at: new Date().toISOString() });
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
  if (j && j.covers) { S.covers = Object.assign({}, j.covers, S.covers); saveCovers(); return true; }
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
      <div class="note">パスワードはこの端末の中でだけ使われ、保存されません。
      pCloud へ送られるのは、パスワードそのものではなく毎回変わる符丁です。
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
  /* 手直しの入口。全部を見返すのではなく、怪しいものだけ見る。 */
  const F = {
    all:  () => true,
    iffy: al => { const c = S.covers[al.id]; return c && !c.manual && c.sure === false; },
    none: al => !coverOf(al),
    off:  al => albumOffline(al),
  };
  const counts = { all: S.albums.length, iffy: S.albums.filter(F.iffy).length,
                   none: S.albums.filter(F.none).length, off: S.albums.filter(F.off).length };
  const labels = { all: 'すべて', iffy: '要確認', none: 'ジャケット無し', off: '端末' };
  const shown = S.albums.filter(F[S.filter] || F.all);
  const chips = `<div style="display:flex;gap:7px;overflow-x:auto;margin-bottom:13px;padding-bottom:2px">` +
    Object.keys(labels).map(k => `<button class="hbtn ${S.filter === k ? 'on' : ''}" data-f="${k}">${labels[k]} ${counts[k]}</button>`).join('') +
    `</div>`;
  main().innerHTML = sw + chips + `<div class="grid">${shown.map(al => {
    const cv = coverOf(al), c = S.covers[al.id];
    const badge = c && !c.manual && c.sure === false ? '<span class="badge auto">要確認</span>'
                : albumOffline(al) ? '<span class="badge off">端末</span>' : '';
    return `<button class="al" data-id="${al.id}">
      <div class="cov">${cv ? `<img loading="lazy" src="${esc(cv)}" onerror="this.style.display='none'">`
                            : '<span class="ph">♪</span>'}${badge}</div>
      <div class="t">${esc(al.name)}</div>
      <div class="a">${esc(al.artist)} · ${al.tracks.length}曲</div>
    </button>`;
  }).join('')}</div>` + (shown.length ? '' :
    `<div class="empty">${S.albums.length ? 'この条件に当てはまるものはありません' : '音楽ファイルが見つかりません'}</div>`);
  main().querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filter = b.dataset.f; LS.set('filter', S.filter); screenLib(); });
  updateSweepBar();
  const stop = $('#swstop'); if (stop) stop.onclick = () => { S.sweep.stop = true; toast('止めます'); };
  main().querySelectorAll('.al').forEach(b => b.onclick = () => go('#/album/' + b.dataset.id));
}

function screenAlbum(id) {
  const al = S.albums.find(a => String(a.id) === String(id));
  if (!al) { go('#/lib'); return; }
  $('#hdr').classList.remove('hide'); $('#back').classList.remove('hide');
  $('#title').textContent = al.name;
  $('#btnCovers').classList.add('hide');
  const cv = coverOf(al);
  main().innerHTML = `
    <div class="albumhead">
      <div class="cov">${cv ? `<img src="${esc(cv)}">` : '<span class="ph">♪</span>'}</div>
      <div class="meta">
        <h2>${esc(al.name)}</h2>
        <div class="a">${esc(al.artist)}</div>
        <div class="a">${al.tracks.length} 曲</div>
        <div class="acts">
          <button class="hbtn" id="pall">▶ 通して聴く</button>
          <button class="hbtn" id="cov">ジャケット</button>
          <button class="hbtn" id="dl">${albumOffline(al) ? '端末から消す' : '端末に入れる'}</button>
        </div>
      </div>
    </div>
    <div>${al.tracks.map((t, i) => `
      <button class="tk ${P.album && P.album.id === al.id && P.i === i ? 'playing' : ''} ${S.offline[t.id] ? 'cached' : ''}" data-i="${i}">
        <span class="n">${i + 1}</span><span class="nm">${esc(trackTitle(t))}</span>
        <span class="d">${t.size ? Math.round(t.size / 1048576) + 'MB' : ''}</span>
      </button>`).join('')}</div>`;
  main().querySelectorAll('.tk').forEach(b => b.onclick = () => play(al, +b.dataset.i));
  $('#pall').onclick = () => play(al, 0);
  $('#cov').onclick  = () => go('#/cover/' + al.id);
  $('#dl').onclick   = e => (albumOffline(al) ? removeAlbum(al) : downloadAlbum(al, e.currentTarget));
  $('#back').onclick = () => go('#/lib');
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
  if (!S.rootId) return screenPick(0);
  return screenLib();
}
$('#btnMenu').onclick   = () => go('#/menu');
$('#btnCovers').onclick = () => sweepCovers(true);

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
  L.push('版: v6');
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
renderRoute();
paintPlayer();
