#!/usr/bin/env python3
"""Build the args for dag-main.js from the plans and GitHub's current PR state.

    python3 build-dag-args.py [--limit 7] > dag-args.json

Every slice whose branch already has a PR becomes an EXTERNAL dependency (merged, or open with
its PR number); the rest become graph items. Slugs and ports match earlier runs so stopped
slices resume in their existing worktrees.
"""
import json, subprocess, sys

import os
S = os.environ.get('SCRATCH', '<SCRATCH>')
R = 'repos/TheCruzControll/performance-coach'
limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 7

prs = json.loads(subprocess.check_output(
    ['gh', 'api', '--paginate', f'{R}/pulls?state=all&per_page=100', '--jq', '[.[] | {n: .number, ref: .head.ref, merged: (.merged_at != null), state}]'],
    text=True).replace('][', ','))
by_branch = {}
for p in sorted(prs, key=lambda p: p['n']):  # the newest PR for a branch wins
    if p['state'] == 'closed' and not p['merged']:
        continue
    by_branch[p['ref']] = p

def ext_for(branch):
    p = by_branch.get(branch)
    if not p:
        return None
    return {'merged': True} if p['merged'] else {'branch': branch, 'pr': p['n']}

external, items = {}, []

# ---- M3 (50 slices). Run 1's 32 slices keep slugs m3sNN / ports 4700+i. ----
plan = json.load(open(f'{S}/plans/m3-plan.json'))
run1 = ['training-vocabulary', 'train-headroom', 'program-plan-contract', 'training-metrics', 'exercise-catalogue-lower', 'exercise-catalogue-upper', 'program-versions-db', 'describe-prescriptions', 'concurrency-rules', 'programming-inputs', 'exercise-library-db', 'exercise-eligibility', 'programming-blocks', 'prescriptions-db', 'exercise-library-service', 'program-ui-kit', 'programming-strength', 'programming-running', 'training-log-db', 'program-store', 'programming-loads', 'programming-volume', 'programming-placement', 'coaching-memory-db', 'program-reads', 'history-queries', 'programming-scenarios', 'program-versioning', 'log-workouts-sets', 'db-explain', 'edit-move-skip', 'log-runs-other-recovery']
run1_order = [s['id'] for s in plan['slices'] if s['id'] in run1]
M2_BRANCH_TO_ID = {
    'm2/13-budget-accounting': 'budget-accounting', 'm2/14-e2e-hydration-wait': 'e2e-hydration-wait',
    'm2/15-blank-optional-date': 'blank-optional-date', 'm2/17-inputs-text': 'inputs-text',
    'm2/18-inputs-choice': 'inputs-choice', 'm2/19-inputs-toggle-tags': 'inputs-toggle-tags',
}
m2plan = json.loads(subprocess.check_output(['git', '-C', os.environ.get('REPO', '.'), 'show', 'origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json'], text=True))
for s in m2plan['slices']:
    M2_BRANCH_TO_ID[s['branch']] = s['id']

def norm_dep(d):
    if d.startswith('m2/'):
        return M2_BRANCH_TO_ID.get(d, d)
    return d  # M3 ids and fix/* branch names stay as they are

for idx, s in enumerate(plan['slices']):
    deps = [norm_dep(d) for d in s['dependsOn']]
    if s['id'] == 'program-versions-db' and 'fix/m2-body-weight-local-day' not in deps:
        deps.append('fix/m2-body-weight-local-day')
    e = ext_for(s['branch'])
    if e:
        external[s['id']] = e
        continue
    if s['id'] in run1_order:
        i = run1_order.index(s['id']); slug, port = f'm3s{i + 1:02d}', 4700 + i
    else:
        slug, port = f'm3t{idx + 1:02d}', 4800 + idx
    items.append({'id': s['id'], 'kind': 'm3', 'branch': s['branch'], 'ui': bool(s['ui']), 'migration': bool(s['migration']), 'deps': deps, 'slug': slug, 'port': port, 'effort': 'xhigh' if s['migration'] else 'high', 'docsOnly': s['track'] == 'docs' and not s['ui'] and s['id'].startswith('docs')})

# ---- M2 onboarding plan: Profile editing, onboarding, Today, docs. ----
M2_DEPS = {
    'profile-equipment': ['profile-save-path', 'inputs-text', 'inputs-choice', 'inputs-toggle-tags'],
    'goals-event': ['profile-equipment'], 'goals-general': ['goals-event'], 'goal-status': ['goals-general'],
    'goal-order': ['goal-status'], 'goal-drag': ['goal-order'],
    'profile-experience': ['profile-equipment'], 'profile-strength': ['profile-equipment'], 'profile-specifics': ['profile-equipment'],
    'profile-injuries': ['profile-equipment'], 'profile-exercises': ['profile-equipment'], 'profile-schedule': ['profile-equipment'],
    'profile-body': ['profile-equipment'], 'profile-basics': ['profile-equipment'],
    'onboarding-flow': ['goals-general', 'profile-experience', 'profile-strength', 'profile-specifics', 'profile-injuries', 'profile-exercises', 'profile-schedule', 'profile-body', 'profile-basics'],
    'today-setup': ['onboarding-flow'], 'onboarding-save-on-leave': ['onboarding-flow'], 'onboarding-resume': ['onboarding-flow', 'today-setup'],
    'onboarding-review': ['onboarding-flow'], 'today-summary': ['today-setup', 'goals-general'],
    'docs-profile': ['today-summary', 'onboarding-review', 'onboarding-resume', 'onboarding-save-on-leave', 'goal-drag'],
}
for s in m2plan['slices']:
    e = ext_for(s['branch'])
    if e:
        external[s['id']] = e
        continue
    if s['id'] not in M2_DEPS:
        continue  # wave-1 slices still in flight elsewhere, or dropped (required-steps-not-skippable)
    nn = int(s['branch'].split('/')[1][:2])
    items.append({'id': s['id'], 'kind': 'm2', 'branch': s['branch'], 'ui': s['id'] != 'docs-profile', 'migration': False, 'deps': M2_DEPS[s['id']], 'slug': f'm2s{nn}', 'port': 4650 + nn, 'effort': 'high', 'docsOnly': s['id'] == 'docs-profile'})

# ---- Remaining M1 audit fixes (from the m1-fixes workflow). ----
m1 = json.load(open(f'{S}/workflows/m1-items.json'))
for it in m1:
    e = ext_for(it['branch'])
    if e:
        external[it['id']] = e
        continue
    items.append({**it, 'kind': 'task', 'deps': [], 'migration': False, 'boost': 3})

# ---- External branches the plans name directly. ----
for b in ['fix/m2-recovery-upgrade-revoked', 'fix/m2-section-saves-serialize', 'fix/m2-body-weight-local-day', 'fix/m2-test-routes-build-flag']:
    external[b] = ext_for(b) or {'merged': True}
external.setdefault('budget-accounting', ext_for('m2/13-budget-accounting') or {'merged': True})

missing = sorted({d for it in items for d in it['deps'] if d not in external and d not in {x['id'] for x in items}})
if missing:
    sys.exit(f'unresolved dependencies: {missing}')
json.dump({'limit': limit, 'external': external, 'items': items}, sys.stdout, indent=1)
print(f'\n# {len(items)} items, {len(external)} external', file=sys.stderr)
