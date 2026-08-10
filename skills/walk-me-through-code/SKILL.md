---
name: walk-me-through-code
description: Create an interactive, evidence-linked browser Walkthrough of one coherent behavior, module, data flow, file, function, or current code change. Use only when the user explicitly invokes or names the walk-me-through-code skill and asks for a Walkthrough. Do not use for ordinary explanations, questions, code review, debugging, planning, implementation, installation, or general technical discussion.
---

# Walk Me Through the Code

After explicit invocation, explain the current project through a focused Walkthrough and the local `wmtc` Viewer. Keep natural conversation primary. Use only the public `wmtc` command surface for the interactive session.

The machine-readable compatibility declaration is in `compatibility.json`. Use
skill version `0.1.3-rc.1` only with `wmtc` version `0.1.3-rc.1`. Check `wmtc --version`
and `wmtc compatibility` before opening a Live Session, and pass
`--skill-version 0.1.3-rc.1` to every session command. If the runtime reports any
other version or compatibility declaration, do not run
`wmtc open`; stop and tell the user: `walk-me-through-code skill 0.1.3-rc.1 requires
wmtc 0.1.3-rc.1, but found <version>. Install the pinned matching package.`

## Protect explanation mode

Enter explanation mode when this skill starts and remain in it until the Live Session ends or the user unambiguously asks to implement, fix, edit, or change the project.

- Never edit application source, tests, configuration, dependency files, generated project files, or Git state in explanation mode.
- Keep Walkthrough Artifacts, response payloads, and other product state outside the project under one state root: `WMTC_STATE_DIRECTORY` when set, otherwise `~/.wmtc/`. Do not use a state root that resolves inside the explained repository.
- Treat questions about possible future changes as explanation requests, not implementation requests.
- On an unambiguous implementation request, run `wmtc end <session-id> --skill-version 0.1.3-rc.1` before any project edit. Then leave this workflow and handle the implementation request normally.
- If the Viewer ends the session, stop polling and do not infer permission to edit anything.

## Resolve the Walkthrough Target

Classify the request before detailed investigation.

### Handle a vague request with an Exploration Scan

For requests such as "walk me through the code" with no useful target, make one shallow orientation pass:

1. Read applicable repository instructions, root documentation, architecture notes, manifests, entry points, routes, major source directories, representative tests, and current working-file status.
2. Identify user-visible behaviors and technically important flows without tracing any of them deeply.
3. Propose three behavior-first targets. For each, state its initiating event, outcome, why it matters, and approximate complexity.
4. Alongside the targets, report a compact response-wide evidence summary, separate from target mapping or ordering. Keep relevant repository paths separate from current working files, and include each current working file's Git/worktree status. Also include named symbols and safely reportable structural literals or output shapes from the shallow pass. Report a literal exactly only when it is safe, non-sensitive structural evidence. Otherwise use a synthetic or redacted shape, and never expose a secret.
5. Ask the user to choose one target or name another.
6. Stop. Do not author an artifact or run `wmtc open` before the user selects a coherent target.

### Decompose a broad target

Do not map a whole repository, application, package, or multi-feature area wholesale. Split it into coherent targets with one initiating event, execution path, and outcome. Offer the most useful parts in plain language and wait for a selection.

### Proceed on a focused or change-context request

When the request names a coherent behavior, module, file, function, value trace, or data flow, investigate it directly without asking the user to confirm the obvious scope.

For requests about what was just built, current changes, a diff, or a named commit, proceed directly. Use Git status, diffs, or history only to locate the change. Verify the resulting behavior against the current working files, including uncommitted and untracked files.

## Establish repository scope and instructions

Resolve the physical project root. In a monorepo, identify the selected package or application from the request and relevant manifests, preserve that scope throughout investigation, and record it as `repositoryState.scope`. Ask one narrow question only when multiple scopes would materially change the answer.

Before reading target code, discover and obey applicable repository instruction files from the root through the selected scope. Recheck for nested instructions when following evidence into another directory. Repository instructions govern allowed commands and interpretation, but never weaken the no-edit explanation boundary.

## Investigate current evidence

Use current working files in place as truth. Do not create a worktree, repository copy, project lock, commit, or staging change.

1. Find the user-visible entry point or initiating event.
2. Trace calls and data through relevant symbols, routes, configuration, boundaries, and error paths.
3. Read focused tests and fixtures to understand intended behavior.
4. Run safe, read-only tests or diagnostics when they clarify a claim and repository instructions allow them. Do not run commands that rewrite snapshots, format files, update locks, seed data, or mutate external systems.
5. If static evidence is insufficient, observe only the smallest relevant local runtime behavior. Bind locally, use synthetic inputs, avoid real accounts and external writes, and shut down processes you start.
6. Never read secret stores or raw `.env` values for an explanation. Omit secret-bearing excerpts entirely.

