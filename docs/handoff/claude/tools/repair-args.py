#!/usr/bin/env python3
"""Args for .git/pc-wf/open-prs.js from PR numbers, read from GitHub so nothing is typed by hand.

    repair-args.py [--limit N] [--mode ci|conflict|review] <pr> [<pr> ...]

ci (default): failing jobs of the PR's latest head, with links. conflict: the conflicting files.
review: base = merge-base with main, head = the PR head. Slug f<pr>, port 5400 + pr % 100.
"""
import json, subprocess, sys

RP = 'TheCruzControll/performance-coach'
argv = sys.argv[1:]
limit, mode = 2, 'ci'
if '--limit' in argv:
    i = argv.index('--limit'); limit = int(argv[i + 1]); del argv[i:i + 2]
if '--mode' in argv:
    i = argv.index('--mode'); mode = argv[i + 1]; del argv[i:i + 2]
gh = lambda *a: subprocess.check_output(['gh', *a], text=True)
items = []
for n in map(int, argv):
    pr = json.loads(gh('pr', 'view', str(n), '-R', RP, '--json', 'headRefName,headRefOid,title'))
    it = {'pr': n, 'branch': pr['headRefName'], 'slug': f'f{n}', 'port': 5400 + n % 100, 'mode': mode,
          'effort': 'xhigh' if any(w in pr['headRefName'] for w in ('auth', 'security', 'backup', 'restore', 'sync')) else 'high'}
    if mode == 'ci':
        checks = json.loads(gh('pr', 'checks', str(n), '-R', RP, '--json', 'name,bucket,link'))
        failing = [c for c in checks if c['bucket'] in ('fail', 'cancel') and c['name'] != 'E2E (iPhone viewport · Chromium + WebKit)']
        it['failing'] = ' ; '.join(f"{c['name']} {c['link']}" for c in failing) or 'no failing check found: read gh pr checks'
        it['failing'] += ' . A Playwright browser server runs outside the sandbox at ws://127.0.0.1:3333/ for local repro.'
    elif mode == 'conflict':
        subprocess.run(['git', '-C', '/Users/nikocruz/dev/performance-coach', 'fetch', '-q', 'origin'], check=True)
        mt = subprocess.run(['git', '-C', '/Users/nikocruz/dev/performance-coach', 'merge-tree', '--write-tree', '--name-only',
                             'origin/main', f"origin/{pr['headRefName']}"], capture_output=True, text=True).stdout.split('\n')
        it['why'] = 'conflicting files: ' + ', '.join(l for l in mt[1:] if l and not l.startswith(('Auto-merging', 'CONFLICT')))
    else:
        it['head'] = pr['headRefOid']
        it['base'] = subprocess.check_output(['git', '-C', '/Users/nikocruz/dev/performance-coach', 'merge-base', 'origin/main', pr['headRefOid']], text=True).strip()
    items.append(it)
print(json.dumps({'limit': limit, 'items': items}))
