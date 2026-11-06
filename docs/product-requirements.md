# Product Requirements — Personal AI Performance Coach

> Source of truth for scope. Captured from the owner's brief (Niko Cruz). Every milestone,
> PR, and review must trace back to this document. Section numbers match the original brief.

## 1. Product overview

A **private, single-user** AI performance coaching platform with a polished, mobile-first web app,
served from the owner's domain **nikocruz.com** (subdomain `coach.nikocruz.com`). Only the owner may
access it.

Two interconnected components:

1. **AI Performance Coach** — an agent that creates programs, analyzes performance, tracks progress,
   and continuously adapts programming from the owner's training history and goals.
2. **Training Application** — a mobile-first web app (iPhone first) to view workouts, log sessions,
   track performance, and talk to the coach. It is also a first-class desktop browser app (owner
   request, 2026-11-06): every screen is laid out for a desktop window, not a stretched phone screen.

It must feel like a premium dedicated fitness product — **not** a generic chatbot with a tracker
bolted on. Three equal priorities, none sacrificed for another:

- Intelligent, adaptive coaching.
- Exceptional application performance.
- Exceptional product design and UX.

## 2. Training disciplines & goals

Supported disciplines (data model must not be weightlifting-only and must be extensible):
powerlifting, Olympic weightlifting, general strength, hypertrophy/bodybuilding, running,
half-marathon/marathon prep, Muay Thai, general athletic performance, custom goals.

- Multiple **concurrent goals** (e.g. Muay Thai fight + maintain strength + marathon + build muscle).
- The coach reasons about **total training load across disciplines** and interference, e.g.:
  high running volume vs. lower-body lifting recovery; hard Muay Thai sessions add fatigue; strength
  volume changes during marathon prep; hypertrophy phase ≠ competition prep.
- Understands differences between training for strength, endurance, skill, conditioning, hypertrophy.

**Goal onboarding** asks whether the owner is training for (a) a specific competition/event,
(b) a general performance goal, or (c) multiple goals simultaneously.

- Event goals collect: event type, date, weight class (if applicable), target performance,
  requirements/constraints.
- General goals collect: what to improve and how progress is measured.
- Goals and priorities change over time; the coach knows which goal wins when demands conflict.

## 3. Onboarding & training profile (everything editable later)

**Experience & baseline**: experience per discipline; current strength levels (if known); running
ability and recent race times; Muay Thai frequency/experience; exercise preferences; disliked
exercises; equipment/facilities; injuries, limitations, movements to avoid.

**1RM values are optional.** All 1RM fields may be left blank; never require testing a 1RM.

- Known 1RMs → initial programming inputs.
- Unknown → RPE-based programming establishes a baseline in week 1: manageable working sets; owner
  records weight, reps, RPE; results estimate strength; set initial working weights and progression.
- Distinguish **measured** 1RM vs **estimated** 1RM. Never treat an estimate as a confirmed max.
- Week 1 with insufficient data = baseline establishment period; avoid aggressive loading.

**Physical goals**: body weight; body composition / nutrition phase (bulk, cut, maintenance, recomp);
weight targets. Informs training without overriding performance or recovery.

**Schedule & availability**: days/week; available days; preferred times; session length;
constraints; current commitments per discipline. Realistic schedule around availability; editable
any time.

## 4. AI coach architecture

A real **agent with structured tools over structured training data** — not an LLM fed a long chat
history. Reasoning, tools, data access, and programming logic are separated from the frontend.

Capabilities: create programs; generate workouts; retrieve history; analyze completed workouts;
track performance & fatigue; manage progressive overload; recommend substitutions; adjust future
training; weekly reviews; manage blocks/cycles; explain decisions; answer questions.

Example tools (design real interfaces around the architecture):

- History: `get_training_history`, `get_exercise_history(exercise_id)`, `get_running_history`,
  `get_recent_workouts`, `get_personal_records`
- Programming: `get_current_program`, `get_current_training_week`, `get_training_schedule`,
  `propose_program_adjustment`, `create_training_program`, `create_next_training_cycle`
- Workout: `get_current_workout`, `update_workout`, `substitute_exercise`, `save_workout_analysis`
- Preferences: `get_training_preferences`, `update_exercise_preferences`, `update_training_goals`
- Analytics: `get_weekly_training_summary`, `get_training_load`, `get_performance_trends`

