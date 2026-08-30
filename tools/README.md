# 集める道具

`/private/tmp` の作業場は**アプリを再起動すると消える**（2026-08-30 に一度失った）。
道具はここに置き、走らせるときも `work/` を作業場にする。

## mood.py — 曲ごとの雰囲気

MusicBrainz でアルバムの曲を突き止め、AcousticBrainz の判定を拾う。
どちらも鍵は要らない。MusicBrainz は **1秒に1回** の約束があるので遅い
（1500枚で4〜5時間）。途中で止めても、印の付いていないものから続く。

    cd work && python3 ../tools/mood.py

- `albums.json` … 棚の一覧（path / name / artist）。同梱の `ジャケット.json` からも組める
- `雰囲気.json` … 出来上がり。アプリに同梱するのはこれ
- `mood-state.json` … 進み具合

**外れの印が付いたものは二度と当てにいかない。** 当て方を直したら、
`ok:false` の印を消してから走らせる（そうしないと全部飛ばして終わる）。

    python3 -c "import json;d=json.load(open('雰囲気.json'));\
    [v.pop('ok',None) or v.pop('tracks',None) for v in d['byPath'].values() if v.get('ok') is False];\
    json.dump(d,open('雰囲気.json','w'),ensure_ascii=False)"
