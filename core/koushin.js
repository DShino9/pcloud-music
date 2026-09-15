'use strict';
/* 棚もの共通 — 画面下の「最新版に更新」。
   正本は shelf-core/koushin.js。各アプリの core/ は配られたもの（アプリ側で直さない）。

   古い版が端末に残って「直したのに画面に出ない」が起きる。押すだけで直せるようにする。

   **普段は版の字だけを薄く出す**（2026-09-15 本人「こんな前面に出さないで」）。
   めったに押さないものなので、ボタンの姿で置きっぱなしにしない。

     普段        道具棚 v8            ← 薄い字。帯も枠も出さない
     1回押す     [ 最新版に更新 ]     ← ここで初めてボタンの姿。4秒で戻る
     もう一度    更新中… → もう最新でした

   押し間違えても中断しないよう確認を1回はさむ決まりは、**この1回目の押しが兼ねる**
   （遊んでいる・聴いている最中のため）。

   使い方（各アプリの app.js から1回だけ呼ぶ）

     Koushin.tsukeru({ ban: 'v7', shirushi: 'portal-', oya: '.shitaobi' });

   | 欄 | 何 |
   |---|---|
   | `ban`      | いまの版。`index.html` の `?v=`・`sw.js` の控え名と揃える（3か所） |
   | `shirushi` | **自分の控えの頭文字。** ここで始まる控えだけを消す（下の地雷） |
   | `oya`      | 差し込む先（要素か CSS の選択子）。省略すると右下に浮く |
   | `ageru`    | 浮かせるときだけ。下から持ち上げる高さ（px）。既にある下の帯を避ける |
   | `na`       | 任意。何の版かを言葉に出す（「音楽棚 v3」） |
   | `sagasu`   | 任意。置き場の index.html から版を探す型（括弧1組で取り出す）。
                  meta を置けない棚（耳読は `const BUILD` が版の正本）で使う |

   返るもの: `{ box, sara, kotoba, osu }`。`sara` はボタン、`osu()` は押されたときの一手。
   **リモコンで動かす棚（壁の盤）は `osu()` を自分の決定キーから呼ぶ**
   （`el.click()` を呼ぶと、盤の click 拾いと往復して止まらなくなる）。

   **新しい版があるかどうかの見方は3つ。** どれかが「ある」と言えば「ある」。
   **棚によって持ち物が違う**（音楽棚は Service Worker をやめている）ので、全部見る。

   1. Service Worker があるなら `registration.update()`（これが確か）
   2. `index.html` を控え無しで取り直し、**中の `<script src>` `<link href>` の並びを
      いま読み込んでいるものと見比べる。** `app.js?v=138` のように版を付けていれば、
      これだけで分かる（**足す物が無い＝上げ忘れようがない**）
   3. 同じく取り直した `<meta name="ban" content="v1">`（または `sagasu` で探した所）
      と見比べる。**版を URL に付けていない棚（壁の盤・耳読）はこれが頼り**

   **版の正本は棚ごとに1か所だけにする。** 二か所に書いて片方を上げ忘れると、
   「新しい版があります」と言い続ける狼少年になる。だから画面側は版を**読むだけ**にする。

   **控えを持たない棚では、読み直す前に JS と CSS を洗い直す。**
   頁の URL に `?t=` を付けても、それは頁だけの話で、`app.js` はブラウザの控えから
   出てくる（GitHub Pages は `max-age=600`）。いま読み込んでいる同じ置き場の
   script と link を `cache:'reload'` で取り直してから読み直す。
   何を洗うかは `performance` が知っているので、**書き並べる表は要らない。**

   **`shirushi` を空にしない・広げない。** GitHub Pages の棚ものは同じ住所に並んでいて
   Cache Storage を共有している。「自分以外を全部消す」をやると、音楽棚のオフライン曲
   （`tracks-v1`）や DroneRadar の控えを、よその棚を開くたびに消すことになる
   （2026-09-14 道具棚で実際に踏んだ。`portal/仕様書.md` §5）。 */

