'use strict';
/* pcloud.js — 棚ものの共通部品（ブラウザ用）。
 *
 * 正本はここ（~/claude code/shelf-core/pcloud.js）だけ。
 * 各アプリへは tools/sync-core.sh で配る。アプリ側で直さないこと。
 *
 * ここに入れるもの: pCloud への入り方・取り方、時間切れの決着、押した控え、NFC。
 * ここに入れないもの: 画面、並べ方、その棚に固有の決まりごと。
 *
 * 実測で分かっていること（作り直すときに踏み直さないため）
 *  - 合鍵（auth）の渡し方は一通りではない。「認証は通って userinfo が丸ごと返るのに
 *    auth だけ無い」状態が実在する。順に4通り試して、通ったもので入る。
 *  - この環境では AbortController が fetch を切らない。時計と競争させて必ず決着させる。
 *  - getfilelink はウェブアプリから弾かれる（7010: 参照元が pcloud.com に限られる）。
 *    中身を受け取るには中継所（Cloudflare Worker）を通す。
 *  - パスを文字列で組むと macOS の NFD と NFC の食い違いを踏む。folderid / fileid を鍵にする。
 *  - 地域が2つある（api / eapi）。誤った側は result 2000 を返す。
 */
(function (root) {

const HOSTS = ['api.pcloud.com', 'eapi.pcloud.com'];

/* macOS は NFD、プログラム側は NFC。名前で突き合わせるときは必ずここを通す。 */
const nfc = s => (s || '').normalize('NFC');

class PCloudError extends Error {
  constructor(code, msg) { super(msg || ('pCloud error ' + code)); this.code = code; }
}

async function sha1hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* 名前を分けた保存領域。アプリごとに接頭辞を変えて使う。 */
function store(prefix) {
  const k = n => prefix + '.' + n;
  return {
    get(n, d) { try { const v = localStorage.getItem(k(n)); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(n, v) { try { localStorage.setItem(k(n), JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(n)    { try { localStorage.removeItem(k(n)); } catch (e) {} },
  };
}

/* 押した事実の控え。画面が組み直されても残るので、後から読み返せる。
   相手の画面を見られない場所の不具合は、これが無いと往復が何度も要る。
   中身（メール・パスワード）は絶対に残さない。長さだけ。 */
function logger(ls, keep = 20) {
  return {
    note(what) {
      try {
        const a = ls.get('log', []);
        a.push(new Date().toLocaleTimeString('ja-JP') + ' ' + what);
        ls.set('log', a.slice(-keep));
      } catch (e) {}
    },
    read()  { return ls.get('log', []).join('\n') || '（記録なし）'; },
    clear() { ls.del('log'); },
  };
}

/* pCloud を1件呼ぶ。
   返事が来ないまま黙って待ち続けると、画面が固まったようにしか見えない。必ず時間を切る。
   abort が握り潰される環境があるので、中断要求とは別に時計と競争させて決着をつける。 */
async function api(method, params = {}, opt = {}) {
  const host = opt.host || HOSTS[0];
  const ms = opt.ms || 25000;
  const u = new URL('https://' + host + '/' + method);
  if (opt.auth && !('username' in params)) u.searchParams.set('auth', opt.auth);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);

  const ac = new AbortController();
  let timer;
  const clock = new Promise((_, rej) => {
    timer = setTimeout(() => {
      try { ac.abort(); } catch (e) {}
      rej(new PCloudError(-3, 'pCloud からの返事がありません（' + Math.round(ms / 1000) + '秒待ちました）'));
    }, ms);
  });
  let r;
  try {
    r = await Promise.race([
      fetch(u, { cache: 'no-store', signal: ac.signal, referrerPolicy: 'no-referrer' }), clock]);
  } catch (e) {
    if (e instanceof PCloudError) throw e;
    throw new PCloudError(-4, 'pCloud につながりません（通信が遮られている可能性）');
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new PCloudError(-1, 'HTTP ' + r.status);
  const j = await r.json();
  if (j.result !== 0) throw new PCloudError(j.result, j.error);
  return j;
}

/* 合鍵をもらう。順に試して、通ったもので入る。
   say() には進み具合が渡る。画面にそのまま出すこと（無言で待たせない）。
   3・4 はパスワードそのものを（暗号化した通信で）送る。画面でそう明言すること。
   返り値は { host, auth, email }。auth が無ければ必ず投げる（成功したことにして進まない）。 */
async function login(email, password, say = () => {}, log = { note() {} }) {
  if (!(window.crypto && crypto.subtle)) {
    throw new PCloudError(-5, 'この開き方では暗号が使えません。https:// で開いてください');
  }
  let lastErr = null, gotInfo = false;
  for (const host of HOSTS) {
    let dg;
    try { say(host + ' に問い合わせています…'); dg = await api('getdigest', {}, { host }); }
    catch (e) { lastErr = e; log.note('符丁がもらえない @ ' + host + ' code=' + e.code); continue; }
    const pd = await sha1hex(password + (await sha1hex(email.toLowerCase())) + dg.digest);
    const tries = [
      ['userinfo', { getauth: 1, username: email, digest: dg.digest, passworddigest: pd }, '符丁'],
      ['login',    { getauth: 1, username: email, digest: dg.digest, passworddigest: pd }, '符丁 / login'],
      ['userinfo', { getauth: 1, username: email, password }, '暗号化した通信で直接'],
      ['login',    { getauth: 1, username: email, password }, '暗号化した通信で直接 / login'],
    ];
    let badCreds = false;
    for (const [m, params, label] of tries) {
      try {
        say(label + ' で合鍵をもらっています…');
        const r = await api(m, params, { host });
        if (r.auth) {
          log.note('合鍵が取れた: ' + label + ' @ ' + host);
          return { host, auth: r.auth, email: r.email || email };
        }
        gotInfo = true;
        log.note('合鍵なし: ' + label + ' @ ' + host);
        lastErr = new PCloudError(-6, 'pCloud が合鍵を返しませんでした');
      } catch (e) {
        lastErr = e;
        log.note('駄目: ' + label + ' @ ' + host + ' code=' + e.code);
        /* 2000=資格情報違い、1000=地域違い。以降を試しても同じ。 */
        if (e.code === 2000 || e.code === 1000) { badCreds = true; break; }
      }
    }
    if (!badCreds && gotInfo) break;   /* 認証は通っている。別の地域でも同じ */
  }
  if (gotInfo) throw new PCloudError(-6,
    'pCloud に入れましたが、合鍵をもらえませんでした（試した渡し方すべて）');
  throw lastErr || new PCloudError(-7, 'つながりません');
}

/* ---- 中継所 ----
   pCloud は合鍵で出す getfilelink をウェブアプリから弾く（7010）。
   中身を受け取るにはあいだに一枚はさむ。中継所は fileid を選ばないので、
   棚ものすべてで同じ1台を使い回せる。 */
const relayUrl = (relay, o) =>
  String(relay).replace(/\/+$/, '') + (o.path || '/audio') +
  '?fileid=' + encodeURIComponent(o.fileid) +
  '&host=' + encodeURIComponent(o.host || HOSTS[0]) +
  (o.pub ? '&pub=1' : '') +
  '&auth=' + encodeURIComponent(o.auth);

async function relayAlive(relay) {
  const r = await fetch(String(relay).replace(/\/+$/, '') + '/', { referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return true;
}

/* ---- 棚の走査 ----
   1回の recursive listfolder で丸ごと取る。folderid を鍵にするので NFD/NFC を踏まない。
   返すのは「NFCにした名前 → fileid」。同名が複数あれば後勝ち（棚では起きない前提）。 */
async function indexFolder(folderid, opt = {}) {
  const r = await api('listfolder', { folderid, recursive: 1 },
    { host: opt.host, auth: opt.auth, ms: opt.ms || 60000 });
  const map = {};
  let n = 0;
  (function walk(node) {
    for (const c of (node.contents || [])) {
      if (c.isfolder) walk(c);
      else { map[nfc(c.name)] = c.fileid; n++; }
    }
  })(r.metadata);
  return { map, count: n, name: r.metadata.name || '/' };
}

/* ---- 手元に置いた分（Cache Storage）----
   置き場は棚ごとに分ける。鍵は「見かけのURL」にしておくと、後から中身を差し替えても効く。 */
function shelfCache(cacheName, prefix) {
  const key = id => 'https://' + prefix + '/' + id;
  return {
    key,
    async get(id) {
      if (!('caches' in window)) return null;
      try { const c = await caches.open(cacheName); return (await c.match(key(id))) || null; }
      catch (e) { return null; }
    },
    async put(id, blob, headers = {}) {
      if (!('caches' in window)) return false;
      try {
        const c = await caches.open(cacheName);
        await c.put(key(id), new Response(blob, {
          headers: { 'content-type': 'application/octet-stream', ...headers } }));
        return true;
      } catch (e) { return false; }
    },
    async list() {
      const out = {};
      if (!('caches' in window)) return out;
      try {
        const c = await caches.open(cacheName);
        const re = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(.+)$');
        for (const req of await c.keys()) {
          const m = req.url.match(re);
          if (m) out[decodeURIComponent(m[1])] = 1;
        }
      } catch (e) {}
      return out;
    },
    async clear() { if ('caches' in window) { try { await caches.delete(cacheName); } catch (e) {} } },
  };
}

/* 進み具合を出しながら受け取る。無言で待たせない。 */
async function download(url, onProgress = () => {}, expect = 0) {
  const r = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!r.ok) {
    let why = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error) why = j.error + (j.where ? '（' + j.where + '）' : ''); }
    catch (e) {}
    throw new Error(why);
  }
  const len = Number(r.headers.get('content-length')) || expect || 0;
  if (!r.body || !len) return await r.blob();
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, len);
  }
  return new Blob(chunks);
}


/* ---- 棚をいじる ----
   上げるのも消すのも api.pcloud.com へ直に頼める（CORS が開いている）。
   中身を「取る」ときだけ中継所が要る（getfilelink が参照元で弾かれるため）。
   消すのは戻せない。呼ぶ側で必ず確かめること。 */

async function ensureFolder(parentid, name, opt = {}) {
  const j = await api('createfolderifnotexists', { folderid: parentid, name },
                      { host: opt.host, auth: opt.auth });
  return j.metadata.folderid;
}

/* multipart は組み立てを FormData に任せる。名前は NFC に直して渡すこと
   （macOS から拾った File の名前は NFD のことがある）。 */
async function uploadFile(folderid, name, blob, opt = {}) {
  const u = new URL('https://' + (opt.host || HOSTS[0]) + '/uploadfile');
  u.searchParams.set('auth', opt.auth);
  u.searchParams.set('folderid', folderid);
  u.searchParams.set('filename', nfc(name));
  u.searchParams.set('nopartial', 1);
  const fd = new FormData();
  fd.append('file', blob, nfc(name));
  const r = await fetch(u, { method: 'POST', body: fd, referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new PCloudError(-1, 'HTTP ' + r.status);
  const j = await r.json();
  if (j.result !== 0) throw new PCloudError(j.result, j.error);
  return (j.metadata && j.metadata[0] && j.metadata[0].fileid) || null;
}

async function deleteFile(fileid, opt = {}) {
  await api('deletefile', { fileid }, { host: opt.host, auth: opt.auth });
  return true;
}


/* ---- 中継所を使わずに中身を読む ----
   getfilelink はウェブアプリから弾かれる（7010）が、api ホストの file_open / file_read は
   `Access-Control-Allow-Origin: *` を返すので、ブラウザから直接読める（2026-08-30 実測）。
   中継所より遅いが、**中継所が無くても・壁の内側にあっても動く**のが強み。
   大きいものは細切れに読む。file_read は読んだ分だけ位置が進む。 */
async function readFile(fileid, opt = {}) {
  const host = opt.host || HOSTS[0];
  const auth = opt.auth;
  const onProgress = opt.onProgress || (() => {});
  const CH = opt.chunk || 4 * 1024 * 1024;

  const o = await api('file_open', { flags: 0, fileid }, { host, auth });
  const fd = o.fd;
  try {
    const sz = await api('file_size', { fd }, { host, auth });
    const total = sz.size || 0;
    const chunks = [];
    let got = 0;
    while (got < total) {
      const want = Math.min(CH, total - got);
      const u = new URL('https://' + host + '/file_read');
      u.searchParams.set('fd', fd);
      u.searchParams.set('count', want);
      u.searchParams.set('auth', auth);
      const r = await fetch(u, { cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new PCloudError(-1, 'HTTP ' + r.status);
      /* 何か起きると、中身の代わりに JSON の言い訳が返る。黙って混ぜない。 */
      if ((r.headers.get('content-type') || '').includes('json')) {
        const j = await r.json();
        throw new PCloudError(j.result || -9, j.error || '読み出しに失敗しました');
      }
      const b = await r.arrayBuffer();
      if (!b.byteLength) throw new PCloudError(-8, '読み出しが途中で止まりました');
      chunks.push(new Uint8Array(b));
      got += b.byteLength;
      onProgress(got, total);
    }
    return new Blob(chunks);
  } finally {
    try { await api('file_close', { fd }, { host, auth }); } catch (e) {}
  }
}

root.PCloud = {
  VERSION: '1',
  HOSTS, nfc, sha1hex, PCloudError,
  store, logger, api, login,
  relayUrl, relayAlive, indexFolder, shelfCache, download,
  ensureFolder, uploadFile, deleteFile, readFile,
};

})(window);
