#!/usr/bin/env python3
"""Args for dag-cloud.js from one milestone plan (plans/<plan>.json) and GitHub's PR state.

    python3 build-plan-wave.py m4-plan.json M4 m4.json m4s 4900 [--limit 2] [--only id,id] [--max N]

A slice joins the wave when every dependency is merged, dropped (plans/dropped.json), has an open
PR (stacked), or is an earlier slice of the same wave. A slice that names a dropped dependency
gets an `extra` line telling its implementer to skip the dropped feature's part. Slices that already have a PR are skipped. --only is an
allow-list: the wave holds exactly those slices (a listed slice that cannot join is reported).
Output: JSON args for pi's SubagentWorkflow, including scratch, repo and worktrees.
Paths come from $SCRATCH, $REPO and $WORKTREES (defaults below).
"""
import json, os, re, subprocess, sys

HOME = os.path.expanduser('~')
S = os.environ.get('SCRATCH', f'{HOME}/playground/pc-scratch')
REPO = os.environ.get('REPO', f'{HOME}/playground/performance-coach')
WT = os.environ.get('WORKTREES', f'{HOME}/playground/pc-wt')
R = 'repos/TheCruzControll/performance-coach'
plan_file, milestone, brief, slug_prefix, port_base = sys.argv[1:6]
port_base = int(port_base)
opt = lambda name, default=None: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
limit = int(opt('--limit', 2))
only = set(opt('--only', '').split(',')) - {''}
max_items = int(opt('--max', 999))
# Shared with bin/slice-counts.py and the status collector.
DROPPED = json.load(open(f'{S}/plans/dropped.json'))
# Acceptance wording that names on-screen behaviour: such slices get a click-through even when not ui.
ON_SCREEN = re.compile(r'\b(on[- ]screen|screens?|visible|buttons?|taps?|clicks?|banners?|toasts?|dialogs?|sheets?|editor|(?:owner|user) sees)\b', re.I)
# Sol effort xhigh: auth, security, data loss and concurrency slices (migrations count as data loss).
XHIGH_TRACK_WORDS = ('auth', 'security', 'backup', 'restore', 'sync')

# Page by number: gh's --paginate followed Link headers the cloud session's proxy refused.
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

# Every slice id we know, across plans (m2-onboarding-plan.json included), mapped to its branch.
branch_of = {}
for f in sorted(os.listdir(f'{S}/plans')):
    if f.endswith('-plan.json'):
        for s in json.load(open(f'{S}/plans/{f}'))['slices']:
            branch_of.setdefault(s['id'], s['branch'])

id_of = {b: i for i, b in branch_of.items()}

def ext_state(dep):
    if id_of.get(dep, dep) in DROPPED:
        return {'merged': True, 'dropped': True}
    b = branch_of.get(dep, dep)
    p = by_branch.get(b)
    if not p:
        return None
    return {'merged': True} if p['merged'] else {'branch': b, 'pr': p['n']}

plan = json.load(open(f'{S}/plans/{plan_file}'))
# The M2 onboarding plan predates the plan format: no dependsOn, ui, migration or track.
m2_shape = 'dependsOn' not in plan['slices'][0]
if m2_shape:
    print('# plan has no dependsOn: dependencies treated as empty (start only slices whose real deps are merged)', file=sys.stderr)
external, items, chosen, dropped = {}, [], set(), {}
for idx, s in enumerate(plan['slices']):
    if s['id'] in DROPPED:
        if s['id'] in only:
            dropped[s['id']] = 'dropped by the owner (plans/dropped.json)'
        continue
    if s['branch'] in by_branch:
        external[s['id']] = ext_state(s['id'])
        if s['id'] in only:
            dropped[s['id']] = f"already has PR #{by_branch[s['branch']]['n']}"
        continue
    if only and s['id'] not in only:
        continue
    deps = list(s.get('dependsOn') or [])
    blocked = None
    for d in deps:
        if d in chosen:
            continue
        e = ext_state(d)
        if e is None:
            blocked = d
            break
        external[d] = e
    if blocked or len(items) >= max_items:
        dropped[s['id']] = f'dependency {blocked} not started' if blocked else f'--max {max_items} reached'
        continue
    chosen.add(s['id'])
    nn = idx + 1
    track = s.get('track') or ''
    docs = track == 'docs' if track else s['id'].startswith('docs')
    ui = bool(s['ui']) if 'ui' in s else not docs
    migration = bool(s.get('migration'))
    xhigh = migration or track == 'platform' or any(w in track for w in XHIGH_TRACK_WORDS)
    on_screen = sorted({w.lower() for w in ON_SCREEN.findall(' '.join(s.get('acceptance') or []))})
    item = {'id': s['id'], 'kind': 'm2' if m2_shape else 'plan', 'plan': plan_file, 'milestone': milestone, 'brief': brief,
            'branch': s['branch'], 'ui': ui, 'migration': migration,
            'deps': deps, 'slug': f'{slug_prefix}{nn:02d}', 'port': port_base + nn,
            'effort': 'xhigh' if xhigh else 'high',
            'docsOnly': docs and not ui,
            'clickThrough': not (docs and not ui) and (ui or bool(on_screen))}
    if item['clickThrough'] and not ui:
        print(f"# {s['id']}: click-through because its acceptance names {', '.join(on_screen)}", file=sys.stderr)
    gone = {}
    for d in deps:
        drop = DROPPED.get(id_of.get(d, d))
        if drop and drop.get('feature'):
            gone.setdefault((drop['feature'], drop['decided'], drop.get('note', '')), []).append(d)
    if gone:
        item['extra'] = '\n'.join(
            f"OWNER DECISION ({decided}): the owner dropped {feature}, so this slice's {'dependency' if len(ids) == 1 else 'dependencies'} {', '.join(ids)} will never be built. {note} "
            f"Skip any part of this slice's goal or acceptance that is about {feature}'s screen, routes or docs, build the rest, "
            'and say what you skipped in the PR body under "## Owner decisions".'
            for (feature, decided, note), ids in gone.items())
    items.append(item)

for i in sorted(only - {s['id'] for s in plan['slices']}):
    dropped[i] = f'not in {plan_file}'
json.dump({'scratch': S, 'repo': REPO, 'worktrees': WT, 'limit': limit, 'external': external, 'items': items}, sys.stdout, indent=1)
print(f'\n# {len(items)} items: {", ".join(i["id"] for i in items)}', file=sys.stderr)
for i, why in dropped.items():
    if not only or i in only:
        print(f'# left out {i}: {why}', file=sys.stderr)
if only - chosen:
    sys.exit(f'allow-listed slices not in the wave: {sorted(only - chosen)}')
