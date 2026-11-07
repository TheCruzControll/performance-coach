#!/usr/bin/env python3
"""Args for dag-cloud.js from one milestone plan (plans/<plan>.json) and GitHub's PR state.

    python3 build-plan-wave.py m4-plan.json M4 m4.json m4s 4900 [--limit 2] [--only id,id] [--max N]

A slice joins the wave when every dependency is merged, has an open PR (stacked), or is an
earlier slice of the same wave. Slices that already have a PR are skipped. Output: JSON args.
"""
import json, os, subprocess, sys

S = os.environ.get('SCRATCH')
R = 'repos/TheCruzControll/performance-coach'
plan_file, milestone, brief, slug_prefix, port_base = sys.argv[1:6]
port_base = int(port_base)
opt = lambda name, default=None: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
limit = int(opt('--limit', 2))
only = set(opt('--only', '').split(',')) - {''}
max_items = int(opt('--max', 999))

# Page by number: gh's --paginate follows Link headers that name repositories/<id>/..., which
# the session's GitHub proxy refuses.
prs, page = [], 1
while True:
    batch = json.loads(subprocess.check_output(
        ['gh', 'api', f'{R}/pulls?state=all&per_page=100&page={page}', '--jq',
         '[.[] | {n: .number, ref: .head.ref, merged: (.merged_at != null), state}]'], text=True))
    prs += batch
    if len(batch) < 100:
        break
    page += 1
by_branch = {}
for p in sorted(prs, key=lambda p: p['n']):
    if p['state'] == 'closed' and not p['merged']:
        continue
    by_branch[p['ref']] = p

# Every slice id we know, across plans, mapped to its branch.
branch_of = {}
for f in sorted(os.listdir(f'{S}/plans')):
    if f.endswith('-plan.json'):
        for s in json.load(open(f'{S}/plans/{f}'))['slices']:
            branch_of.setdefault(s['id'], s['branch'])
m2plan = json.loads(subprocess.check_output(
    ['git', '-C', os.environ.get('REPO', '.'), 'show', 'origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json'], text=True))
for s in m2plan['slices']:
    branch_of.setdefault(s['id'], s['branch'])

def ext_state(dep):
    b = branch_of.get(dep, dep)
    p = by_branch.get(b)
    if not p:
        return None
    return {'merged': True} if p['merged'] else {'branch': b, 'pr': p['n']}

plan = json.load(open(f'{S}/plans/{plan_file}'))
external, items, chosen = {}, [], set()
for idx, s in enumerate(plan['slices']):
    if s['branch'] in by_branch:
        e = ext_state(s['id'])
        external[s['id']] = e
        continue
    if only and s['id'] not in only:
        continue
    ok = True
    for d in s['dependsOn']:
        if d in chosen:
            continue
        e = ext_state(d)
        if e is None:
            ok = False
            break
        external[d] = e
    if not ok or len(items) >= max_items:
        continue
    chosen.add(s['id'])
    nn = idx + 1
    items.append({'id': s['id'], 'kind': 'plan', 'plan': plan_file, 'milestone': milestone, 'brief': brief,
                  'branch': s['branch'], 'ui': bool(s['ui']), 'migration': bool(s['migration']),
                  'deps': list(s['dependsOn']), 'slug': f'{slug_prefix}{nn:02d}', 'port': port_base + nn,
                  'effort': 'xhigh' if s['migration'] or s['track'] in ('sync-api', 'platform') else 'high',
                  'docsOnly': s['track'] == 'docs' and not s['ui']})

json.dump({'limit': limit, 'external': external, 'items': items}, sys.stdout, indent=1)
print(f'\n# {len(items)} items: {", ".join(i["id"] for i in items)}', file=sys.stderr)
