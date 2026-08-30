/* 音楽棚の入口。ページを配り、pCloud の符号を預かる。
 *
 * なぜ要るのか:
 *   共有リンクの符号は「持っている人が全部落とせる」鍵。ブラウザに置くと、
 *   端末を触られたら読まれるし、同じ置き場（github.io）の別のページからも読める。
 *   隠しても意味がない。**符号をブラウザに渡さない**のが唯一の守り。
 *
 * やること:
 *   ・合言葉を通った端末にだけ、署名した札（cookie）を配る。札が無ければページも API も 401
 *   ・符号と合言葉は worker の中だけ。端末には一度も降りない
 *   ・音の中身はここを通らない。pCloud から端末へ直接届く（速さは変わらない）
 *
 * 用意するもの（Settings → Variables and Secrets）
 *   PASS           合言葉。長く。                         ← Secret
 *   SIGN_KEY       札の署名に使う長い乱数。               ← Secret
 *   PCLOUD_CODE    音楽フォルダの共有リンクの符号         ← Secret
 *   PCLOUD_LINKPW  共有リンクに掛けた合言葉（無ければ空） ← Secret
 *   PCLOUD_HOST    api.pcloud.com（EUなら eapi.pcloud.com）
 *   APP_BASE       https://dshino9.github.io/pcloud-music
 *
 * 全端末を一度に締め出したいときは SIGN_KEY を変える。
 */

const COOKIE = 'ongaku';
const DAYS = 90;
const FAIL_MAX = 8;               // 合言葉をこの回数外したら
const FAIL_WINDOW = 15 * 60_000;  // この間だけ締め出す
const fails = new Map();          // ip → {n, until}

const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.SIGN_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
/* 早く抜けると当たっている桁数が時間から漏れる。最後まで舐める。 */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const cookieOf = req => Object.fromEntries(
  (req.headers.get('cookie') || '').split(';').map(s => {
    const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1)];
  }).filter(x => x[0]));

async function passOK(req, env) {
  const c = cookieOf(req)[COOKIE];
  if (!c) return false;
  const i = c.lastIndexOf('.');
  if (i < 0) return false;
  const body = c.slice(0, i), sig = c.slice(i + 1);
  if (!same(sig, await sign(env, body))) return false;
  try {
    const j = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return j.exp > Date.now();
  } catch (e) { return false; }
}
async function issue(env, ua) {
  const body = b64u(enc.encode(JSON.stringify({
    id: b64u(crypto.getRandomValues(new Uint8Array(9))),
    exp: Date.now() + DAYS * 864e5,
    ua: (ua || '').slice(0, 40),
  })));
  return body + '.' + (await sign(env, body));
}

const TYPES = { mp3:'audio/mpeg', m4a:'audio/mp4', m4b:'audio/mp4', mp4:'audio/mp4', aac:'audio/aac',
                flac:'audio/flac', wav:'audio/wav', ogg:'audio/ogg', opus:'audio/ogg',
                aif:'audio/aiff', aiff:'audio/aiff', wma:'audio/x-ms-wma' };
function audioType(u) {
  let n = u;
  try { n = decodeURIComponent(new URL(u).pathname); } catch (e) {}
  const i = n.lastIndexOf('.');
  return TYPES[i > 0 ? n.slice(i + 1).toLowerCase() : ''] || 'audio/mpeg';
}