**Persistent coaching memory** (structured): goals, active program, history, strength estimates,
performance trends, exercise preferences, rejected exercises, recovery patterns, previous programming
decisions (with **why**), weekly reviews, previous cycles.

- A substitution because a machine was unavailable must **not** become a permanent preference.
- An explicit "I dislike this exercise" **must** persist.

## 5. Adaptive programming & progression

Adapt to actual results, not a fixed script.

**Strength**: prescribed weight, completed reps, actual vs target RPE, missed reps, multi-session
performance, weekly volume, accumulated fatigue. Below target RPE consistently → consider adding load;
above → reduce load/volume; missed reps → account for it; declining performance → consider fatigue.
Use multiple sessions before significant changes. Estimated 1RM via appropriate formulas + RPE.

**Running**: distance, duration, pace, HR when available; easy/tempo/intervals/long runs; weekly
mileage; race goals; recovery. Marathon prep: structured blocks, progressive mileage, taper,
race-specific workouts.

**Muay Thai & athletic**: sessions, duration, intensity/RPE, sparring, pad work, technical,
conditioning, S&C. Accounted for when planning other training.

**Hypertrophy**: sets per muscle group, weekly volume, exercise selection, rep ranges, RPE,
frequency, progression; manage hypertrophy blocks; adjust volume from results and recovery.

**Concurrent training (critical)**: whole-schedule view of accumulated workload. Don't blindly
schedule heavy squats right before hard Muay Thai, high-volume legs before a long run, or intense
intervals right after a very demanding day. Consider interference, recovery, goal priority; explain
meaningful tradeoffs.

## 6. Exercise substitutions & feedback

Quick in-workout actions: machine unavailable; I don't like this exercise; this hurts; suggest an
alternative; skip this exercise. Alternatives preserve the purpose of the original (same muscles /
training intent); equivalents for other disciplines where possible. Persist explicit preferences so
rejected exercises are not re-prescribed. **Pain**: never "push through"; offer a safer alternative
or stopping the movement; no medical diagnoses.

## 7. Workout application & interface

Designed primarily for **iPhone**, for someone actively training in a gym. The workout screen is
simple, fast, easy between sets. Every screen also works in a desktop browser: navigation in a rail
beside the content, the content centred at a readable width, pointer hover and keyboard focus
states, and wider layouts where the width helps (analytics, a list beside its editor).

- Strength display per exercise: name, target sets × reps, target RPE, prescribed weight, previous
  performance, rest timer. Other disciplines show their relevant metrics (running: distance, pace,
  duration, target intensity).
- Strength set logging: weight, reps, actual RPE. Complete a set, edit a completed set, skip a set,
  record missed reps, add extra sets. **Extremely fast** — buttons, numeric inputs, sensible defaults
  over typing; prefilled values; previous performance visible for comparison.
- Running logging: distance, duration, pace, HR (optional), RPE, notes; structured multi-segment runs
  (warmup, intervals, recovery, cooldown).
- General sessions: type, duration, RPE, notes, custom metrics. Extensible data model.

## 8. Timers & utilities

- Rest timer between sets + stopwatch for total workout duration; start/pause/reset/skip; configurable
  default rest durations; accessible without leaving the current exercise; state preserved across
  close/refresh where practical.
- **Plate calculator**: target weight; configurable bar weight; lb and kg; common plate
  denominations; plates per side; visual plate representation; accessible from the workout screen;
  common bar configs; customizable available plates.

## 9. Workout persistence & training history

Never lose workout progress on refresh, Safari close, or app switch.

- Local persistence (IndexedDB): autosave; restore active workout; completed sets; current exercise;
  timer state; tolerate network interruptions; sync when connectivity returns; **no duplicates**.
- Backend DB is the long-term source of truth, with structured records for: user profile, goals,
  preferences, programs, training cycles, planned workouts, completed workouts, set records, running
  sessions, other sessions, exercise history, AI recommendations, weekly reviews, programming
  decisions.
- Timestamps + historical records: new programming never overwrites old training data.

## 10. Analytics & dashboard

