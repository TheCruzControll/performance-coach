# Program notes (decision trail). Single writer: main session.

## 2026-11-07 09:10 UTC goal started
- State: 134/405 merged. Open PRs #13, #157 (hands off). main CI runs for #183/#184/#185: all jobs green except E2E still running (40 min timeout).
- Harness ported to pi: handoff f9dce3e (args arrive as JSON string; scripts parse).
- In flight: wf docs-profile smoke wave (M2); fv-sync agent (TLA+ verify-workout-sync, branch chore/verify-workout-sync); bg CI watcher bg-317a59363cc8.
- Budget: 5-6 agents, SLOT_COUNT=2. Disk 17 GB free, memory free 33%.
## 09:12 UTC goal start killed bg work
- Starting /goal reloaded the session: fv-sync agent aborted 09:10:21 (uncommitted model in pc-wt/fv-workout-sync), CI watcher gone, docs-profile wave wf_875 left no journal.
- Restarted: wave wf_0aacb9031683 (docs-profile), watcher bg-9703ea47dd9c, fv-sync-2 (96ff7d6e) resuming from the worktree.
- Lesson: never start/replace a /goal while background agents run; the reload kills them.
## 09:18 UTC goal restarted (new id 6a3e6fc1) killed bg work again
- Killed: fv-sync-2 (09:16:56), wave wf_0aac (docs-profile worktree m2s29 had README/architecture/milestones edits, kept for RESUME CHECK), watcher.
- Restarted: wave wf_28d06271fd42, watcher bg-eae856e34763, fv-sync-3 (1e8d8760) told to commit+push early.
## 09:25 UTC main CI checked
- d325f6c (latest main, includes #184/#185): all 5 jobs green, E2E 39:17.
- 42355809914 (#183) and 42356551780 (#184) E2E cancelled at exactly 40:00 timeout, nothing failed. Not a code failure; the suite is at the ceiling.
- Decision: start M9 e2e-ci-capacity now in parallel (wf_d9c50b0d3af1, limit 1) with the measured numbers, since every PR's E2E will now flake on timeout. Second wave alongside docs-profile.
## 09:45 UTC docs-profile -> PR #186
- Smoke wave ok end to end (implement, gates, push, gh pr create). Body follows file-pr; docs-only Sol n/a.
- My read of the diff: architecture section matches; but milestones/README say owner iPhone setup still open, contradicting HANDOFF (done 2026-11-06 in Chrome for iOS, which also asks M2's docs PR to retarget the testing.md checklist). Sent fix-186 (fresh Opus). Verify after with a Sol pass before merge.
- Next wave: M2X email-link-endpoints -> email-link-signin, limit 1 (wf_76609f77ee86). First real Sol loop test.
## 09:55 UTC status page live (http://127.0.0.1:8765, status/run.sh); counts match slice-counts.py
- It surfaced 7 provisional M2X names in m4-plan dependsOn (plan decision 28 says replace before building). Mapped: layout-tokens->desk-rules, responsive-shell->desk-shell, desktop-projects->desk-e2e, main-screens->desk-main-screens, screen-pass->desk-today+desk-train-week+desk-train-detail, email-link-ui->email-link-signin, docs->docs-m2x. Scratch plan + handoff 646ca01.
- Effect: workout-shell now ready (desk-rules, desk-e2e merged); resume-bar, workout-settings, start-entry-points, signout-workout-data now wait on real M2X slices.
## 10:05 UTC #186 verified
- Sol verifier r1 CHANGES (2 false claims: race ids not preserved; goal events do have owner FK). fix-186b -> 6ded0dc. Sol r2 APPROVE at 6ded0dc. docs-guard-check: 81/81 pass. CI on 6ded0dc pending. wait-ready watcher bg-2f76db16d8dc running.
## 10:20 UTC PR #187 (TLA+ verify-workout-sync) opened by fv-sync-3, head 5eadf54
- 4 properties, 7 mutants each caught, ~45 s. Finding F1 (latent): Discard does not stop an in-flight POST; a discarded edit can land after a newer one. Latent: nothing calls discard yet.
- F1 must be handled by M4 `sync-status` (wires Fix/Discard): pass it as `extra` in that slice's wave, and the slice must rerun verification/workout-sync/check.sh.
- Sol review r1 started (sol-187-r1).
## 10:50 UTC #187 Sol approved (2 rounds, high) at d3d34df
- r1: claimAfterApply mutant unrealistic (insertSet idempotent) + typo check name passed silently. fix-187-r1 modelled handler-run vs committed write; new 13-step counterexample real (Sol reproduced history <<1,2,3,2>>). r2 APPROVE. Sol line set in body. docs-guard 81/81. CI running.
## 11:00 UTC e2e-ci-capacity -> PR #189 (Sol approved 2 rounds high); email-link-endpoints -> PR #188 (wave continues to signin)
- Verified from pi session files: workflow reviewer sessions ran provider openai model gpt-6.1-sol.
- #189: 7 legs + aggregate keeping the required check name; projected ~14 min. Its own CI run is the proof; compare leg minutes with projections before merge.
- Started M4 shell chain wave wf_34260c6139f0 (limit 1, 9 slices: workout-shell..other-logging). sync-status carries F1 as extra; sync-status and workout-sync-wiring at xhigh.
## 10:30 UTC MERGED #189 e2e-ci-capacity (abaf53a). First merge of the session.
- Its CI: 7 legs, slowest main·chromium 14:00, aggregate check name kept; whole PR ~14 min vs 39-40. docs-guard 81/81. Merged via gh api PUT with sha + title.
- Fixed bin/wait-ready.sh: BSD paste needs '-' for stdin (was printing usage every pass; ignore list never applied).
- Note: #186/#187/#188 CI runs started before this merge use the old single 40-min job.
## 10:40 UTC refreshed #186 (78ad284), #187 (3d21999) by merge of main; #188 via update-branch (its worktree was already removed by the wave). All get the new E2E legs.
## 10:55 UTC owner decisions
- #157: owner says merge. Sol review first (sol-157, xhigh), merge if approved and green.
- Email sign-in link: skip. Closed #188. Dropping email-link-endpoints, email-link-signin, docs-email-security; dependants get an extra line. Email wave wf_76609f77ee86 (now on signin) is wasted work; no cancel tool, asked owner to stop it in /agents, else ignore its PR and close it.
- Lighthouse TBT: keep current limit.
- Testing: local gates lint/check/unit (+integration for db slices); CI runs the heavy suites; after Sol + green CI, a click-through verifier drives the production Node build in a headed Chromium per acceptance item. harness-v2 agent making these changes (applies to waves started after).
## 11:00 UTC MERGED #157 (b3bad0b, Sol approved xhigh, owner said merge) and #186 (8f1272d). docs-guard 81/81 each.
- main abaf53a CI red: serial·webkit onboarding "Back keeps a changed level" pageerror "__data.json ... due to access control checks" (WebKit aborted invalidation fetch). Intermittent: passed on d325f6c and on #186's run. fix-main-webkit (Opus high, Bug fix playbook, no test weakening) on fix/onboarding-back-webkit.
- 11:10 UTC owner stopped email wave; removed m2xs15 worktree/branch (never pushed), its local test DBs.
- 11:15 UTC correction: told owner 4 PRs merged incl. #187; actually 3 (#189, #157, #186). #187 still in CI.
- 11:16 UTC MERGED #187 (429fda5). Now 4 merged this session: #189, #157, #186, #187.
- 11:25 UTC owner: drop desktop-webkit tests (Chrome for iOS = WebKit stays). drop-desktop-webkit agent on ci/drop-desktop-webkit.
- 11:45 UTC #190 drop desktop-webkit: Sol approved r1 (nit: design-system.md mention -> Docs to add). Waiting CI.
- 12:05 UTC #191 WebKit flake fix (Back link preload=tap; root cause hover preload cancelled by next goto) Sol approved r1.
## 12:15 UTC harness-v2 landed (handoff 7fda832): dropped.json (402 total, 136 merged), light local gates, CI wait + fix loop, click-through verifier for UI slices.
- Started M5 coach-turn wave wf_6ef2e2cd5791 (limit 2, first wave on harness v2): provider-selection, coach-conversations-db, coach-threads-service, agent-runs-service, coach-turn. anthropic-provider waits on coach-bundle-guards <- workout-shell (M4 wave).
- 12:20 UTC MERGED #190 drop desktop-webkit. main 429fda5 CI green.
## 12:30 UTC #192 workout-shell (old-script wave): Sol open finding = /workout 58.7 KB vs plan runway 53.8 KB (hard gate 60 KB passes; no budget raised).
- Decision (mine, plan default): the 60 KB gate is the guard; the plan's 53.8 is runway. Restore runway for the whole chain by slimming shared entry JS instead of re-cutting allowances. Spawned perf-entry-js (target -4 KB shared). Then a fresh Sol round on #192 with this as the ledger answer before merge.
- 12:35 UTC MERGED #191 WebKit flake fix.
- 13:00 UTC MERGED #193 provider-selection (first PR from harness v2: Sol approved r1, CI green).
- 13:10 UTC MERGED #192 workout-shell after Sol r4 approved the budget decision. Note: old-script wave slices (#192 and the rest of the M4 chain) had no click-through; batch a click-through pass over them when the chain ends.
- 13:45 UTC perf PR #194: shared JS 47.7->44.5 KB, /workout 56.6 (3.4 KB runway). 4 KB target unreachable without framework changes (measured). Sol review started.
- 14:20 UTC MERGED #195 coach-conversations-db (migrations 0023/0024, follows 0022 on main; Sol xhigh r1).
- 15:00 UTC #194 Sol approved r3 (toast timer start at appearance, 60 s pending limit; preferences load on mount). Waiting CI.
- 15:10 UTC MERGED #194 perf shared JS.
- 15:15 UTC MERGED #196 coach-threads-service.
- 15:35 UTC MERGED #197 strength-view (old-script wave; click-through batched at chain end; /workout still dark-launched).
- 15:40 UTC #198 workout-sync-wiring stale (main changed e2e/workout-shell.e2e.ts via #197) -> update-branch. #199 agent-runs-service in CI.
- 15:45 UTC MERGED #199 agent-runs-service.
- 16:00 UTC #198 CI red: #197's strength spec asserts no /api/workouts requests; #198 now syncs on every workout page (semantic conflict). fix-198 (Opus high). Then Sol round on fix diff.
- 16:40 UTC #198 spec fix approved by Sol after 2 more rounds (immutable outbox snapshot, settle wait). CI rerunning.
- 16:50 UTC M5 wave wf_6ef2 done (#193 #195 #196 #199 merged, #200 coach-turn ready). Started M5 wave b wf_bac2eb1c49cd (limit 2, 8 slices incl. coach-bundle-guards -> anthropic-provider). HANDOFF update agent running.
- 17:10 UTC MERGED #198 workout-sync-wiring.
- 17:12 UTC MERGED #200 coach-turn.
- 17:40 UTC MERGED #201 coach-bundle-guards.
- 17:45 UTC #202 proposal-diff lint red; harness v2 wave owns the CI fix loop, ignoring in watcher.
- 18:05 UTC MERGED #203 coach-proposals-db.
- 18:10 UTC MERGED #202 proposal-diff (CI fix round by the wave).
- 18:15 UTC #204 log-set (old-script wave) E2E main·webkit red: strength reload test text differs. fix-204 (Opus high). #205 anthropic-provider in CI.
- 18:20 UTC MERGED #205 anthropic-provider (coach still off in prod until coach-launch).
- 18:45 UTC #204 test fix (wait for logger before comparing) Sol approved. CI rerunning.
- 19:05 UTC #204 still red: same logger-late race in workout-shell.e2e.ts reload test. fix-204b sweeps all specs for the pattern.
- 19:20 UTC #204 second spec fix approved; CI rerunning.
- 19:25 UTC MERGED #206 proposal-drafter.
- 19:30 UTC MERGED #207 coach-proposals-service.
- 19:35 UTC MERGED #208 coach-turn-endpoint.
- 19:40 UTC MERGED #204 log-set.
- 20:05 UTC #209 set-actions dirty on GitHub but merge-tree clean (stacked criss-cross); refresh-209 merging main locally. #210 apply-profile-proposals in CI.
- 20:15 UTC M5 wave b done (8 slices, all merged or ready; first click-through ran on #210, headed Chromium with passkey). Started M3 rest wave wf_105a6e458580 (limit 1, 8 slices; Today/Train screens).
- 20:25 UTC #209 refreshed (0044832), gates pass.
- 20:30 UTC MERGED #210 apply-profile-proposals.
- 20:45 UTC #209 CI red after main merge: semantic conflict with #204 specs (set rows text, reload identical). fix-209 (Opus high).
- 21:20 UTC #209 fix (SetRow stray space regression + spec expectations + WebKit hover race) Sol approved. CI rerunning.
- 22:10 UTC MERGED #209 set-actions.
- 22:40 UTC #211 today-lazy-panels (M3 wave, harness v2) CI red; the wave's CI fix loop owns it; ignored in watcher.
- 18:40 UTC check: 154/402. #211 green after wave fix loop; #212 adjust-skip CI running. M4 wave in sync-status Sol rounds (F1).
- 18:45 UTC MERGED #211 today-lazy-panels (Sol r4, click-through pass, /today 56.8 KB).
- 19:00 UTC owner: drop auth-change-email (dropped.json); backups stay off; offline mode not needed but keep what's built, no extra offline scope. 401 total.
- 19:10 UTC owner: 3 waves allowed (GOAL.md updated). Started M9 backend wave wf_9c9c3e4e2fe0 (limit 2, 8 slices: restore/backup chain + recovery-codes-120-bit), backups built but switched off.
- 19:25 UTC PAUSED for cloud resume. Waves stopped by owner; in-flight branches pushed (m3/42, m3/48, m4/32, m4/33, m9/12 wip); HANDOFF 5e4c2b2. caffeinate and status server stopped.
