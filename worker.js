/* 音楽棚の中継所 — Cloudflare Workers に置く。
 *
 * なぜ要るのか:
 *   pCloud は getfilelink / getaudiolink / getvideolink を、ブラウザが必ず送る
 *   Origin で弾く（7010 Invalid link referer）。pcloud.com 以外に置いたページからは
 *   原理的にリンクを取れない。file_open は HTTP API では使えない（未ログインでも 2003）。
 *   サーバーから呼べば Origin も Referer も付かないので、普通に通る。
 *
 * やること:
 *   /audio?fileid=…&auth=… … pCloud からリンクを取り、中身をそのまま流す（頭出しに対応）
 *   /link ?fileid=…&auth=… … リンクだけ返す
 *   /            … 生きているかの確認
 *
 * 置き方は README の「中継所を置く」を見てください。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
};
const linkCache = new Map();   // fileid → {url, exp}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('音楽棚の中継所です', {
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (url.pathname !== '/audio' && url.pathname !== '/link') {
      return new Response('not found', { status: 404, headers: CORS });
    }

    const auth   = url.searchParams.get('auth');
    const fileid = url.searchParams.get('fileid');
    const host   = url.searchParams.get('host') || 'api.pcloud.com';
    if (!auth || !fileid) return json({ error: 'fileid と auth が要ります' }, 400);
    if (!/^e?api\.pcloud\.com$/.test(host)) return json({ error: 'あて先が不正です' }, 400);

    /* リンクは少しの間だけ使い回す。同じ曲を何度も頭出しされたときの往復を減らす。 */
    const key = host + ':' + fileid;
    let hit = linkCache.get(key);
    if (!hit || hit.exp < Date.now()) {
      const api = `https://${host}/getfilelink?forcedownload=0&fileid=${encodeURIComponent(fileid)}&auth=${encodeURIComponent(auth)}`;
      let j;
      try { j = await (await fetch(api)).json(); }
      catch (e) { return json({ error: 'pCloud につながりません' }, 502); }
      if (j.result !== 0) return json({ result: j.result, error: j.error }, 502);
      hit = { url: 'https://' + j.hosts[0] + j.path, exp: Date.now() + 20 * 60 * 1000 };
      linkCache.set(key, hit);
      if (linkCache.size > 300) linkCache.delete(linkCache.keys().next().value);
    }
    if (url.pathname === '/link') return json({ url: hit.url });

    /* 中身を素通しする。頭出し（Range）はそのまま渡さないと、曲の途中に飛べない。 */
    const h = new Headers();
    const range = req.headers.get('Range');
    if (range) h.set('Range', range);
    const up = await fetch(hit.url, { headers: h, redirect: 'follow' });
    const out = new Headers();
    for (const k of ['content-type','content-length','content-range','accept-ranges','last-modified','etag']) {
      const v = up.headers.get(k); if (v) out.set(k, v);
    }
    for (const [k, v] of Object.entries(CORS)) out.set(k, v);
    if (!out.get('accept-ranges')) out.set('accept-ranges', 'bytes');
    return new Response(up.body, { status: up.status, headers: out });
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
}
