/* 棚ものの中継所 — Cloudflare Workers に置く。正本はここ（shelf-core/relay.js）。
 *
 * なぜ要るのか（2026-08-30 実測）:
 *   pCloud の配信元（ptok2.pcloud.com など）は CORS を返さない。
 *   リンクは getfilelink でも公開リンクの符号でも取れるが、どちらの配信元も
 *   Access-Control-Allow-Origin が無いので、ブラウザの JavaScript は中身を掴めない。
 *   （<audio src> は CORS 無しで鳴らせる。中身をプログラムに渡すときだけ困る）
 *   api ホストの file_open は CORS が開いているが、result 2003 で使えなかった。
 *   → あいだに一枚はさむしかない。それがこれ。
 *
 * fileid を選ばないので、棚もの全部で1台を使い回せる。
 *
 *
 *   /audio?fileid=…&auth=…        中身を流す（頭出しに対応）
 *   /link ?fileid=…&auth=…        リンクだけ返す
 *   …&pub=1 を付けると「公開リンク」経由で取る（要求元に縛られない道）
 *   /                             生きているかの確認
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type',
};
const linkCache = new Map();   // key → {urls:[…], exp}
const pubCache  = new Map();   // fileid → {code, linkid}

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
    const pub    = url.searchParams.get('pub') === '1';
    if (!auth || !fileid) return json({ error: 'fileid と auth が要ります' }, 400);
    if (!/^e?api\.pcloud\.com$/.test(host)) return json({ error: 'あて先が不正です' }, 400);

    const call = async (method, params) => {
      const q = new URLSearchParams({ ...params, auth });
      const r = await fetch(`https://${host}/${method}?${q}`);
      return r.json();
    };

    /* 配信元は複数返ってくる。ひとつ目が駄目でも次がある。 */
    const key = (pub ? 'p:' : 'd:') + host + ':' + fileid;
    const fresh = async () => {
      let j;
      if (pub) {
        let p = pubCache.get(fileid);
        if (!p) {
          const mk = await call('getfilepublink', { fileid });
          if (mk.result !== 0) return { err: mk };
          p = { code: mk.code, linkid: mk.linkid };
          pubCache.set(fileid, p);
        }
        j = await call('getpublinkdownload', { code: p.code });
      } else {
        j = await call('getfilelink', { fileid, forcedownload: 0 });
      }
      if (j.result !== 0) return { err: j };
      return { urls: (j.hosts || []).map(h => 'https://' + h + j.path) };
    };

    let hit = linkCache.get(key);
    if (!hit || hit.exp < Date.now()) {
      const got = await fresh();
      if (got.err) return json({ result: got.err.result, error: got.err.error, where: pub ? '公開リンク' : '直リンク' }, 502);
      hit = { urls: got.urls, exp: Date.now() + 5 * 60 * 1000 };
      linkCache.set(key, hit);
      if (linkCache.size > 300) linkCache.delete(linkCache.keys().next().value);
    }
    if (url.pathname === '/link') return json({ url: hit.urls[0], urls: hit.urls, type: typeOf(hit.urls[0]) });

    const h = new Headers();
    const range = req.headers.get('Range');
    if (range) h.set('Range', range);
    h.set('user-agent', 'Mozilla/5.0 (compatible; ongakudana/1.0)');

    /* 配信元を順に当たり、駄目ならリンクを取り直してもう一巡。 */
    const tried = [];
    for (let round = 0; round < 2; round++) {
      for (const u of hit.urls) {
        let up;
        try { up = await fetch(u, { headers: h, redirect: 'follow' }); }
        catch (e) { tried.push(hostOf(u) + ':つながらない'); continue; }
        if (up.ok || up.status === 206) {
          const out = new Headers();
          for (const k of ['content-length','content-range','accept-ranges','last-modified','etag']) {
            const v = up.headers.get(k); if (v) out.set(k, v);
          }
          for (const [k, v] of Object.entries(CORS)) out.set(k, v);
          if (!out.get('accept-ranges')) out.set('accept-ranges', 'bytes');
          out.set('content-type', typeOf(u));
          return new Response(up.body, { status: up.status, headers: out });
        }
        tried.push(hostOf(u) + ':' + up.status);
      }
      if (round === 0) {
        linkCache.delete(key);
        const got = await fresh();
        if (got.err) break;
        hit = { urls: got.urls, exp: Date.now() + 5 * 60 * 1000 };
        linkCache.set(key, hit);
      }
    }
    return json({ error: 'pCloud が中身を渡しません', tried,
                  where: pub ? '公開リンク' : '直リンク',
                  hint: 'リンクが要求元に縛られている可能性' }, 502);
  },
};

const hostOf = u => { try { return new URL(u).hostname.split('.')[0]; } catch (e) { return '?'; } };
const TYPES = { mp3:'audio/mpeg', m4a:'audio/mp4', m4b:'audio/mp4', mp4:'audio/mp4',
                aac:'audio/aac', flac:'audio/flac', wav:'audio/wav', ogg:'audio/ogg',
                opus:'audio/ogg', aif:'audio/aiff', aiff:'audio/aiff', wma:'audio/x-ms-wma' };
function typeOf(u) {
  let name = u;
  try { name = decodeURIComponent(new URL(u).pathname); } catch (e) {}
  const i = name.lastIndexOf('.');
  const ext = i > 0 ? name.slice(i + 1).toLowerCase() : '';
  return TYPES[ext] || 'audio/mpeg';
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
}
