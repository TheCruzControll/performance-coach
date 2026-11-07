#!/usr/bin/env python3
"""Collect project status into status.json. Read only: GitHub GETs, local git reads, file reads.

Slice-to-PR matching comes from bin/slice-counts.py (run in-process with runpy, its globals reused).
"""
import contextlib, glob, io, json, os, re, runpy, shutil, subprocess, time
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
S = f'{HOME}/playground/pc-scratch'
REPO = f'{HOME}/playground/performance-coach'
R = 'repos/TheCruzControll/performance-coach'
URL = 'https://github.com/TheCruzControll/performance-coach'
OUT = f'{S}/status/status.json'
TASKS = '/var/folders/15/ssbhttf54p50yzglzc4v13lm0000gn/T/pi-subagents-501/Users-franciscruz-playground-performance-coach/*/tasks'
MILESTONES = ['M2', 'M2X', 'M3', 'M4', 'M5', 'M6', 'M7', 'M9']
HOLDS = {13: 'on hold: never merges (handoff)', 157: 'on hold: waits on the owner'}
OWNER_WAITING = [
    'RESEND_API_KEY (email sign-in link delivery)',
    'BLOB_READ_WRITE_TOKEN (backups to Vercel Blob)',
    'Lighthouse TBT budget decision (#122)',
    'M8 council bar',
]
SOL_RE = re.compile(r'Reviewed with sol-review|Sol verdict: approved', re.I)
DEP_RE = re.compile(r'Depends on #(\d+)', re.I)

_cache = {}