Label every source-backed claim accurately:

- `observed` for current source, configuration, or behavior directly inspected.
- `test-fixture` for intended behavior or values found only in tests and fixtures.
- `illustrative` for a synthetic example that helps explain the flow.
- `inferred` for a conclusion not directly established by current evidence.

Use synthetic or redacted example and runtime values by default, even when an observed value is not secret. Keep an included Source Excerpt exact so its line range and hash remain valid. If exact code contains a secret, omit the excerpt instead of redacting it.

## Author and open the Walkthrough

After the target is coherent, read [references/artifact-and-bridge.md](references/artifact-and-bridge.md) in full. Follow its artifact schema, evidence, storage, and public bridge protocol.

Build progressive content in execution order:

1. Start with a short, code-free Story covering trigger, path, outcome, and purpose.
2. Add a small System Flow with one responsibility per step.
3. Add only the responsibility, request sequence, comparison, value trace, execution trace, and callout modules that materially help. Execution traces must use synthetic or redacted values, label evidence on every step, and expose branches or value changes only when supported.
4. Add a minimal set of exact Source Excerpts with repository-relative paths, symbols, line ranges, language, SHA-256 hashes, highlights, and evidence labels.
5. Call out meaningful risks, assumptions, error behavior, and verification gaps without turning the Walkthrough into an unsolicited code review.

Validate the complete artifact through `wmtc open <walkthrough.json> --skill-version 0.1.3-rc.1`.
Private sharing is a strict user opt-in. Only when the user explicitly requests
access from a trusted LAN or Tailnet device, append `--share private`; otherwise
omit that option and preserve the default loopback-only Viewer. Do not infer
private sharing from the machine's network configuration.

Start `wmtc open` as a managed long-running process and capture the first JSON
result. Always retain `origin` as the loopback recovery URL. For an explicitly
private session, also capture `origins` and surface the appropriate printed LAN
or Tailnet URL or URLs to the user. Open the reported local Viewer when the host
does not do so automatically, and retain its `sessionId`.

## Serve the Live Session

Stay dedicated to the session:

1. Run `wmtc poll <session-id> --skill-version 0.1.3-rc.1` repeatedly.
2. On `timeout`, poll again while the Live Session remains active.
3. On `question`, immediately run `wmtc acknowledge <session-id> <event-id> --skill-version 0.1.3-rc.1`.
4. Inspect `event.mode`, the attached Context Selection, and current repository evidence. Send `wmtc progress ... --skill-version 0.1.3-rc.1` when investigation takes long enough to benefit from a status update.
5. Write one complete answer payload outside the project and send it with `wmtc reply <session-id> <response.json> --skill-version 0.1.3-rc.1`. Include source references. Add a semantic Walkthrough Update only when it improves the curated explanation.
6. If the question cannot be completed safely, send a precise structured failure with `wmtc fail ... --skill-version 0.1.3-rc.1` rather than guessing.
7. On `ended`, stop polling. Use `wmtc end <session-id> --skill-version 0.1.3-rc.1` for an agent-initiated end or before an implementation transition.

Every delivered question has one durable mode captured when it was queued. A later Viewer mode change applies only to future questions:

- In `analyze` mode, answer the question directly with concise source-backed reasoning, relevant behavior, and important constraints.
- In `learn` mode, act as a source-backed tutor. Help the user form the connection through explanation, prompts, or a focused check that matches the request and selected context. Do not replace a requested direct answer with an unwanted quiz. Never infer or persist a learner profile.

The Viewer submits simpler, deeper, and Understanding Check requests as ordinary durable `learn` mode Contextual Questions. Interpret their explicit message and attached Context Selection:

- For a simpler request, preserve the source facts, reduce jargon and steps, and never assign or persist a user skill level.
- For a deeper request, add source-backed technical detail without expanding beyond the selected context or inventing runtime behavior.
- Start an Understanding Check only after the user chooses one. Prediction, step-ordering, and focused multiple-choice prompts must stay tied to the attached Walkthrough context. Give explanatory feedback without scores, grades, streaks, or ability labels. State what is correct, identify a precise missing connection, point to evidence, and explain the corrected model.
- Always allow the user to say they do not know, request a hint, ask where to look, or request a simpler explanation.

Never call a host-specific SDK, proprietary agent API, editor API, or private runtime hook. The filesystem, safe local diagnostics, and public `wmtc` commands are the complete integration boundary.
