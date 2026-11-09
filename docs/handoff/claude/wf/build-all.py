#!/usr/bin/env python3
"""Args for dag-claude.js across every milestone plan, from GitHub's PR state.

    python3 build-all.py [--limit 6] [--max N] [--exclude id,id] [--only id,id] [--prs prs.json]

Every non-dropped slice without a PR becomes an item when all of its dependencies are merged,
dropped, have an open PR (stacked), or are items of this wave. Items are taken in critical-path
order (deepest remaining chain first) up to --max, and an item joins only when its dependencies
already joined. UI slices that edit the same screens share a `group` so they run one at a time.
"""
import json, os, re, subprocess, sys

S = os.environ.get('SCRATCH', '/tmp/pc-scratch')
REPO = os.environ.get('REPO', os.path.expanduser('~/dev/performance-coach'))
WT = os.environ.get('WORKTREES', '/tmp/pc-wt')
R = 'repos/TheCruzControll/performance-coach'
opt = lambda name, default=None: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
limit = int(opt('--limit', 6))
max_items = int(opt('--max', 9999))
exclude = set(opt('--exclude', '').split(',')) - {''}
only = set(opt('--only', '').split(',')) - {''}
DROPPED = json.load(open(f'{S}/plans/dropped.json'))
ON_SCREEN = re.compile(r'\b(on[- ]screen|screens?|visible|buttons?|taps?|clicks?|banners?|toasts?|dialogs?|sheets?|editor|(?:owner|user) sees)\b', re.I)
XHIGH_TRACK_WORDS = ('auth', 'security', 'backup', 'restore', 'sync')
PLANS = [('m2x', 'M2X', 'm2x.json', 'x', 4800), ('m4', 'M4', 'm4.json', 'w', 4900), ('m5', 'M5', 'm5.json', 'c', 5000),
         ('m6', 'M6', 'm6.json', 'a', 5100), ('m7', 'M7', 'm7.json', 'p', 5200), ('m9', 'M9', 'm9.json', 'h', 5300)]
SHARED_SCREENS = {'app', 'entry-points', 'ui-train'}  # Today, Train and the app shell


def load_prs():
    if opt('--prs'):
        return json.load(open(opt('--prs')))
    prs, page = [], 1
    while True:
        batch = json.loads(subprocess.check_output(
            ['gh', 'api', f'{R}/pulls?state=all&per_page=100&page={page}', '--jq',
             '[.[] | {n: .number, ref: .head.ref, merged: (.merged_at != null), state}]'], text=True))
        prs += batch
        if len(batch) < 100:
            break
        page += 1
    return prs


by_branch = {}
for p in sorted(load_prs(), key=lambda p: p['n']):
    if p['state'] == 'closed' and not p['merged']:
        continue
    by_branch[p['ref']] = p

slices, meta = {}, {}
for f in sorted(os.listdir(f'{S}/plans')):
    if f.endswith('-plan.json'):
        for s in json.load(open(f'{S}/plans/{f}'))['slices']:
            slices.setdefault(s['id'], s)
for plan, M, brief, prefix, port_base in PLANS:
    for idx, s in enumerate(json.load(open(f'{S}/plans/{plan}-plan.json'))['slices']):
        meta[s['id']] = (plan, M, brief, prefix, port_base, idx + 1)


def state(i):
    if i in DROPPED:
        return 'dropped'
    s = slices.get(i)
    if not s:
        return 'unknown'
    p = by_branch.get(s['branch'])
    return 'merged' if p and p['merged'] else 'open' if p else 'todo'


todo = [i for i in meta if state(i) == 'todo' and i not in exclude and (not only or i in only)]
todo_set = set(todo)
memo = {}


def depth(i):  # longest chain of remaining slices that depend on i
    if i in memo:
        return memo[i]
    memo[i] = 0
    kids = [j for j in todo if i in (slices[j].get('dependsOn') or [])]
    memo[i] = 1 + max(map(depth, kids)) if kids else 0
    return memo[i]


# Topological order, critical path first among the ready.
chosen, items, external, left = [], [], {}, {}
pending = sorted(todo, key=lambda i: -depth(i))
progress = True
while progress and len(items) < max_items:
    progress = False
    for i in list(pending):
        if len(items) >= max_items:
            break
        deps = slices[i].get('dependsOn') or []
        bad = [d for d in deps if state(d) in ('todo', 'unknown') and d not in chosen]
        if bad:
            left[i] = f'waits on {", ".join(bad)}'
            continue
        pending.remove(i)
        left.pop(i, None)
        chosen.append(i)
        progress = True
        for d in deps:
            st = state(d)
            if st in ('merged', 'dropped'):
                external[d] = {'merged': True, **({'dropped': True} if st == 'dropped' else {})}
            elif st == 'open':
                p = by_branch[slices[d]['branch']]
                external[d] = {'branch': slices[d]['branch'], 'pr': p['n']}
        s = slices[i]
        plan, M, brief, prefix, port_base, nn = meta[i]
        track = s.get('track') or ''
        docs = track == 'docs' if track else i.startswith('docs')
        ui = bool(s['ui']) if 'ui' in s else not docs
        migration = bool(s.get('migration'))
        xhigh = migration or track == 'platform' or any(w in track for w in XHIGH_TRACK_WORDS)
        on_screen = bool(ON_SCREEN.findall(' '.join(s.get('acceptance') or [])))
        group = None
        if ui:
            group = 'today-train' if track in SHARED_SCREENS else f'ui-{M}'
        item = {'id': i, 'kind': 'plan', 'plan': f'{plan}-plan.json', 'milestone': M, 'brief': brief,
                'branch': s['branch'], 'ui': ui, 'migration': migration, 'deps': deps,
                'slug': f'{prefix}{nn:02d}', 'port': port_base + nn, 'effort': 'xhigh' if xhigh else 'high',
                'docsOnly': docs and not ui, 'clickThrough': not (docs and not ui) and (ui or on_screen),
                'group': group, 'boost': 0}
        gone = {}
        for d in deps:
            drop = DROPPED.get(d)
            if drop and drop.get('feature'):
                gone.setdefault((drop['feature'], drop['decided'], drop.get('note', '')), []).append(d)
        if gone:
            item['extra'] = '\n'.join(
                f"OWNER DECISION ({decided}): the owner dropped {feature}, so this slice's dependencies {', '.join(ids)} will never be built. {note} "
                f"Skip any part of this slice's goal or acceptance that is about {feature}'s screen, routes or docs, build the rest, "
                'and say what you skipped in the PR body under "## Owner decisions".'
                for (feature, decided, note), ids in gone.items())
        items.append(item)

json.dump({'scratch': S, 'repo': REPO, 'worktrees': WT, 'limit': limit, 'external': external, 'items': items}, sys.stdout, indent=1)
print(f'\n# {len(items)} items; open PR slices: {sorted(i for i in meta if state(i) == "open")}', file=sys.stderr)
for i in pending:
    print(f'# left out {i}: {left.get(i, "--max reached")}', file=sys.stderr)
