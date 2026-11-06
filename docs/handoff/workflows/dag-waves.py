#!/usr/bin/env python3
"""Split build-dag-args.py's graph into waves for dag-cloud.js (one Workflow run per wave).

    SCRATCH=<scratch> REPO=<repo> python3 build-dag-args.py --limit 2 > <scratch>/dag-args.json
    python3 dag-waves.py <scratch>/dag-args.json <scratch>

A Workflow runs at most min(16, CPUs - 2) agents at once, so on a 4-CPU container two waves
side by side double the throughput. Wave A: the M1 fixes and the M2 slices. Wave B: the M3
slices that do not (transitively) wait on an M2 slice still without a PR. The rest wait for a
later run of build-dag-args.py, once their M2 dependencies have PRs (they then become external
dependencies). Branches already pushed without a PR get a priority boost so they finish first.
"""
import json, sys

args_file, scratch = sys.argv[1], sys.argv[2]
d = json.load(open(args_file))
items = {i['id']: i for i in d['items']}
m2ids = {i['id'] for i in d['items'] if i['kind'] == 'm2'}
memo = {}


def waits(i):
    if i in memo:
        return memo[i]
    memo[i] = False
    it = items.get(i)
    if not it:
        return False
    memo[i] = any((dep in m2ids) or waits(dep) for dep in it['deps'])
    return memo[i]


pushed = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else set()
A, B, later = [], [], []
for it in d['items']:
    if it['branch'] in pushed:
        it['boost'] = 1000
    if it['kind'] in ('task', 'm2'):
        A.append(it)
    elif waits(it['id']):
        later.append(it['id'])
    else:
        B.append(it)
for name, wave in (('A', A), ('B', B)):
    json.dump({'limit': d['limit'], 'external': d['external'], 'items': wave}, open(f'{scratch}/dag-{name}.json', 'w'))
print(f'A {len(A)}  B {len(B)}  later {len(later)}: {", ".join(later)}')