- **Strength**: e1RM trends, weight/rep progression, PRs, weekly volume, sets per muscle group, avg RPE.
- **Running**: weekly mileage, distance trends, pace trends, long-run progression, race performance,
  frequency.
- **General**: weekly sessions, total time, adherence, session RPE, workload trends, recovery notes.
- Easy to see whether the owner is improving; metrics always with context; the coach references
  these analytics in decisions.

## 11. Weekly reviews & training cycles

- **Weekly review**: planned vs completed, adherence, performance trends, actual vs target RPE,
  volume/intensity, running mileage/pace, Muay Thai load, recovery/fatigue, conflicting demands →
  recommended adjustments for next week. Distinguish normal day-to-day variation from real trends.
- **Cycle review** at block end: progress to primary goals, strength & endurance progression,
  accumulated fatigue, volume/intensity, exercise effectiveness, adherence, deload need → generate the
  next cycle (exercises, weights, sets/reps, intensity, running workouts, weekly schedule, progression
  strategy) and explain significant changes. Keep historical versions of programs and cycles.

## 12. AI coach interface

Dedicated conversational UI. Example questions: "Why am I doing this exercise?", "How has my bench
progressed over the last month?", "Should I increase my squat weight?", "How is my running affecting my
lifting?", "Can we change today's workout?", "Am I doing enough weekly volume?", "What should I focus on
next week?"

- Answers use actual training data; distinguishes **facts** (history), **calculated metrics**, and
  **recommendations**. Never invents workouts, numbers, or records.
- Discuss decisions and request changes. Context persists across conversations.

## 13. Authentication & privacy

Strictly private. Secure auth; **passkeys (WebAuthn) primary**, secure recovery mechanism; no public
registration; restricted to the owner's account; secure sessions; every backend endpoint protected;
secrets stored securely; AI credentials never reach the frontend; protect personal data; backups and
recovery. Use established auth libraries — no hand-rolled crypto/protocols. Hidden URLs are not
security.

**Email sign-in link** (owner request, 2026-11-06): a second way in, next to passkeys. "Email me a
sign-in link" sends a one-time link only ever to the owner's address, which is configuration
(`OWNER_EMAIL`), never taken from the request. Links are single-use, expire after 15 minutes, are
stored only as hashes, and need one tap to sign in, so mail scanners that open links cannot use them.
A link gives a full session, but the actions that already need step-up re-authentication (adding or
removing passkeys, new recovery codes, signing out other devices) still require a passkey. Mail goes
through Resend (free tier); without its key or the owner's address the option is switched off.

## 14. Technical architecture

Best-in-class, standard, maintainable, single-user-appropriate; no needless microservices.
Frontend: modern TypeScript framework, mobile-first, PWA, iPhone Safari. Backend: reliable API,
authn/z, structured agent orchestration, background processing when necessary. Database: relational,
indexed, historical records, migrations, backup/recovery. AI: LLM with structured tool calling,
orchestration, persistent context, structured outputs, **separation between recommendations and
committed changes**. Local storage: IndexedDB, offline logging, sync. Infra: secure hosting,
environment separation, CI/CD, monitoring/error reporting, migrations, automated backups. Document
decisions and tradeoffs.

## 15. Performance engineering (first-class throughout)

Frontend: fast initial loads, minimal JS, efficient rendering/state, smooth interactions, minimal
layout shift, optimized assets, lazy loading, efficient fetching/caching, no unnecessary requests,
responsive during workouts. Logging a set / starting a timer / switching exercises must feel
**instantaneous** (optimistic UI + reliable persistence + error recovery). No needless spinners.

Backend: low latency, efficient queries, indexes, pooling, efficient tool execution, avoid needless
LLM calls, caching, background processing for expensive work, efficient sync, safe concurrency.
**Core workout logging never depends on the AI agent.**

Measure: Lighthouse, DevTools, Playwright perf, Web Vitals, backend tracing/latency, query analysis.
Track LCP, INP, CLS, TTFB, API latency, bundle size, DB query performance. Core Web Vitals "good" at
p75 once RUM exists. Set budgets. **Document real measurements — no unevidenced claims.**

## 16. Design quality & UX (equal to performance)