(function (global) {

  const CSS = `
.sc-koushin{display:flex;align-items:center;gap:11px;min-width:0}
.sc-koushin .sc-kotoba{color:var(--usu2,#6b7896);font-size:10.5px;text-align:right;
  letter-spacing:.02em;max-width:46vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-koushin .sc-sara{font:inherit;font-size:12px;line-height:1.4;white-space:nowrap;
  padding:8px 14px;border-radius:999px;letter-spacing:.03em;cursor:pointer;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#dbe4f7;
  transition:background .15s,border-color .15s}
.sc-koushin .sc-sara:hover{border-color:rgba(140,192,255,.4);background:rgba(91,157,255,.10)}
.sc-koushin .sc-sara:active{background:rgba(91,157,255,.18)}
.sc-koushin .sc-sara.sc-pri{background:linear-gradient(180deg,#5b9dff,#3b7fe0);color:#05101f;
  border-color:transparent;font-weight:600;box-shadow:0 4px 14px rgba(59,127,224,.35)}
/* **普段は版の字だけ。** めったに押さないものを前面に出さない（2026-09-15 本人）。
   1回目の押しで初めてボタンの姿になる（押し間違えの守りを兼ねる）。 */
.sc-koushin.sc-shizuka .sc-sara{background:none;border-color:transparent;box-shadow:none;
  font-size:11px;padding:4px 6px;font-weight:400;opacity:.45;letter-spacing:.02em;
  color:var(--usu2,#6b7896)}
.sc-koushin.sc-shizuka .sc-sara:hover,
.sc-koushin.sc-shizuka .sc-sara:focus-visible{opacity:1}
.sc-koushin.sc-shizuka .sc-kotoba:empty{display:none}
/* 差し込む先が無いときは右下に浮かせる。既にある下の帯は ageru で避ける。 */
.sc-koushin.sc-uku{position:fixed;right:12px;z-index:30;
  bottom:calc(env(safe-area-inset-bottom,0px) + 12px + var(--sc-ageru,0px));
  padding:6px 8px 6px 12px;border-radius:999px;
  background:rgba(7,10,18,.86);border:1px solid rgba(255,255,255,.12);
  backdrop-filter:blur(14px);box-shadow:0 6px 20px rgba(3,7,18,.5)}
/* 浮いている時も、普段は帯を出さない（字だけが薄く乗る） */
.sc-koushin.sc-uku.sc-shizuka{background:none;border-color:transparent;
  box-shadow:none;backdrop-filter:none;padding:4px 6px}
.sc-koushin.sc-uku .sc-kotoba{max-width:38vw}
@media (max-width:380px){.sc-koushin.sc-uku .sc-kotoba{display:none}}
`;

  let iresumi = false;
  function cssIreru() {
    if (iresumi || !document.head) return;
    iresumi = true;
    const st = document.createElement('style');
    st.id = 'sc-koushin-css';
    st.textContent = CSS;
    /* 先頭に入れる。アプリ側の見た目が勝つようにするため。 */
    document.head.insertBefore(st, document.head.firstChild);
  }

  /* いま読み込んでいる js と css の並び（同じ置き場のものだけ・版つきの URL のまま）。 */
  function tsumi(doc) {
    const els = doc.querySelectorAll('script[src], link[rel~="stylesheet"][href]');
    const out = [];
    Array.prototype.forEach.call(els, el => {
      const raw = el.getAttribute('src') || el.getAttribute('href');
      if (!raw) return;
      let u;
      try { u = new URL(raw, location.href); } catch (e) { return; }
      if (u.origin !== location.origin) return;
      out.push(u.pathname + u.search);
    });
    return out.join('\n');
  }

  /* 置き場から index.html を取り直して、いまの画面と見比べる。
     返り: true=新しいものがある / false=同じ / null=分からなかった。 */
  async function motoTokurabe(ban, sagasu) {
    try {
      const u = new URL('./', location.href);
      u.searchParams.set('t', Date.now().toString(36));
      const r = await fetch(u.toString(), { cache: 'no-cache' });
      if (!r.ok) return null;
      const t = await r.text();
      const doc = new DOMParser().parseFromString(t, 'text/html');
      const a = tsumi(doc), b = tsumi(document);
      if (a && b && a !== b) return true;
      if (sagasu && ban) {
        const kata = typeof sagasu === 'string' ? new RegExp(sagasu) : sagasu;
        const hit = t.match(kata);
        if (hit) return hit[1] !== ban;
      }
      const m = doc.querySelector('meta[name="ban"]');
      if (m && ban) return m.getAttribute('content') !== ban;
      return (a && b) ? false : null;
    } catch (e) { return null; }
  }

  /* 控えを持たない棚のために、いま読み込んでいる js と css を取り直しておく。
     頁に ?t= を付けても、js はブラウザの控えから出てくるため。 */
  async function arau() {
    if (!global.performance || !performance.getEntriesByType) return;
    const mita = {};
    const urls = [];
    performance.getEntriesByType('resource').forEach(e => {
      if (e.initiatorType !== 'script' && e.initiatorType !== 'link' &&
          e.initiatorType !== 'css') return;
      if (e.name.indexOf(location.origin) !== 0) return;
      if (mita[e.name]) return;
      mita[e.name] = 1; urls.push(e.name);
    });
    await Promise.all(urls.slice(0, 60).map(u =>
      fetch(u, { cache: 'reload' }).catch(() => {})));
  }

  function tsukeru(o) {
    o = o || {};
    const ban = String(o.ban || '');
    const shirushi = String(o.shirushi || '');
    /* 「道具棚 v8」／名前が無ければ「版 v8」 */
    const banji = o.na ? o.na + ' ' + ban : '版 ' + ban;

    if (!shirushi) {
      console.warn('koushin: shirushi（自分の控えの頭文字）が要る。' +
                   '空だと消す相手が決まらないので、控えは消さずに読み直すだけにする。');
    }
    cssIreru();

    const oya = typeof o.oya === 'string' ? document.querySelector(o.oya) : o.oya;
    const box = document.createElement('div');
    box.className = 'sc-koushin' + (oya ? '' : ' sc-uku');
    if (!oya && o.ageru) box.style.setProperty('--sc-ageru', (+o.ageru || 0) + 'px');
    box.innerHTML = '<span class="sc-kotoba"></span>' +
                    '<button type="button" class="sc-sara">最新版に更新</button>';
    (oya || document.body).appendChild(box);

    const kotobaEl = box.querySelector('.sc-kotoba');
    const sara = box.querySelector('.sc-sara');
    const kotoba = t => { kotobaEl.textContent = t; };

    /* **普段は版の字だけを薄く出す。** めったに押さないものなので前面に出さない
       （2026-09-15 本人「こんな前面に出さないで」）。
       1回目の押しで「最新版に更新」の姿になり、そこで初めてボタンらしくなる。
       確認を1回はさむ決まり（#1）は、この1回目の押しがそのまま兼ねる。 */
    let kakunin = null;
    const shizuka = () => {
      kakunin = null;
      box.classList.add('sc-shizuka');
      sara.classList.remove('sc-pri');
      sara.textContent = banji;
      sara.title = '押すと、新しい版があるか見て読み直します';
      kotoba('');
    };
    const okosu = () => {
      box.classList.remove('sc-shizuka');
      sara.classList.add('sc-pri');
      sara.textContent = '最新版に更新';
    };

    /* 押されたときの一手。リモコンの決定から呼べるよう、外にも返す（壁の盤が使う）。 */
    const osu = async () => {
      if (!kakunin) {
        okosu();
        kotoba('押すと読み直します');
        kakunin = setTimeout(shizuka, 4000);
        return;
      }
      clearTimeout(kakunin); kakunin = null;
      box.classList.remove('sc-shizuka');
      sara.textContent = '更新中…';
      kotoba('調べています…');

      let atarashii = false;
      try {
        const reg = navigator.serviceWorker
          ? await navigator.serviceWorker.getRegistration() : null;
        if (reg) {
          await reg.update();
          atarashii = !!(reg.waiting || reg.installing);
          if (reg.waiting) reg.waiting.postMessage('すぐ入れ替わって');
        }
        /* Service Worker が無い棚（音楽棚・壁の盤）もあるので、置き場とも見比べる。 */
        if (!atarashii) {
          const kekka = await motoTokurabe(ban, o.sagasu);
          if (kekka === true) atarashii = true;
        }
        if (global.caches && shirushi) {
          const ks = await caches.keys();
          await Promise.all(ks.filter(k => k.indexOf(shirushi) === 0).map(k => caches.delete(k)));
        }
        /* 見張り番がいない棚は、ブラウザの控えを自分で洗ってから読み直す。 */
        if (!reg) await arau();
      } catch (e) { /* 控えが使えない端末でも読み直しはする */ }

      const u = new URL(location.href);
      u.searchParams.set('sara', atarashii ? 'atarashii' : 'onaji');
      u.searchParams.set('t', Date.now().toString(36));
      location.replace(u.toString());
    };
    sara.addEventListener('click', osu);

    /* 読み直した後に、何が起きたかを知らせる。**言づては少しの間だけ。**
       押した直後以外は、版の字だけの静かな姿に戻る。 */
    shizuka();
    const q = new URLSearchParams(location.search).get('sara');
    if (q === 'atarashii')  kotoba('新しい版に入れ替えました');
    else if (q === 'onaji') kotoba('もう最新でした');
    if (q) setTimeout(() => kotoba(''), 6000);

    return { box, sara, kotoba, osu };
  }

  global.Koushin = { tsukeru };

})(typeof window !== 'undefined' ? window : globalThis);
