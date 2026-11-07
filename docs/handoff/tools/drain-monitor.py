#!/usr/bin/env python3
# Wind-down monitor: exit (printing which waves are drained) once a wave's allowed in-flight slices
# have all published (or errored). Waves already reported go in drained.txt and are skipped.
import json, os, sys, time, glob
W = '<session>/subagents/workflows'
N = '<scratch>'
WAVES = {
  'wlfldmivw': ('wf_f88f2fc2-e2a', ['backup-export']),
  'wb69j16wo': ('wf_8031ff65-d34', ['onboarding-resume', 'today-summary']),
  'wsn10pb7e': ('wf_37e7ec18-88f', ['swap-exercise']),
  'walzqlk9h': ('wf_be1afe62-090', ['canonical-reads', 'run-other-handlers']),
  'wyz3r4q0r': ('wf_986bf2b8-9c1', ['progression-rules']),
  'w5an8l662': ('wf_99857716-c45', ['email-link-service']),
  'wg97qaowy': ('wf_8eff7903-96c', ['proposal-payloads']),
}
def state(run, ids):
    d = glob.glob(f'{W}/{run}*')[0]
    started = {}; res = {}
    for l in open(f'{d}/journal.jsonl'):
        j = json.loads(l)
        if j.get('type') == 'started': started[j.get('key')] = j.get('label') or ''
        if j.get('type') == 'result':
            lab = started.get(j.get('key'), ''); r = j.get('result')
            if lab.startswith('publish:') and isinstance(r, dict) and r.get('prNumber'): res[lab[8:]] = f"#{r['prNumber']}"
            if lab.startswith('impl:') and (not isinstance(r, dict) or not r.get('base')): res[lab[5:]] = 'impl-failed'
    extra = [v for v in started.values() if v.startswith('impl:') and v[5:] not in ids and v[5:] not in res]
    return {i: res.get(i) for i in ids}, extra
done_f = f'{N}/drained.txt'
while True:
    drained = set(open(done_f).read().split()) if os.path.exists(done_f) else set()
    out = []
    for task, (run, ids) in WAVES.items():
        if task in drained: continue
        st, extra = state(run, ids)
        if all(st.values()): out.append(f'DRAINED {task} {st} extra-started={extra}')
    if out:
        print('\n'.join(out)); sys.exit(0)
    time.sleep(60)