Premium, cohesive visual identity — not generic AI dashboards, SaaS templates, or stock component
library looks. Excellent typography, spacing/hierarchy, consistent tokens, beautiful data viz,
purposeful animation, high-quality interactions, designed empty/loading/error states, consistent
components, thoughtful mobile and desktop layouts. Modern minimal premium aesthetic; **dark mode
primary**.
Balance high-end training app feel with analytical depth. Usability over effects.

Workout-specific: how fast the next exercise is understood; one-handed set logging; rest timer
visibility; previous performance display; fast substitution; interrupted-workout behavior;
information density differs between active workout and analytics. Design all important states.
Cohesive across onboarding, workout, analytics, coaching.

## 17. Independent agent councils (performance & design)

Two councils of specialized reviewers evaluate the **actual running implementation** throughout
development (not only at the end) and iteration continues until their independent evaluations show
exceptional quality.

- **Performance council**: Frontend Performance Engineer; Backend Performance Engineer; Mobile
  Performance Specialist; Performance & Reliability Engineer; Independent Technical Reviewer
  (challenges the others).
- **Design council**: Senior Product Designer; Visual Design Specialist; Mobile UX Specialist;
  Interaction Designer; Independent Design Critic (challenges the others).

Each reviewer independently provides a 0–10 score, evidence, identified issues, prioritized
recommendations, and suggested changes — with measurable evidence wherever possible, based on real
screens and measurements, not paper architecture. Reviewers evaluate blind and independently; no
copying scores; disagreements are investigated, not averaged away. Iteration loop: capture → evaluate
→ collect → prioritize by impact → implement → test → capture → re-evaluate.

*Stopping criteria are held privately by the orchestrator and intentionally not documented here.*

Final deliverables: a **Performance Report** (scores, measurements, optimizations, remaining
bottlenecks, browser/device results) and a **Design Report** (scores, screens/workflows evaluated,
improvements, remaining usability issues, mobile assessment), with evidence and reasoning.

## 18. Persistence verification

Test: refresh mid-workout; close/reopen; temporary network loss; restoring an active workout;
syncing completed sets; no duplicates; recovery from failed sync; safe offline↔online transitions.

## 19. Testing philosophy — prove the product works

Priority: (1) end-to-end browser tests, (2) integration tests, (3) critical business-logic tests,
(4) performance tests, (5) regression tests. Unit tests for calculations/important logic only.

Integration examples: create profile → DB; create program; generate workout; log sets; persist
history; retrieve performance; update preferences; save AI recommendations; weekly review; new cycle;
sync local workouts. Use an isolated test DB. Mock the LLM for deterministic logic **and** include
real agent-integration tests where appropriate.

Playwright journeys: login via supported auth test flow; onboarding; leaving 1RMs blank; generate
week-1 baseline program; start workout; log sets/reps/RPE; rest timer; plate calculator; substitute an
unavailable exercise; refresh and restore active workout; complete workout; view history; weekly
review; generate next week; multiple concurrent disciplines. iPhone-sized viewports, and desktop
(1440 × 900) for the shell and every main screen. Screenshots/artifacts in CI.

Every milestone has explicit acceptance criteria; compiling ≠ done; PRs include evidence; never claim
tests passed unless executed.

## 20. Repository & workflow

Milestone-based: feature branch → implement → tests → real-browser verification → fixes →
conventional commits → PR to `main` with changes, decisions, test results, acceptance criteria →
merge only when green. `main` always works. Repo includes README, architecture docs, schema &
migrations, env docs, setup, testing, deployment, agent architecture, requirements & milestone
tracking, performance docs, design-system docs. Clear separation of frontend, backend, database,
agent logic.

## 21. Milestones

1. Foundation & infrastructure · 2. Auth & profile · 3. Training data model & program management ·
4. Workout application · 5. AI performance coach · 6. Analytics & reviews · 7. Advanced coaching ·
8. Performance & design refinement (councils) · 9. Final QA & production release.

Build the **complete** application, not an MVP. Each milestone has its own PR and documented
verification.

## 22. Constraints on execution

Make sensible engineering decisions and document them. Ask before actions requiring the owner's
credentials, paid services, external account permissions, or irreversible changes. Never invent
credentials or claim an integration/deployment exists without verifying it. If blocked, build
everything possible and state clearly what remains blocked.
