# 音楽棚 — pCloud の音楽をブラウザだけで聴く

pCloud Drive のマウントを**一切使わない**。ファイル一覧も再生もジャケットも、
すべて pCloud の HTTP API 経由なので、マウントが刺さっていても止まらない。
Mac も要らない（GitHub Pages に置いた HTML と iPhone だけで完結する）。

## 仕組み

| やること | 使うもの | 費用 |
|---|---|---|
| ログイン | `getdigest` → `userinfo`（パスワードは端末から出ない） | 0 |
| 棚を組む | `listfolder?recursive=1` を1回。folderid を鍵にする | 0 |
| 再生 | `getfilelink` → 音は pCloud から端末へ直接 | 0 |
| ジャケット | フォルダ内の画像 → iTunes Search API → Deezer | 0 |
| オフライン | Cache Storage に曲の実体を置く | 0 |
| 端末をまたぐ | 索引 `音楽棚.json` を音楽フォルダに置く | 0 |

## ジャケットの方針

**サイトを見て回らない。** Amazon や Google 画像検索をエージェントに巡回させると、
1枚あたり数十秒とトークンを食う上に、いくら指示しても寄り道が止まらない。
代わりに鍵の要らない JSON API を決まった順に叩く。1枚 0.3 秒、費用 0 円、LLM は不使用。

1. アルバムフォルダにある `cover.jpg` / `folder.jpg` など
2. **iTunes Search API**（1200px。邦楽・洋楽ともここで大半が付く）
3. **Deezer**（JSONP。iTunes が外した洋楽）
4. 手で選ぶ（候補から選び、残りは捨てる）

**画像は曲に埋め込まない。** 埋め込むとアルバム10曲を全部書き換えて再アップロードになり、
マウント経由の書き戻しという一番危ない道を通ることになる。
選んだ1枚は索引に URL で持ち、必要なら `cover.jpg` としてアルバムフォルダに置く
（他のプレイヤーもこの名前を拾うため）。



## 何が誰に見えるか

**このページを開いただけの人には何も見えない。** 共有リンクの符号も合鍵も、
リポジトリにもHTMLにも入っておらず、使う人のブラウザの中（localStorage）にだけある。
知らない人が開けば空の設定画面が出る。

**符号を知っている人は、その共有リンクのフォルダを開いて落とせる。**
これは pCloud の共有リンクの性質そのもので、アプリの作りとは関係ない。
気になるなら pCloud 側でリンクに**合言葉**を掛ける（`linkpassword` で通す）。
**期限**も付けられる。切れたら作り直して貼り替えるだけ。

**合鍵（ログインで得る auth）は口座まるごとの鍵で、符号よりずっと強い。**
符号だけで棚も再生も足りるので、要らないなら ⋯ →「合鍵を捨てる」で
pCloud 側でも無効化（`logout`）して端末からも消す。

端末の控えに残る記録には、合鍵も符号も入れない（長さと番号だけ）。

## 中継所を置く（音を鳴らすのに必要）

**pCloud は、ブラウザから直接だと音のリンクを出しません。** `getfilelink` /
`getaudiolink` / `getvideolink` はいずれも `7010 Invalid link referer` を返す。
参照元を消しても断られるので、ブラウザが必ず送る `Origin` を見ている。
つまり **pcloud.com 以外に置いたページからは原理的に取れない**（pCloud 公式も明記）。
`file_open` は未ログインでも `2003` を返すので、こちらも使えない。

サーバーから呼べば `Origin` も `Referer` も付かないので普通に通る。
そのための中継所が `worker.js`。

1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World → Deploy
2. Edit code を開き、中身を全部消して `worker.js` を貼る → Deploy
3. 出てきた `…workers.dev` の URL を、アプリの ⋯ → 中継所 に入れる

無料枠で足りる。中継所は pCloud の合鍵を受け取るが、記録は残さない。
`host` は `api.pcloud.com` / `eapi.pcloud.com` 以外を弾くので、
他人に勝手な中継として使われることはない。

| 経路 | 状況 |
|---|---|
| `checksumfile` / `stat` / `listfolder` | ○ ブラウザから直接通る |
| `getfilelink` ほかリンク発行 | × 7010（Origin で弾かれる） |
| `file_open` / `file_read` | × 2003（HTTP API では使えない） |
| 中継所経由 | ○ 頭出しも解析も通る |

## 手元で動かす

    python3 -m http.server 8788

http://127.0.0.1:8788 を開く。Service Worker と暗号 API は localhost でも動く。
