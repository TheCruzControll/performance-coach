import json, re

S = '<scratch>'
D = '/root/.claude/projects/-home-user-performance-coach/7dfac99c-7ffa-543a-b71b-13de33c61bd5/workflows/scripts'
src = open(f'{S}/wave-M5b.js').read()
A = json.load(open(f'{S}/wave-finish.json'))
A['limit'] = 5
body = src[src.index('};', src.index('export const meta')) + 2:]
body, n = re.subn(r'^const A = .*$', lambda m: 'const A = ' + json.dumps(A) + ';', body, count=1, flags=re.M)
assert n == 1
end = 'return await Promise.all(ITEMS.map(start));'
assert end in body
body = body.replace(end, '')


def strip_fix(path, suffix, resume):
    t = open(path).read()
    t = t[t.index("\nconst S = '"):]
    t = re.sub(r'^phase\(.*\)$', '', t, flags=re.M)
    # first agent prompt: add the resume note after ${CTX}\n\n
    t = t.replace('agent(`${CTX}\n\n', 'agent(`${CTX}\n\n' + resume, 1)
    t = t.replace('CTX', 'CTX_' + suffix)
    t = re.sub(r"phase: '\w+'", "phase: 'Fixes'", t)
    return 'async function fix' + suffix + '() {\n' + t + '\n}\n'


R172 = ("RESUME NOTE: the container restarted while an earlier engineer was mid-way. The worktree is in the middle of a merge "
        "of an OLDER origin/main (a conflict is still unresolved in e2e/onboarding.serial.e2e.ts; Step.svelte may already be resolved), "
        "and main has moved since. Inspect the state; either finish that merge and then also merge the current origin/main, or "
        "\\`git merge --abort\\` and redo the merge against the current origin/main, whichever is cleaner. Everything main brings that is "
        "not onboarding (migrations up to 0022, new specs) is not yours to change.\\n\\n")
R173 = ("RESUME NOTE: the container restarted while an earlier engineer was mid-way. The worktree has UNCOMMITTED changes from "
        "that engineer (today +page.svelte, +page.server.ts, setup.server.ts, an integration test, today.serial and a11y e2e). "
        "Read them first (\\`git diff\\`): keep what is right, discard what is not, and finish. Before the final gates also merge "
        "the current origin/main into the branch (merge commit \"Merge main into m2/36-today-setup\"), since main moved.\\n\\n")

f172 = strip_fix(f'{D}/fix-172-conflict-wf_e38457df-8ce.js', '172', R172).replace(
    "(already checked out on m2/39-onboarding-review at origin's head, clean)", '(checked out on m2/39-onboarding-review)')
f173 = strip_fix(f'{D}/fix-173-today-lcp-wf_511a978e-545.js', '173', R173)

meta = """export const meta = {
	name: 'finish-in-flight',
	description: 'After the container restart: finish the 9 in-flight slices from their worktrees (implement, sol-review, publish a PR) and the #172 merge and #173 LCP fixes',
	phases: [
		{ title: 'Implement', detail: 'resume each slice from its worktree' },
		{ title: 'Sol', detail: 'sol-review fix loop' },
		{ title: 'Publish', detail: 'fold fixups, gates, push, PR' },
		{ title: 'Fixes', detail: '#172 merge with main and #173 /today LCP, each independently verified before push' }
	]
};
"""
tail = """
const [slices, r172, r173] = await Promise.all([Promise.all(ITEMS.map(start)), fix172(), fix173()]);
return { slices, fixes: { 172: r172, 173: r173 } };
"""
open(f'{S}/wave-finish.js', 'w').write(meta + body + f172 + f173 + tail)
print('ok')
