import json, subprocess, glob
S='/Users/franciscruz/playground/pc-scratch'
R='repos/TheCruzControll/performance-coach'
def gh(p):
    o=subprocess.run(f"gh api '{p}'",shell=True,capture_output=True,text=True,timeout=90).stdout
    return json.loads(o) if o.strip() else []
prs=[];page=1
while True:
    b=gh(f'{R}/pulls?state=all&per_page=100&page={page}'); prs+=b
    if len(b)<100: break
    page+=1
by={}
for p in sorted(prs,key=lambda p:p['number']):
    if p['state']=='closed' and not p.get('merged_at'): continue
    by[p['head']['ref']]=p
m2=json.loads(subprocess.run("git -C /Users/franciscruz/playground/performance-coach show origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json",shell=True,capture_output=True,text=True).stdout)['slices']
# Dropped slices (shared with build-plan-wave.py and the status collector) stay in plans but count nowhere.
DROPPED=json.load(open(f'{S}/plans/dropped.json'))
plans={'M2':m2}
for m in ['m2x','m3','m4','m5','m6','m7','m9']:
    plans[m.upper()]=json.load(open(f'{S}/plans/{m}-plan.json'))['slices']
out={}
for m,all_sl in plans.items():
    sl=[s for s in all_sl if s['id'] not in DROPPED]
    merged=[s for s in sl if by.get(s['branch'],{}).get('merged_at')]
    openp=[(s['id'],by[s['branch']]['number']) for s in sl if s['branch'] in by and not by[s['branch']].get('merged_at')]
    rest=[s['id'] for s in sl if s['branch'] not in by]
    out[m]={'total':len(sl),'merged':len(merged),'open':openp,'notStarted':len(rest),'next':rest[:8],'dropped':len(all_sl)-len(sl)}
    print(f"{m}: {len(merged)}/{len(sl)} merged, open {openp}, not started {len(rest)}"+(f", dropped {len(all_sl)-len(sl)}" if len(all_sl)>len(sl) else ''))
print(f"all: {sum(o['merged'] for o in out.values())} of {sum(o['total'] for o in out.values())} slices merged ({sum(o['dropped'] for o in out.values())} dropped)")
json.dump(out,open(f'{S}/counts.json','w'),indent=1)
print('merged PRs total', sum(1 for p in prs if p.get('merged_at')), 'open', [p['number'] for p in prs if p['state']=='open'])

# Ready slices: not started, every dependency merged (or in an open PR: "stackable").
state={}
for m,sl in plans.items():
    for s in sl:
        p=by.get(s['branch'])
        state[s['id']]='dropped' if s['id'] in DROPPED else 'merged' if p and p.get('merged_at') else ('open' if p else 'todo')
ready={}
for m,sl in plans.items():
    r=[]
    for s in sl:
        if state[s['id']]!='todo': continue
        deps=s.get('dependsOn') or []
        unknown=[d for d in deps if d not in state]
        if all(state.get(d) in ('merged','dropped') for d in deps if d in state):
            r.append(s['id']+(' (unknown deps: '+','.join(unknown)+')' if unknown else ''))
    ready[m]=r
    print(m,'ready now:',len(r),r[:10])
