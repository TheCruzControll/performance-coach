#!/usr/bin/env python3
"""Wait until every listed slice of a dag-cloud run has finished its publish step (or failed),
or the run has finished. Then print what happened and exit, so the caller can stop the run
before it starts more slices.

    wait-publish.py <journal.jsonl> <slice-id> [<slice-id> ...]
"""
import json, sys, time

journal, ids = sys.argv[1], set(sys.argv[2:])
while True:
    started, done, finished = {}, set(), False
    try:
        for line in open(journal):
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = e.get('type')
            if t == 'started':
                started[e['key']] = e.get('label') or ''
            elif e.get('key'):
                done.add(e['key'])
            if t in ('completed', 'failed', 'finished'):
                finished = True
    except FileNotFoundError:
        pass
    published = {lab.split(':', 1)[1] for k, lab in started.items() if lab.startswith('publish:') and k in done}
    running = sorted(lab for k, lab in started.items() if k not in done and lab)
    if ids <= published or finished:
        print('published:', sorted(published & ids), '| still running:', running, '| run finished:', finished)
        break
    time.sleep(60)
