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

## 手元で動かす

    python3 -m http.server 8788

http://127.0.0.1:8788 を開く。Service Worker と暗号 API は localhost でも動く。
