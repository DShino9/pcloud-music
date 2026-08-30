# -*- coding: utf-8 -*-
"""曲ごとの雰囲気を集める。
   MusicBrainz でアルバムの曲を特定し、AcousticBrainz の判定を拾う。
   どちらも鍵不要・無料。MB は 1秒1回の約束を守る。途中で止めても続きから。
   （作業場が消えたので、同梱の索引から組み直した版）"""
import json, time, re, os, urllib.parse, urllib.request, urllib.error

HERE  = os.path.dirname(os.path.abspath(__file__))
UA    = 'ongakudana/1.0 ( https://github.com/DShino9/pcloud-music )'
GENRE = {'邦楽','洋楽','ジャズ','クラシック','サントラ','オムニバス','その他','K-POP',
         'ヒーリング','インスト','ワールド','未整理','非音楽'}
OUT   = os.path.join(HERE, '雰囲気.json')
STATE = os.path.join(HERE, 'mood-state.json')

def get(url, tries=3):
    for k in range(tries):
        try:
            r = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
            with urllib.request.urlopen(r, timeout=25) as f:
                return json.loads(f.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code in (503, 429): time.sleep(3 + k * 4); continue
            return None
        except Exception:
            time.sleep(2 + k * 2)
    return None

def clean(s):
    s = re.sub(r'[\[［(（【].*?[\]］)）】]', ' ', s or '')
    s = re.sub(r'(?i)\b(disc|cd)\s*\d+', ' ', s)
    s = re.sub(r'★|〜|～', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def norm(s):
    return re.sub(r'[^0-9a-z぀-ヿ一-鿿]+', '', (s or '').lower())

def mbsearch(artist, album):
    q = 'release:"%s"' % album.replace('"', '')
    if artist: q += ' AND artist:"%s"' % artist.replace('"', '')
    j = get('https://musicbrainz.org/ws/2/release?query=%s&fmt=json&limit=8'
            % urllib.parse.quote(q))
    time.sleep(1.1)                                   # 1秒1回の約束
    if not j or not j.get('releases'): return None
    na = norm(album)
    for r in j['releases']:
        if r.get('score', 0) < 68: break
        rn = norm(r.get('title'))
        # 題が違うものは採らない。別のアルバムを当てる事故がこれで消える。
        if not rn or (rn not in na and na not in rn): continue
        return r['id']
    return None

def mbtracks(rid):
    j = get('https://musicbrainz.org/ws/2/release/%s?inc=recordings&fmt=json' % rid)
    time.sleep(1.1)
    out = []
    for med in ((j or {}).get('media') or []):
        for t in med.get('tracks', []):
            rec = t.get('recording') or {}
            if rec.get('id'):
                out.append({'t': t.get('title') or rec.get('title'), 'id': rec['id']})
    return out

KEEP = ['mood_happy','mood_sad','mood_aggressive','mood_relaxed','mood_party',
        'danceability','timbre']
def abfetch(ids):
    """AcousticBrainz は 25件までまとめて聞ける。"""
    out = {}
    for i in range(0, len(ids), 25):
        j = get('https://acousticbrainz.org/api/v1/high-level?recording_ids='
                + ';'.join(ids[i:i+25]))
        time.sleep(0.5)
        if not j: continue
        for mbid, v in j.items():
            try: hl = list(v.values())[0]['highlevel']
            except Exception: continue
            m = {}
            for k in KEEP:
                if k in hl: m[k] = [hl[k]['value'], round(hl[k]['probability'], 3)]
            if m: out[mbid] = m
    return out

def tagify(m):
    """確率を、人が読める札に変える。外しやすい判定は使わない。"""
    tags = []
    def yes(k, want, th=0.6):
        v = m.get(k); return v and v[0] == want and v[1] >= th
    if yes('mood_happy', 'happy'):           tags.append('明るい')
    if yes('mood_sad', 'sad'):               tags.append('切ない')
    if yes('mood_aggressive', 'aggressive'): tags.append('激しい')
    if yes('mood_relaxed', 'relaxed'):       tags.append('穏やか')
    if yes('mood_party', 'party'):           tags.append('賑やか')
    if yes('danceability', 'danceable', 0.7):tags.append('踊れる')
    if yes('timbre', 'bright', 0.7):         tags.append('明るい音')
    if yes('timbre', 'dark', 0.7):           tags.append('暗い音')
    return tags

def main():
    albums = json.load(open(os.path.join(HERE, 'albums.json')))
    res = json.load(open(OUT)) if os.path.exists(OUT) else {'v': 1, 'byPath': {}}
    st  = {'done': 0, 'hit': 0, 'tracks': 0}
    t0 = time.time()
    todo = [a for a in albums if 'ok' not in (res['byPath'].get(a['path']) or {})]
    st['total'] = len(todo)
    for n, al in enumerate(todo):
        path = al['path']
        art  = al.get('artist') or ''
        if art in GENRE: art = ''
        album = clean(al.get('name') or path.split('/')[-1])
        bad = (not album) or album in GENRE or norm(album) == norm(art)
        rid = None
        if not bad:
            rid = mbsearch(clean(art), album)
            if not rid and art: rid = mbsearch('', album)   # 寄せ集めや表記ゆれ
        entry = {'ok': False}
        if rid:
            trs = mbtracks(rid)
            if trs:
                ab = abfetch([t['id'] for t in trs])
                got = [{'t': t['t'], 'k': norm(t['t']), 'g': tagify(ab[t['id']])}
                       for t in trs if ab.get(t['id'])]
                got = [g for g in got if g['g']]
                if got:
                    entry = {'ok': True, 'tracks': got}
                    st['hit'] += 1; st['tracks'] += len(got)
        res['byPath'][path] = dict(res['byPath'].get(path) or {}, **entry)
        st['done'] = n + 1; st['sec'] = int(time.time() - t0)
        if n % 5 == 0 or n == len(todo) - 1:
            json.dump(res, open(OUT, 'w'), ensure_ascii=False)
            json.dump(st,  open(STATE, 'w'), ensure_ascii=False)
    json.dump(res, open(OUT, 'w'), ensure_ascii=False)
    json.dump(st,  open(STATE, 'w'), ensure_ascii=False)
    print('done', st)

main()
