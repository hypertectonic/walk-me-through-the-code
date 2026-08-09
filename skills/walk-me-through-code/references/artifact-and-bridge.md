# Artifact and public bridge contract

Read this reference only after a coherent Walkthrough Target has been selected.

## Contents

- Artifact location and repository state
- Artifact shape
- Explanation Module rules
- Source Evidence rules
- Public `wmtc` workflow
- Structured response shapes
- Walkthrough Update contract

## Artifact location and repository state

Use one product state root for every product-owned file: `WMTC_STATE_DIRECTORY`
when set, otherwise `~/.wmtc/`. The state root must remain outside the selected
project and must not resolve inside it through a symbolic link. Create each
Walkthrough Artifact with a collision-resistant filename below
`<state-root>/walkthroughs/`. Do not store conversation or delivery state in
the artifact because the runtime owns that state in SQLite.

Set `repositoryState.root` to the absolute, physical selected project root. For a Git monorepo, use the Git top-level directory as `root` and record the repository-relative selected package or application in `scope`. Use forward slashes in repository-relative paths. Set `generatedAt` to an ISO 8601 timestamp. Include `gitCommit` and `hasUncommittedChanges` only as descriptive metadata, never as a substitute for reading current files.

## Artifact shape

Author version 1 JSON with this top-level shape:

```json
{
  "schemaVersion": 1,
  "id": "stable-walkthrough-id",
  "revision": 0,
  "title": "How the selected behavior works",
  "repositoryState": {
    "root": "/absolute/physical/project/root",
    "scope": "packages/selected-app",
    "generatedAt": "2026-07-21T12:00:00.000Z",
    "gitCommit": "optional-current-commit",
    "hasUncommittedChanges": true
  },
  "sections": []
}
```

Omit optional fields instead of using `null`. Use unique, stable lowercase IDs. Explanatory prose supports Restricted Markdown only. Never provide raw HTML, CSS, JavaScript, iframes, remote embeds, or layout instructions.

## Explanation Module rules

Use only these module types:

- `story`: require `trigger`, `path`, `outcome`, and `purpose`.
- `systemFlow`: require one or more `nodes`; each node requires `id`, `label`, and `responsibility`, and may link a source reference and previous or next node IDs.
- `responsibility`: require `responsibility`, `excludes`, `inputs`, `outputs`, and `calledBy`; optionally add a source reference.
- `sourceExcerpt`: follow the exact Source Evidence rules below.
- `requestSequence`: require ordered `steps` with `id`, `actor`, `action`, and `result`; optionally add a source reference per step.
- `comparison`: require `leftLabel`, `left`, `rightLabel`, and `right`; optionally add `conclusion`.
- `valueTrace`: require ordered `steps` with `id`, `label`, and `value`; optionally add a source reference per step.
- `executionTrace`: require `summary` and one or more ordered `steps`; each step requires `id`, `label`, `action`, and `evidenceLabel` as `observed`, `test-fixture`, `illustrative`, or `inferred`. A step may add `sourceEvidence`, `branch`, or `detail`. Include `valueBefore` and `valueAfter` together or omit both.
- `callout`: require `tone` as `info`, `risk`, `assumption`, or `edge-case`, plus `content`; optionally add a source reference.

Keep the Story first and keep the flow small. Include modules because they clarify the selected behavior, not to exercise every available type.

A lightweight source reference accepts `file`, optional `symbol`, and either `line` or the `startLine` and `endLine` pair. Never combine `line` with a range.

## Source Evidence rules

Each `sourceExcerpt` requires:

```json
{
  "id": "stable-excerpt-id",
  "type": "sourceExcerpt",
  "title": "What this exact code establishes",
  "evidenceLabel": "observed",
  "sourceEvidence": {
    "file": "src/relative-file.ts",
    "symbol": "relevantSymbol",
    "startLine": 10,
    "endLine": 13,
    "language": "typescript",
    "contentHash": "sha256:hex-digest-of-exact-code"
  },
  "code": "exact lines 10 through 13",
  "explanation": "Why this code matters in the flow.",
  "inputs": "What enters this code.",
  "output": "What leaves or happens next.",
  "selectionReason": "Why these lines are the smallest useful excerpt.",
  "highlights": [
    {
      "id": "stable-highlight-id",
      "startLine": 11,
      "endLine": 12,
      "label": "The important transition happens here."
    }
  ],
  "relatedIds": ["an-existing-module-or-node-id"]
}
```