def cached(key, ttl, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def gh(path):
    out = subprocess.run(['gh', 'api', path], capture_output=True, text=True, timeout=90)
    if out.returncode:
        raise RuntimeError(f'gh api {path}: {out.stderr.strip()[:200]}')
    return json.loads(out.stdout)


def git(*args):
    return subprocess.run(['git', '-C', REPO, *args], capture_output=True, text=True, timeout=30).stdout


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def slice_counts():
    with contextlib.redirect_stdout(io.StringIO()):
        g = runpy.run_path(f'{S}/bin/slice-counts.py')
    return {'out': g['out'], 'by': g['by'], 'plans': g['plans'], 'prs': g['prs'], 'dropped': g['DROPPED']}


def check_runs(sha):
    def fetch():
        runs = gh(f'{R}/commits/{sha}/check-runs?per_page=100')['check_runs']
        return [{'name': c['name'], 'status': c['status'], 'conclusion': c['conclusion'], 'url': c['html_url'],
                 'startedAt': c['started_at'], 'completedAt': c['completed_at']} for c in runs]
    key = f'checks:{sha}'
    hit = _cache.get(key)
    if hit and hit[1] and all(c['status'] == 'completed' for c in hit[1]):
        return hit[1]
    return cached(key, 50, fetch)


def required_jobs():
    return cached('required', 3600, lambda: gh(f'{R}/branches/main/protection')['required_status_checks']['contexts'])


def jobs_for(sha, required):
    runs = {c['name']: c for c in check_runs(sha)}
    return [dict(runs.get(n) or {'status': 'missing', 'conclusion': None, 'url': None}, name=n) for n in required]


def main_ci(required):
    def fetch():
        run = gh(f'{R}/actions/runs?branch=main&event=push&per_page=1')['workflow_runs'][0]
        return {'sha': run['head_sha'], 'runUrl': run['html_url'], 'createdAt': run['created_at'],
                'status': run['status'], 'conclusion': run['conclusion'], 'title': run['display_title']}
    ci = cached('mainrun', 50, fetch)
    return dict(ci, jobs=jobs_for(ci['sha'], required))


def open_prs(sc, required, slice_by_branch):
    out = []
    for p in sorted((p for p in sc['prs'] if p['state'] == 'open'), key=lambda p: p['number']):
        n, sha = p['number'], p['head']['sha']
        detail = cached(f'pr:{n}:{sha}:{p["updated_at"]}', 300, lambda: gh(f'{R}/pulls/{n}'))
        commit = cached(f'commit:{sha}', 86400, lambda: gh(f'{R}/commits/{sha}'))
        body = detail.get('body') or ''
        out.append({
            'number': n, 'title': p['title'], 'url': p['html_url'], 'headRef': p['head']['ref'], 'headSha': sha[:7],
            'baseRef': p['base']['ref'], 'headAt': commit['commit']['committer']['date'], 'draft': p.get('draft', False),
            'mergeable': detail.get('mergeable'), 'mergeableState': detail.get('mergeable_state'),
            'sol': bool(SOL_RE.search(body)), 'dependsOn': [int(x) for x in DEP_RE.findall(body)],
            'hold': HOLDS.get(n), 'slice': slice_by_branch.get(p['head']['ref']),
            'jobs': jobs_for(sha, required),
        })
    return out


def worktrees():
    wts, cur = [], {}
    for line in git('worktree', 'list', '--porcelain').splitlines() + ['']:
        if not line:
            if cur:
                wts.append(cur)
            cur = {}
        elif line.startswith('worktree '):
            cur['path'] = line[9:].replace(HOME, '~')
        elif line.startswith('branch '):
            cur['branch'] = line[7:].removeprefix('refs/heads/')
        elif line.startswith('HEAD '):
            cur['sha'] = line[5:12]
    return wts


def local_branches():
    refs = git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin').split()
    return {r.removeprefix('refs/heads/').removeprefix('refs/remotes/origin/') for r in refs}


def activity(branches):
    """Best effort: pi workflows and agent transcripts. Never raises."""
    workflows, agents, mentions = [], [], {}
    now = time.time()
    try:
        for js in sorted(glob.glob(f'{TASKS}/wf_*.workflow.js'), key=os.path.getmtime, reverse=True)[:8]:
            jl = js[:-3] + '.jsonl'
            entries = []
            if os.path.exists(jl):
                for line in open(jl):
                    try:
                        e = json.loads(line)
                        t = json.loads(e.get('text') or '{}') if (e.get('text') or '').startswith('{') else {}
                        entries.append({'ok': e.get('ok'), 'id': t.get('id'), 'branch': t.get('branch')})
                    except ValueError:
                        pass
            mtime = max(os.path.getmtime(p) for p in (js, jl) if os.path.exists(p))
            name = re.search(r"name:\s*'([^']+)'", open(js).read(400))
            workflows.append({'id': os.path.basename(js).split('.')[0], 'name': name.group(1) if name else '?',
                              'updatedAt': mtime, 'results': entries})
        for f in sorted(glob.glob(f'{TASKS}/*.output'), key=os.path.getmtime, reverse=True)[:12]:
            mtime = os.path.getmtime(f)
            prompt = ''
            with open(f) as fh:
                try:
                    msg = json.loads(fh.readline()).get('message', {}).get('content', '')
                    prompt = msg if isinstance(msg, str) else ' '.join(c.get('text', '') for c in msg if isinstance(c, dict))
                except ValueError:
                    pass
            active = now - mtime < 600
            agents.append({'id': os.path.basename(f).split('.')[0], 'updatedAt': mtime, 'active': active,
                           'prompt': prompt[:240]})
            if active:
                for b in branches:
                    if b in prompt:
                        mentions.setdefault(b, os.path.basename(f).split('.')[0])
    except Exception as e:  # noqa: BLE001 best effort by design
        workflows.append({'id': 'error', 'name': str(e)[:200], 'updatedAt': now, 'results': []})
    return workflows, agents, mentions


def system():
    mem = None
    try:
        m = re.search(r'free percentage: (\d+)%', subprocess.run(['memory_pressure'], capture_output=True, text=True, timeout=20).stdout)
        mem = int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        pass
    du = shutil.disk_usage(HOME)
    return {'diskFreeGB': round(du.free / 1e9, 1), 'diskTotalGB': round(du.total / 1e9), 'memFreePct': mem}


def slices_graph(sc, wts, branches, mentions, pr_info):
    by, plans, dropped = sc['by'], sc['plans'], sc['dropped']
    milestone_of, branch_to_id, nodes = {}, {}, []
    for m, sl in plans.items():
        for s in sl:
            milestone_of[s['id']] = m
            branch_to_id[s['branch']] = s['id']
    wt_branches = {w.get('branch'): w['path'] for w in wts}
    base = {}
    for m, sl in plans.items():
        for s in sl:
            p = by.get(s['branch'])
            base[s['id']] = 'dropped' if s['id'] in dropped else 'merged' if p and p.get('merged_at') else ('review' if p else 'todo')

    def dep_ref(d):
        """Plans name deps by slice id, sometimes by branch (as build-plan-wave.py's branch_of.get(dep, dep))."""
        if d in milestone_of:
            return d, base[d]
        if d in branch_to_id:
            return branch_to_id[d], base[branch_to_id[d]]
        p = by.get(d)
        return d, ('merged' if p and p.get('merged_at') else 'review' if p else 'unknown')

    for m, sl in plans.items():
        for s in sl:
            deps = [dep_ref(d) for d in (s.get('dependsOn') or [])]
            p = by.get(s['branch'])
            st, why = base[s['id']], None
            if st == 'todo':
                if s['branch'] in wt_branches:
                    st, why = 'progress', f"worktree {wt_branches[s['branch']]}"
                elif s['branch'] in mentions:
                    st, why = 'progress', f"agent {mentions[s['branch']]}"
                elif s['branch'] in branches:
                    st, why = 'progress', 'branch exists, no PR'
                else:
                    blockers = [d for d, ds in deps if ds not in ('merged', 'dropped')]
                    st = 'blocked' if blockers else 'ready'
                    why = blockers or None
            if st == 'dropped':
                why = dropped[s['id']]['why']
            nodes.append({'id': s['id'], 'milestone': m, 'title': s['title'], 'branch': s['branch'],
                          'deps': [d for d, _ in deps], 'state': st, 'why': why,
                          'pr': pr_info.get(p['number']) if p and not p.get('merged_at') else
                          ({'number': p['number'], 'url': p['html_url'], 'mergedAt': p['merged_at']} if p else None)})
    known = {n['id'] for n in nodes}
    external = sorted({d for n in nodes for d in n['deps'] if d not in known})
    return nodes, [{'id': d, 'state': dep_ref(d)[1]} for d in external]


def notes():
    try:
        return open(f'{S}/notes.md').read().splitlines()[-20:]
    except OSError:
        return []


def collect():
    errors = []
    sc = cached('slicecounts', 110, slice_counts)
    required = required_jobs()
    slice_by_branch = {s['branch']: s['id'] for sl in sc['plans'].values() for s in sl}
    prs = open_prs(sc, required, slice_by_branch)
    pr_info = {p['number']: {'number': p['number'], 'url': p['url'], 'jobs': p['jobs'], 'sol': p['sol'],
                             'mergeableState': p['mergeableState'], 'hold': p['hold']} for p in prs}
    try:
        ci = main_ci(required)
    except Exception as e:  # noqa: BLE001
        ci, _ = None, errors.append(f'main CI: {e}')
    wts = worktrees()
    branches = local_branches()
    workflows, agents, mentions = activity(set(slice_by_branch))
    nodes, external = slices_graph(sc, wts, branches, mentions, pr_info)
    counts = {m: {k: v for k, v in sc['out'][m].items() if k in ('total', 'merged', 'notStarted', 'open')} for m in MILESTONES}
    for m in MILESTONES:
        for st in ('review', 'progress', 'ready', 'blocked', 'dropped'):
            counts[m][st] = sum(1 for n in nodes if n['milestone'] == m and n['state'] == st)
    status = {
        'generatedAt': iso_now(), 'repoUrl': URL, 'milestones': MILESTONES, 'counts': counts,
        'totals': {'merged': sum(c['merged'] for c in counts.values()), 'total': sum(c['total'] for c in counts.values())},
        'slices': nodes, 'external': external, 'openPrs': prs, 'requiredJobs': required, 'mainCi': ci,
        'worktrees': wts, 'workflows': workflows, 'agents': agents, 'system': system(),
        'notes': notes(), 'ownerWaiting': OWNER_WAITING, 'errors': errors,
    }
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(status, f, indent=1)
    os.replace(tmp, OUT)
    return status


if __name__ == '__main__':
    s = collect()
    print(json.dumps(s['counts'], indent=1))