const j = (o, s = 200) => new Response(JSON.stringify(o),
  { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/* ---------- 合言葉の画面 ---------- */
const LOGIN = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>音楽棚</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#101014;color:#ececf1;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif}
 .c{width:min(400px,92vw);padding:26px;background:#17171d;border:1px solid #26262f;border-radius:16px}
 h1{font-size:20px;margin:0 0 4px} p{color:#8b8b99;font-size:13px;margin:0 0 18px}
 input{width:100%;padding:12px;border-radius:10px;background:#0c0c10;border:1px solid #26262f;
  color:#ececf1;font:inherit;box-sizing:border-box}
 button{width:100%;padding:12px;border-radius:10px;background:#6ea8fe;color:#0b0b0f;
  font:inherit;font-weight:600;border:0;margin-top:12px}
 .m{min-height:20px;font-size:13px;color:#e06c75;margin-top:12px}
</style>
<div class="c">
 <h1>音楽棚</h1><p>合言葉を入れてください。この端末は90日おぼえます。</p>
 <input id="p" type="password" autocomplete="current-password" autofocus>
 <button id="b">入る</button><div class="m" id="m"></div>
</div>
<script>
const go=async()=>{const b=document.getElementById('b');b.disabled=true;
 document.getElementById('m').textContent='';
 const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({pass:document.getElementById('p').value})});
 if(r.ok){location.replace('/');return;}
 const t=await r.json().catch(()=>({}));
 document.getElementById('m').textContent=t.error||'合いません';b.disabled=false;};
document.getElementById('b').onclick=go;
document.getElementById('p').onkeydown=e=>{if(e.key==='Enter')go();};
</script>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ip = req.headers.get('cf-connecting-ip') || '?';

    if (url.pathname === '/login' && req.method === 'POST') {
      const f = fails.get(ip);
      if (f && f.until > Date.now() && env.SETUP !== '1') {
        return j({ error: 'しばらく待ってください' }, 429);
      }
      let pass = '';
      try { pass = (await req.json()).pass || ''; } catch (e) {}
      /* 前後の空白は打ち間違いの元。両方から落としてから比べる。 */
      pass = String(pass).trim();
      const want = String(env.PASS || '').trim();
      if (!want) {
        return j({ error: 'PASS が設定されていません（Cloudflare の変数を確認してください）' }, 500);
      }
      if (!same(pass, want)) {
        /* 設置中だけ、食い違いの手がかりを出す。SETUP は済んだら消すこと。 */
        if (env.SETUP === '1') {
          return j({ error: `合いません（打った字 ${pass.length} 文字 / 設定は ${want.length} 文字）` }, 401);
        }
        const n = (f && f.until > Date.now() ? f.n : 0) + 1;
        fails.set(ip, { n, until: n >= FAIL_MAX ? Date.now() + FAIL_WINDOW : 0 });
        await new Promise(r => setTimeout(r, 700));   // 総当たりを遅くする
        return j({ error: '合いません' }, 401);
      }
      fails.delete(ip);
      const tok = await issue(env, req.headers.get('user-agent'));
      return new Response(null, { status: 204, headers: {
        'set-cookie': `${COOKIE}=${tok}; Max-Age=${DAYS * 86400}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        'cache-control': 'no-store' } });
    }
    if (url.pathname === '/logout') {
      return new Response(null, { status: 302, headers: {
        'location': '/', 'set-cookie': `${COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax` } });
    }

    const ok = await passOK(req, env);
    if (!ok) {
      if (url.pathname.startsWith('/api/')) return j({ error: '札がありません' }, 401);
      return new Response(LOGIN, { status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    /* ---------- ここから先は札を持った端末だけ ---------- */
    const host = env.PCLOUD_HOST || 'api.pcloud.com';
    const call = async (method, params = {}) => {
      const q = new URLSearchParams({ ...params, code: env.PCLOUD_CODE });
      if (env.PCLOUD_LINKPW) q.set('linkpassword', env.PCLOUD_LINKPW);
      const r = await fetch(`https://${host}/${method}?${q}`);
      return r.json();
    };

    if (url.pathname === '/api/shelf') {
      const d = await call('showpublink', { recursive: 1 });
      if (d.result !== 0) return j({ error: d.error, result: d.result }, 502);
      return j({ metadata: d.metadata });
    }
    if (url.pathname === '/api/link') {
      const fileid = url.searchParams.get('fileid');
      if (!fileid) return j({ error: 'fileid が要ります' }, 400);
      const d = await call('getpublinkdownload', { fileid, forcedownload: 0 });
      if (d.result !== 0) return j({ error: d.error, result: d.result }, 502);
      return j({ url: 'https://' + d.hosts[0] + d.path });
    }
    /* 音の中身を素通しする。同じ入口から配ると解析器に通せるので、
       ビジュアライザーが全部動く。頭出し（Range）はそのまま渡す。 */
    if (url.pathname === '/api/audio') {
      const fileid = url.searchParams.get('fileid');
      if (!fileid) return j({ error: 'fileid が要ります' }, 400);
      const d = await call('getpublinkdownload', { fileid, forcedownload: 0 });
      if (d.result !== 0) return j({ error: d.error, result: d.result }, 502);
      const h = new Headers();
      const range = req.headers.get('Range');
      if (range) h.set('Range', range);
      h.set('user-agent', 'Mozilla/5.0 (compatible; ongakudana/1.0)');
      /* 配信元は複数返る。順に当たり、駄目ならリンクを取り直してもう一巡。 */
      let up = null, tried = [];
      let hosts = d.hosts || [];
      for (let round = 0; round < 2 && !up; round++) {
        for (const hh of hosts) {
          let r2;
          try { r2 = await fetch('https://' + hh + d.path, { headers: h, redirect: 'follow' }); }
          catch (e) { tried.push(hh.split('.')[0] + ':×'); continue; }
          if (r2.ok || r2.status === 206) { up = r2; break; }
          tried.push(hh.split('.')[0] + ':' + r2.status);
        }
        if (!up && round === 0) {
          const d2 = await call('getpublinkdownload', { fileid, forcedownload: 0 });
          if (d2.result !== 0) break;
          hosts = d2.hosts || []; d.path = d2.path;
        }
      }
      if (!up) {
        /* 入口から取れないなら、端末に直接取りに行かせる。
           リンクが要求元に縛られている場合はこちらで通ることがある。 */
        if (url.searchParams.get('nored') !== '1') {
          return new Response(null, { status: 302, headers: {
            'location': 'https://' + (hosts[0] || d.hosts[0]) + d.path, 'cache-control': 'no-store' } });
        }
        return j({ error: 'pCloud が中身を渡しません', tried }, 502);
      }
      const target = up.url || ('https://' + hosts[0] + d.path);
      const out = new Headers();
      for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = up.headers.get(k); if (v) out.set(k, v);
      }
      out.set('accept-ranges', out.get('accept-ranges') || 'bytes');
      out.set('content-type', audioType(target));
      out.set('cache-control', 'private, max-age=600');
      return new Response(up.body, { status: up.status, headers: out });
    }
    if (url.pathname === '/api/whoami') return j({ ok: true, gate: true });

    /* ---------- ページを配る（中身は GitHub Pages から） ---------- */
    const base = (env.APP_BASE || '').replace(/\/+$/, '');
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const up = await fetch(base + path + url.search, { cf: { cacheTtl: 60 } });
    const h = new Headers(up.headers);
    h.set('cache-control', 'no-store');
    h.delete('content-security-policy');
    return new Response(up.body, { status: up.status, headers: h });
  },
};
