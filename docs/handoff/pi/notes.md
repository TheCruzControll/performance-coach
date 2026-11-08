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
## 2026-11-07 19:40 UTC resumed on Mac + pi (goal b8ded777)
- caffeinate 15275 and status server 15281 running. 155/401 merged, open #212 #13.
- Fixed bin/wait-ci.sh: waits until all 5 required check names exist (the E2E aggregate appears late; #212 false green).
- m4-r2 sync-status got an `extra` line: squash fixups, confirm tree == ee7bff9, rerun verification/workout-sync/check.sh.
- fix-212 (Opus high) on e2e/adjust-skip.serial.e2e.ts:250.
- Waves: m4-r2 wf_8d931c64d717 (l1), m3-r2 wf_b118fd78c818 (l1), m9-r2 wf_dcf407e574ca (l2), m5-r2 wf_73b351c9a09d (l2). wf_87a3abc6e96d was a bad-args start, failed at once.
- 19:50 UTC owner: CI is the gate on GitHub; no per-PR CI-wait agent and no per-PR click-through. dag-cloud.js returns after publish unless args.waitCi; main thread's wait-ready.sh watches CI and starts fixers on red. UI slices get one click-through per screen chain when the chain ends (findings as own PRs). The 4 running waves still use the old script.
- 20:00 UTC owner: Claude quota at 50%. Cuts: publish agent Opus low (was medium), PR lookup on Terra, batched click-throughs on Sol (no Claude). Keep 4 waves. Owner stopping the 4 old-script waves; restart on new script.
- restarted on new script: m4-r2 wf_2f5a06410582, m3-r2 wf_97c220864eb7 (old wf_8d93, wf_b118 stopped). m9/m5 old waves pending owner stop.
- m9-r2 restarted: Task ID: wf_701232a9cf49
- m5-r2 restarted: Task ID: wf_6659437f3a2f
- 20:20 UTC #212 fix 0cfd18b (exempt the one expected 409 on ?/adjust, asserted once) Sol approved. CI running; un-ignored in watcher.
- 20:25 UTC owner set the M8 council bar (private: council-bar.private.json, never copy into prompts, notes, handoff or commits) and no round cap.
- 20:30 UTC MERGED #212 adjust-skip (0cfd18b, CI 5/5, docs-guard 81/81).
- 21:05 UTC MERGED #213 restore-schema-step (Sol xhigh r1, CI 5/5).
- 21:00 UTC #214 #215 #217 CI pending; #216 build-my-program lint red -> fix-216 (Opus medium).
- 21:15 UTC #216 prettier-only fix cbde6e1 (whitespace diff, no Sol round needed); un-ignored.
- 21:20 UTC MERGED #214 sync-status (Sol approved, workout-sync check 12/12, CI 5/5).
- 21:25 UTC MERGED #215 backup-run-service (Sol xhigh r2, off by config).
- 21:45 UTC #217 docs: Sol claim check found 5 wrong claims; fix-217 corrected them (4221430), diff read by me. Un-ignored.
- 21:50 UTC MERGED #218 coach-memory-profile (Sol r1).
- 21:55 UTC #216 E2E serial·webkit red: build-program.serial.e2e.ts:360 strict-mode violation (.or() resolves to 2). fix-216b (Opus medium).
- 22:00 UTC MERGED #217 docs-data-model.
- 22:15 UTC #216 test fix 53333d4 (match only the visible state; card hidden by design) Sol approved. Un-ignored; CI on new head.
- 22:20 UTC #216 CI red again: e2e/workout-log.e2e.ts:400 CLS 0.00209 != 0 on iphone-chromium (both tries); main green on same test, so #216's change causes it. fix-216c (Opus medium).
- 22:40 UTC MERGED #219 tools-programming-reads (Sol r2).
- 23:50 UTC m3-r2 wave done: #216 (CI fix in flight), #217 merged; today-sessions unpublished (gates timed out, load avg 53) so its 3 dependants did not start. dag-cloud: lint and full unit runs now go through slot. Started m3-r3 Task ID: wf_3e917bcbe258 (today-sessions resume, perf-program-screens, program-journey, docs-m3-status).
- m3-r3 restarted after a quoting fix: Task ID: wf_700d891d4c56
- 00:00 UTC #220 exercise-navigation CI: Performance budgets red. fix-220 (Opus medium).
- 00:10 UTC #220 also E2E desktop tab order (steered fix-220). #221 coach-answer-kit E2E: chips overlap, Show all 36px tap target -> fix-221 (Opus medium).
- 00:25 UTC fix-216c: #216 not the cause; SyncPill (from #214) text width change shifts header -> flaky CLS test. Reran #216 failed jobs. fix-syncpill (Opus medium) opens a PR on main. Load avg 54-109, memory pressure normal, disk 13 GB: keeping 4 waves.
- 00:45 UTC #222 sync-pill fix: Sol r1 changes requested (min-width overflows at 150% text; other messages still grow). fix-222b (Opus high) redesigns the slot.
- 00:55 UTC #223 run-logging GitHub DIRTY but merge-tree clean (criss-cross); pushed a clean main merge f356546.
- 01:00 UTC #221 component fix d2a144f Sol approved (Tabs shared change checked on /progress). Un-ignored.
- 01:05 UTC MERGED #216 build-my-program (rerun green; SyncPill flake fix in #222).
- 01:15 UTC MERGED #221 coach-answer-kit.
- 01:25 UTC #224 today-sessions DIRTY/criss-cross: pushed clean main merge 913439f. #223 run-logging budgets FAIL: /workout 61.1 KB, /workout/run 70.8 KB (gate 60). fix-223 (Opus high).
- 01:35 UTC #224 today-sessions E2E: every today-plan.serial spec fails at hydration (html data-theme '' not 'dark') on chromium+webkit. fix-224 (Opus medium).
- 02:10 UTC fix-220 pushed 186e350 (/workout 60.0->59.4 KB; main alone 59.8 KB, no runway left; tab-order spec skips sync pill). Sol review sol-220. Todo: /workout runway perf PR after #220/#223.
- 02:15 UTC #220 fix 186e350 Sol approved; un-ignored.
- 02:30 UTC #220 E2E main·webkit hit its 13-min Playwright timeout (capacity, tests passing). Reran failed jobs. ci-shards (Opus low) splits E2E main into 2 shards per engine per ci.yml's rule.
- 02:45 UTC main f6f207f red: serial·webkit 15-min timeout (steered ci-shards to cover serial legs). #225 red on flaky build-program.serial.e2e.ts:360 chromium (Retry path) -> reran; fix-preview-retry (Opus medium) PR on main. #223 Sol r1: lazy RunView blank pending state -> fix-223b.
- 02:55 UTC MERGED #220 exercise-navigation.
- 03:00 UTC MERGED #227 recovery-codes-120-bit.
- #226 output-policy red on the same build-program:360 chromium test; waiting on fix-preview-retry, then rerun.
- 03:05 UTC MERGED #225 backup-cli.
- 03:10 UTC #228 ci shards opened (main x2 both engines, serial·webkit x2). Sol review running.
- 03:40 UTC #228 Sol approved r2 (provisional shard minutes = old leg values). Body updated; un-ignored.
- 03:45 UTC MERGED #228 CI shards.
- 04:00 UTC m4-r2 wave done (#214 #220 merged, #223 fixing, #230 other-logging open). Started m4-r3 Task ID: wf_a447dbcd0a35 (limit 2, backend: start-kit chain, substitution/pain handlers, custom-exercise-sync, perf-set-logging). M4 UI slices wait for the /workout runway PR.
- #230 other-logging budgets red; stacked on #223, handle after #223 merges.
- 04:10 UTC m9-r2 wave done: #213 #215 #225 #227 merged, #229 open; restore-rows publish failed (gates timed out, load avg up to 139), restore-cli/docs-backups-restore not started. Holding the 4th wave until the 4 fixers finish (overload causes gate timeouts and rework).
- 04:30 UTC #223 Shell ready-prop fix 3d2cc46 Sol approved; un-ignored.
- 04:50 UTC #223 vite.config conflict with #220 -> merge-223 (Opus medium) then verifier. #229 E2E serial·webkit timeout (pre-#228) -> update-branch. #224 spec fix 5b3212f (dark = no data-theme) -> Sol confirm.
- #224 spec fix Sol approved; un-ignored.
- 05:05 UTC #222 Sol approved r3 (rendered 100-250%, 999+). Body updated, branch updated with main (for #228 shards), un-ignored.
- 05:20 UTC #223 main merge f5ec9a4 verified by Sol (both chunk-rule intents kept; /workout 59.3, /workout/run 57.9). Un-ignored.
- 05:40 UTC fix-preview-retry opened #236 (wait before clicking the SSR card; click before hydration was lost). Sol review.
- 06:15 UTC m5-r2 wave done (7 PRs). M5 next slices all wait on M4 backend (m4-r3). Started m9-r3 Task ID: wf_694e24791fae: restore-rows, restore-cli, docs-backups-restore, setup-token-expiry, secrets-scan.
- 06:10 UTC MERGED #229 backup-cron-endpoint (404 while CRON_SECRET unset: backups stay off).
- 06:20 UTC started m2x-r1 Task ID: wf_073fadf03e7a (limit 1): desk-profile, desk-onboarding, desk-train-week, desk-today, desk-train-detail, desk-lighthouse.
- 06:25 UTC gh update-branch now 403s (main changed .github/workflows; token lacks workflow scope). New bin/update-branch.sh merges main locally and pushes. #223 updated to c0142ac.
- 06:35 UTC MERGED #222 sync-pill fix.
- 04:27 UTC MERGED #232 m5/34-tools-analytics.
- #236 Sol approved r2 (live CTA selector); body updated.
- 04:29 UTC MERGED #234 m5/39-direct-answers.
- 04:35 UTC m3-r3 wave done (#224 #231 #233 #238 open). Started m6-r1 Task ID: wf_6f203bba918e (limit 2): chart-kit-core, line-chart, bar-charts, range-diverging-bars, metric-tiles, review-snapshot, weekly-review-compose, next-week-adjustments.