The `code` field must be the exact UTF-8 text for the inclusive line range. Its line count must equal `endLine - startLine + 1`. Compute `contentHash` as `sha256:` followed by the lowercase SHA-256 digest of the exact `code` string. Highlights must stay within the excerpt range. Related IDs must already exist in the artifact.

Use `observed`, `test-fixture`, `illustrative`, or `inferred` as the evidence label. Keep observed Source Excerpts exact. Use synthetic or redacted values in explanatory examples and runtime observations. Omit any excerpt containing a secret.

## Public `wmtc` workflow

Use skill version `0.1.2` with runtime version `0.1.2`. Run all commands with the selected project as the working directory so repository identity remains consistent.

1. Check `wmtc --version` and `wmtc compatibility`.
2. Start `wmtc open <walkthrough.json> --skill-version 0.1.2` as a managed
   long-running process. This default command must remain loopback-only. Only
   when the user explicitly requests access from a trusted LAN or Tailnet
   device, append `--share private`. Never infer that opt-in from available
   interfaces. The first output is one JSON object with `status` set to
   `"viewer_open"` plus `sessionId`, `artifactId`, `revision`, `origin`, and
   `origins`. Retain `origin` as the loopback recovery URL. For an explicitly
   private session, capture `origins` and surface the appropriate printed LAN or
   Tailnet URL or URLs to the user.
3. Poll with `wmtc poll <session-id> --skill-version 0.1.2` until it reports `question`, `timeout`, or `ended`. A question result includes the mode captured when the Viewer queued it:

   ```json
   {
     "status": "question",
     "event": {
       "schemaVersion": 1,
       "type": "question",
       "eventId": "question-id",
       "sessionId": "session-id",
       "artifactRevision": 0,
       "mode": "learn",
       "message": "Help me reason through this path.",
       "createdAt": "2026-07-21T12:04:00.000Z"
     }
   }
   ```

   Treat `analyze` as a request for a direct source-backed explanation. Treat `learn` as a request for source-backed tutoring. The mode belongs to this question and does not change if the Viewer later switches modes.
4. Acknowledge a delivered question with `wmtc acknowledge <session-id> <event-id> --skill-version 0.1.2` before investigating it.
5. Optionally report progress with `wmtc progress <session-id> <event-id> <status.json> --skill-version 0.1.2`.
6. Send one complete answer with `wmtc reply <session-id> <response.json> --skill-version 0.1.2` or a terminal error with `wmtc fail <session-id> <event-id> <error.json> --skill-version 0.1.2`.
7. If an answer's semantic update has only a revision mismatch, preserve its operation set, update only `expectedRevision`, and use `wmtc retry-update <session-id> <update.json> --skill-version 0.1.2`.
8. Use `wmtc end <session-id> --skill-version 0.1.2` to end the session. Treat repeated end, acknowledgement, answer, or failure results as successful when the existing payload matches.

Never shell-encode long structured content as command arguments. Write JSON
payload files under the same `<state-root>/` and pass their paths.

## Structured response shapes

Progress payload:

```json
{
  "schemaVersion": 1,
  "eventId": "event-id-from-poll",
  "sessionId": "session-id-from-open",
  "status": "investigating",
  "message": "Tracing the selected value through its validation boundary.",
  "updatedAt": "2026-07-21T12:05:00.000Z"
}
```

Answer payload:

