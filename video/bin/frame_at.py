import json, sys, bisect, shutil, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ev=json.load(open(f'{ROOT}/work/events.json')); fr=json.load(open(f'{ROOT}/work/frames.json'))
t0=[e for e in ev if e['name']=='rec_start'][0]['t']
ts=[f[1]-t0 for f in fr]
for a in sys.argv[1:]:
    t=float(a); i=max(0,bisect.bisect_right(ts,t)-1)
    dst=f'{ROOT}/work/check_{a}.jpg'; shutil.copy(f'{ROOT}/work/frames/f{fr[i][0]:06d}.jpg',dst); print(dst, i, round(ts[i],2))