```json
{
  "schemaVersion": 1,
  "eventId": "event-id-from-poll",
  "type": "answer",
  "content": "A complete evidence-backed answer in Restricted Markdown.",
  "references": [
    {
      "file": "src/relative-file.ts",
      "symbol": "relevantSymbol",
      "startLine": 10,
      "endLine": 13
    }
  ],
  "walkthroughUpdate": {
    "schemaVersion": 1,
    "id": "correct-validation-explanation",
    "eventId": "event-id-from-poll",
    "expectedRevision": 0,
    "operations": [
      {
        "type": "replace",
        "targetId": "validation-callout",
        "module": {
          "id": "validation-callout",
          "type": "callout",
          "tone": "info",
          "content": "Validation happens before the value enters the queue."
        }
      }
    ]
  }
}
```

Omit `walkthroughUpdate` when the answer does not need a visual correction or addition.

Failure payload:

```json
{
  "schemaVersion": 1,
  "eventId": "event-id-from-poll",
  "type": "error",
  "code": "EVIDENCE_UNAVAILABLE",
  "content": "The requested claim cannot be verified safely from current local evidence."
}
```

## Walkthrough Update contract

When an answer needs a visual correction or addition, include a complete `walkthroughUpdate` object in the answer. The same object is the standalone payload accepted by `wmtc retry-update`:

```json
{
  "schemaVersion": 1,
  "id": "correct-validation-explanation",
  "eventId": "event-id-from-poll",
  "expectedRevision": 0,
  "operations": [
    {
      "type": "replace",
      "targetId": "validation-callout",
      "module": {
        "id": "validation-callout",
        "type": "callout",
        "tone": "info",
        "content": "Validation happens before the value enters the queue."
      }
    }
  ]
}
```

Every update requires all five top-level fields:

- `schemaVersion`: the number `1`.
- `id`: a stable lowercase ID for this update.
- `eventId`: exactly the question event ID returned by `wmtc poll`.
- `expectedRevision`: the non-negative artifact revision attached to that question.
- `operations`: a non-empty array of semantic operations.

Use only the following strict operation shapes. A `module` is one complete Explanation Module in one of the shapes documented above. Do not add fields that are not listed.

- Add: `{ "type": "add", "module": <complete-module>, "afterId": "existing-module-id" }`. `afterId` is optional. Omit it to append the module. The new module ID must not already exist.
- Replace: `{ "type": "replace", "targetId": "existing-module-id", "module": <complete-module> }`. The replacement `module.id` must equal `targetId`, preserving the stable ID.
- Move: `{ "type": "move", "targetId": "existing-module-id", "afterId": "other-existing-module-id" }`. `afterId` is required but may be `null` to move the target to the beginning. It must not equal `targetId`.
- Annotate: `{ "type": "annotate", "targetId": "existing-module-id", "annotation": { "id": "stable-annotation-id", "content": "Restricted Markdown explanation." } }`.
- Remove: `{ "type": "remove", "targetId": "existing-module-id" }`.

These are complete schema-valid examples of all five operation shapes:

```json
[
  {
    "type": "add",
    "module": {
      "id": "queue-note",
      "type": "callout",
      "tone": "info",
      "content": "The queue uses a synthetic example value."
    },
    "afterId": "validation-callout"
  },
  {
    "type": "replace",
    "targetId": "validation-callout",
    "module": {
      "id": "validation-callout",
      "type": "callout",
      "tone": "info",
      "content": "Validation happens before the value enters the queue."
    }
  },
  {
    "type": "move",
    "targetId": "queue-note",
    "afterId": null
  },
  {
    "type": "annotate",
    "targetId": "validation-callout",
    "annotation": {
      "id": "validation-detail",
      "content": "Observed in the current validation boundary."
    }
  },
  {
    "type": "remove",
    "targetId": "obsolete-callout"
  }
]
```

Operations run in array order against the result of the preceding operation. Refer only to IDs that exist at that point. A single invalid operation rejects the complete operation set.

If `wmtc reply` reports only `revision_mismatch`, copy the original nested `walkthroughUpdate` to a standalone JSON file, change only `expectedRevision` to the reported `currentRevision`, and run `wmtc retry-update <session-id> <update.json> --skill-version 0.1.2`. Keep `schemaVersion`, `id`, `eventId`, and the complete `operations` array byte-for-byte equivalent as JSON values. Do not resend or alter the answer payload. Do not retry a non-revision validation failure.
