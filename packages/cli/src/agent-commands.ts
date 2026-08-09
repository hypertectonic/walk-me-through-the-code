import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  AnswerResponseSchema,
  applyWalkthroughUpdate,
  ErrorResponseSchema,
  ProgressStatusSchema,
  RevisionMismatchError,
  StableIdSchema,
  WalkthroughArtifactSchema,
  WalkthroughUpdateSchema,
  type WalkthroughArtifact,
  type WalkthroughUpdate,
} from "@walk-me-through-code/contracts";

import {
  SqliteSessionStore,
  SessionStoreConflictError,
  SessionStoreStateError,
  type JsonValue,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStore,
} from "./session/index.js";

const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const POLL_INTERVAL_MS = 100;
const MAX_STRUCTURED_FILE_BYTES = 1_048_576;

export interface AgentCommandResult {
  readonly [key: string]: unknown;
  readonly ok: boolean;
  readonly status: string;
}

export class AgentCommandInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AgentCommandInputError";
  }
}

function commandId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString("hex")}`;
}

function progressId(input: unknown): string {
  return `status-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32)}`;
}

function requireArguments(command: string, arguments_: readonly string[], count: number, usage: string): void {
  if (arguments_.length !== count) {
    throw new AgentCommandInputError(`Usage: wmtc ${command} ${usage}`.trim());
  }
}

function requireStableId(value: string | undefined, label: string): string {
  const parsed = StableIdSchema.safeParse(value);
  if (!parsed.success) throw new AgentCommandInputError(`${label} must be a stable lowercase ID`);
  return parsed.data;
}

function environmentMilliseconds(name: string, fallback: number, minimum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new AgentCommandInputError(`${name} must be an integer of at least ${minimum} milliseconds`);
  }
  return parsed;
}

function timestampAfter(snapshot: SessionSnapshot): string {
  const latest = snapshot.events.at(-1)?.occurredAt ?? snapshot.session.updatedAt;
  return new Date(Math.max(Date.now(), Date.parse(latest) + 1)).toISOString();
}

function requireSession(store: SessionStore, sessionId: string): SessionRecord {
  const session = store.getSession(sessionId);
  if (session === undefined) throw new SessionStoreStateError(`Session ${sessionId} does not exist`);
  return session;
}

function requireSnapshot(store: SessionStore, sessionId: string): SessionSnapshot {
  const snapshot = store.getSnapshot(sessionId);
  if (snapshot === undefined) throw new SessionStoreStateError(`Session ${sessionId} does not exist`);
  return snapshot;
}

async function structuredFile(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new AgentCommandInputError(`Cannot read structured file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(source) > MAX_STRUCTURED_FILE_BYTES) {
    throw new AgentCommandInputError(`Structured file ${path} exceeds 1 MiB`);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new AgentCommandInputError(`Structured file ${path} must contain valid JSON`);
  }
}

function validationMessage(label: string, issues: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[]): string {
  const details = issues.map((issue) => {
    const path = issue.path.length === 0 ? "$" : `$.${issue.path.map(String).join(".")}`;
    return `${path}: ${issue.message}`;
  }).join("; ");
  return `${label} is invalid: ${details}`;
}

function ensureListening(store: SessionStore, sessionId: string): SessionRecord {
  let session = requireSession(store, sessionId);
  if (session.state === "created") {
    throw new SessionStoreStateError(`Session ${sessionId} has no open Viewer`);
  }
  if (session.state === "ending" || session.state === "ended") return session;
  if (session.state === "active") {
    throw new SessionStoreStateError(
      `Session ${sessionId} is active; complete the acknowledged question before polling again`,
    );
  }
  if (session.state === "viewer_open" || session.state === "interrupted") {
    const snapshot = requireSnapshot(store, sessionId);
    session = store.transitionSession({
      sessionId,
      eventId: commandId("agent-listening"),
      to: "agent_listening",
      occurredAt: timestampAfter(snapshot),
    }).record;
  }
  return session;
}

async function poll(store: SessionStore, arguments_: readonly string[]): Promise<AgentCommandResult> {
  requireArguments("poll", arguments_, 1, "<session-id>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const initial = ensureListening(store, sessionId);
  if (initial.state === "ending" || initial.state === "ended") {
    return { ok: true, status: "ended", sessionId };
  }

  const timeoutMs = environmentMilliseconds("WMTC_POLL_TIMEOUT_MS", DEFAULT_POLL_TIMEOUT_MS, 0);
  const leaseDurationMs = environmentMilliseconds(
    "WMTC_LEASE_DURATION_MS",
    DEFAULT_LEASE_DURATION_MS,
    1_000,
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = requireSnapshot(store, sessionId);
    if (snapshot.session.state === "ending" || snapshot.session.state === "ended") {
      return { ok: true, status: "ended", sessionId };
    }
    const leasedAt = timestampAfter(snapshot);
    const attempt = store.transaction((transaction) => {
      const session = requireSession(transaction, sessionId);
      if (session.state === "ending" || session.state === "ended") {
        return { ended: true, lease: undefined } as const;
      }
      if (session.state !== "agent_listening") {
        throw new SessionStoreStateError(
          `Session ${sessionId} is ${session.state}; complete the acknowledged question before polling again`,
        );
      }
      return {
        ended: false,
        lease: transaction.leaseNextQuestion({
          id: commandId("lease"),
          sessionId,
          leasedAt,
          expiresAt: new Date(Date.parse(leasedAt) + leaseDurationMs).toISOString(),
        }),
      } as const;
    });
    if (attempt.ended) return { ok: true, status: "ended", sessionId };
    const lease = attempt.lease;
    if (lease !== undefined) {
      const delivered = requireSnapshot(store, sessionId).questions.find(
        ({ id }) => id === lease.record.questionId,
      );
      if (delivered === undefined) {
        throw new SessionStoreStateError(`Leased question ${lease.record.questionId} does not exist`);
      }
      return {
        ok: true,
        status: "question",
        sessionId,
        lease: lease.record,
        event: {
          schemaVersion: 1,
          type: "question",
          eventId: delivered.id,
          sessionId: delivered.sessionId,
          artifactRevision: delivered.artifactRevision,
          createdAt: delivered.createdAt,
          mode: delivered.mode,
          message: delivered.message,
          ...(delivered.context === null ? {} : { contextSelection: delivered.context }),
        },
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
  }

  return { ok: true, status: "timeout", sessionId, retryAfterMs: POLL_INTERVAL_MS };
}

function acknowledge(store: SessionStore, arguments_: readonly string[]): AgentCommandResult {
  requireArguments("acknowledge", arguments_, 2, "<session-id> <event-id>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const eventId = requireStableId(arguments_[1], "Event ID");
  return store.transaction((transaction) => {
    const snapshot = requireSnapshot(transaction, sessionId);
    const existing = snapshot.acknowledgements.find(({ questionId }) => questionId === eventId);
    if (existing !== undefined) {
      return {
        ok: true,
        status: "acknowledged",
        created: false,
        sessionId,
        eventId,
        acknowledgement: existing,
      };
    }
    const question = snapshot.questions.find(({ id }) => id === eventId);
    if (question === undefined) {
      throw new SessionStoreStateError(`Event ${eventId} does not exist in session ${sessionId}`);
    }
    if (question.currentLeaseId === null) {
      throw new SessionStoreStateError(`Event ${eventId} does not have a current delivery lease`);
    }
    const occurredAt = timestampAfter(snapshot);
    const result = transaction.acknowledgeQuestion({
      id: eventId,
      sessionId,
      questionId: eventId,
      leaseId: question.currentLeaseId,
      acknowledgedAt: occurredAt,
    });
    const session = requireSession(transaction, sessionId);
    if (session.state === "agent_listening") {
      transaction.transitionSession({
        sessionId,
        eventId: commandId("agent-active"),
        to: "active",
        occurredAt,
      });
    }
    return {
      ok: true,
      status: "acknowledged",
      created: result.created,
      sessionId,
      eventId,
      acknowledgement: result.record,
    };
  });
}

async function progress(store: SessionStore, arguments_: readonly string[]): Promise<AgentCommandResult> {
  requireArguments("progress", arguments_, 3, "<session-id> <event-id> <status.json>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const eventId = requireStableId(arguments_[1], "Event ID");
  const parsed = ProgressStatusSchema.safeParse(await structuredFile(arguments_[2] ?? ""));
  if (!parsed.success) throw new AgentCommandInputError(validationMessage("Progress status", parsed.error.issues));
  if (parsed.data.sessionId !== sessionId || parsed.data.eventId !== eventId) {
    throw new AgentCommandInputError("Progress status sessionId and eventId must match the command arguments");
  }
  const detail: JsonValue | null = parsed.data.message === undefined ? null : { message: parsed.data.message };
  const result = store.recordStatus({
    id: progressId(parsed.data),
    sessionId,
    questionId: eventId,
    status: parsed.data.status,
    detail,
    createdAt: parsed.data.updatedAt,
  });
  return { ok: true, status: "progress_recorded", created: result.created, sessionId, eventId, progress: result.record };
}

function existingTerminalResult(
  store: SessionStore,
  sessionId: string,
  eventId: string,
  outcome: "answer" | "failure",
  content: JsonValue,
): AgentCommandResult | undefined {
  const existing = requireSnapshot(store, sessionId).replies.find(({ questionId }) => questionId === eventId);
  if (existing === undefined) return undefined;
  if (existing.id !== eventId || existing.outcome !== outcome || !isDeepStrictEqual(existing.content, content)) {
    throw new SessionStoreConflictError(
      `Event ${eventId} already has a different terminal reply and cannot be replaced`,
    );
  }
  return {
    ok: true,
    status: outcome === "answer" ? "answered" : "failed",
    created: false,
    sessionId,
    eventId,
    reply: existing,
  };
}

function recordTerminalReply(
  store: SessionStore,
  sessionId: string,
  eventId: string,
  outcome: "answer" | "failure",
  content: JsonValue,
): AgentCommandResult {
  return store.transaction((transaction) => {
    const existing = existingTerminalResult(transaction, sessionId, eventId, outcome, content);
    if (existing !== undefined) return existing;
    const snapshot = requireSnapshot(transaction, sessionId);
    const createdAt = timestampAfter(snapshot);
    const result = transaction.recordReply({
      id: eventId,
      sessionId,
      questionId: eventId,
      outcome,
      content,
      createdAt,
    });
    const session = requireSession(transaction, sessionId);
    if (session.state === "active") {
      transaction.transitionSession({
        sessionId,
        eventId: commandId("agent-listening"),
        to: "agent_listening",
        occurredAt: createdAt,
      });
    }
    return {
      ok: true,
      status: outcome === "answer" ? "answered" : "failed",
      created: result.created,
      sessionId,
      eventId,
      reply: result.record,
    };
  });
}

function sameUpdateExceptExpectedRevision(
  previous: WalkthroughUpdate,
  next: WalkthroughUpdate,
): boolean {
  return isDeepStrictEqual(
    { ...previous, expectedRevision: 0 },
    { ...next, expectedRevision: 0 },
  );
}

function jsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insertionIndex(ids: readonly string[], afterId: string | null | undefined): number {
  if (afterId === null) return 0;
  if (afterId === undefined) return ids.length;
  return ids.indexOf(afterId) + 1;
}

function changedIdsForAppliedUpdate(
  artifact: WalkthroughArtifact,
  updatedArtifact: WalkthroughArtifact,
  update: WalkthroughUpdate,
): readonly string[] {
  const workingIds = artifact.sections.map(({ id }) => id);
  const directlyChangedIds: string[] = [];
  const removedAnchors: { readonly candidates: readonly string[]; readonly index: number }[] = [];

  for (const operation of update.operations) {
    switch (operation.type) {
      case "add": {
        workingIds.splice(insertionIndex(workingIds, operation.afterId), 0, operation.module.id);
        directlyChangedIds.push(operation.module.id);
        break;
      }
      case "move": {
        const sourceIndex = workingIds.indexOf(operation.targetId);
        workingIds.splice(sourceIndex, 1);
        workingIds.splice(insertionIndex(workingIds, operation.afterId), 0, operation.targetId);
        directlyChangedIds.push(operation.targetId);
        break;
      }
      case "remove": {
        const removedIndex = workingIds.indexOf(operation.targetId);
        workingIds.splice(removedIndex, 1);
        removedAnchors.push({
          candidates: [
            ...workingIds.slice(removedIndex),
            ...workingIds.slice(0, removedIndex).reverse(),
          ],
          index: removedIndex,
        });
        break;
      }
      case "annotate":
      case "replace":
        directlyChangedIds.push(operation.targetId);
        break;
    }
  }

  const finalIds: string[] = updatedArtifact.sections.map(({ id }) => id);
  const finalIdSet = new Set<string>(finalIds);
  const removalMarkerIds = removedAnchors.flatMap(({ candidates, index }) => {
    const adjacentId = candidates.find((id) => finalIdSet.has(id));
    const fallbackId = finalIds[Math.min(index, finalIds.length - 1)];
    return adjacentId ?? fallbackId ?? [];
  });
  return [...new Set([
    ...directlyChangedIds.filter((id) => finalIdSet.has(id)),
    ...removalMarkerIds,
  ])];
}

async function reply(store: SessionStore, arguments_: readonly string[]): Promise<AgentCommandResult> {
  requireArguments("reply", arguments_, 2, "<session-id> <response.json>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const parsed = AnswerResponseSchema.safeParse(await structuredFile(arguments_[1] ?? ""));
  if (!parsed.success) throw new AgentCommandInputError(validationMessage("Answer response", parsed.error.issues));
  const answer = parsed.data;
  const update = answer.walkthroughUpdate;
  if (update === undefined) {
    return recordTerminalReply(store, sessionId, answer.eventId, "answer", answer as JsonValue);
  }
  return store.transaction((transaction) => {
    const snapshot = requireSnapshot(transaction, sessionId);
    const existing = snapshot.replies.find(({ questionId }) => questionId === answer.eventId);
    const previousOutcomeRecord = snapshot.walkthroughUpdateOutcomes.find(
      ({ questionId }) => questionId === answer.eventId,
    );
    const previousOutcome = previousOutcomeRecord?.outcome;
    if (existing !== undefined && isDeepStrictEqual(existing.content, answer)) {
      const previousError = jsonObject(previousOutcome) && jsonObject(previousOutcome.error)
        ? previousOutcome.error
        : undefined;
      if (
        jsonObject(previousOutcome) &&
        previousOutcome.status === "rejected" &&
        previousError !== undefined
      ) {
        return {
          ok: false,
          status: previousError.code === "REVISION_MISMATCH" ? "revision_mismatch" : "invalid_update",
          sessionId,
          eventId: answer.eventId,
          error: previousError,
        };
      }
      return { ok: true, status: "answered", created: false, sessionId, eventId: answer.eventId, reply: existing };
    }
    if (existing !== undefined) {
      throw new SessionStoreConflictError(
        `Event ${answer.eventId} already has a different terminal reply and cannot be replaced`,
      );
    }
    const state = snapshot.walkthroughState;
    if (state === undefined) throw new SessionStoreStateError("Walkthrough state is not initialized");
    const occurredAt = timestampAfter(snapshot);
    const replyInput = {
      id: answer.eventId,
      sessionId,
      questionId: answer.eventId,
      outcome: "answer" as const,
      content: answer as JsonValue,
      createdAt: occurredAt,
    };
    let artifact: WalkthroughArtifact;
    let updatedArtifact: WalkthroughArtifact;
    try {
      artifact = WalkthroughArtifactSchema.parse(state.artifact);
      updatedArtifact = applyWalkthroughUpdate(artifact, update);
    } catch (error: unknown) {
      const mismatch = error instanceof RevisionMismatchError;
      const outcome = {
        error: {
          code: mismatch ? "REVISION_MISMATCH" : "INVALID_UPDATE",
          currentRevision: state.revision,
          expectedRevision: update.expectedRevision,
          message: error instanceof Error ? error.message : "The Walkthrough Update is invalid",
          recoverable: mismatch,
        },
        status: "rejected",
        updateId: update.id,
      } as const;
      const recorded = transaction.recordReply(replyInput);
      transaction.recordWalkthroughUpdateOutcome({
        eventId: progressId({ answer, outcome }),
        questionId: answer.eventId,
        sessionId,
        outcome,
        updatedAt: occurredAt,
      });
      const session = requireSession(transaction, sessionId);
      if (session.state === "active") {
        transaction.transitionSession({
          sessionId,
          eventId: commandId("agent-listening"),
          to: "agent_listening",
          occurredAt,
        });
      }
      return {
        ok: false,
        status: mismatch ? "revision_mismatch" : "invalid_update",
        created: recorded.created,
        sessionId,
        eventId: answer.eventId,
        error: outcome.error,
      };
    }
    const outcome = {
      changedIds: changedIdsForAppliedUpdate(artifact, updatedArtifact, update),
      currentRevision: updatedArtifact.revision,
      status: "applied",
      updateId: update.id,
    } as const;
    const recorded = transaction.recordReply(replyInput);
    transaction.updateWalkthroughState({
      sessionId,
      artifact: updatedArtifact as unknown as JsonValue,
      expectedRevision: update.expectedRevision,
      revision: updatedArtifact.revision,
      updatedAt: occurredAt,
    });
    transaction.recordWalkthroughUpdateOutcome({
      eventId: progressId({ answer, outcome }),
      questionId: answer.eventId,
      sessionId,
      outcome,
      updatedAt: occurredAt,
    });
    const session = requireSession(transaction, sessionId);
    if (session.state === "active") {
      transaction.transitionSession({
        sessionId,
        eventId: commandId("agent-listening"),
        to: "agent_listening",
        occurredAt,
      });
    }
    return {
      ok: true,
      status: "answered",
      created: recorded.created,
      sessionId,
      eventId: answer.eventId,
      reply: recorded.record,
      walkthroughUpdate: outcome,
    };
  });
}

async function retryWalkthroughUpdate(
  store: SessionStore,
  arguments_: readonly string[],
): Promise<AgentCommandResult> {
  requireArguments("retry-update", arguments_, 2, "<session-id> <update.json>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const parsed = WalkthroughUpdateSchema.safeParse(await structuredFile(arguments_[1] ?? ""));
  if (!parsed.success) throw new AgentCommandInputError(validationMessage("Walkthrough Update", parsed.error.issues));
  const update = parsed.data;
  return store.transaction((transaction) => {
    const snapshot = requireSnapshot(transaction, sessionId);
    if (snapshot.session.state === "ending" || snapshot.session.state === "ended") {
      throw new SessionStoreStateError(
        `Cannot retry a Walkthrough Update after session ${sessionId} has ${snapshot.session.state}`,
      );
    }
    const existing = snapshot.replies.find(({ questionId }) => questionId === update.eventId);
    const previousAnswer = existing === undefined ? undefined : AnswerResponseSchema.safeParse(existing.content);
    const originalUpdate = previousAnswer?.success === true
      ? previousAnswer.data.walkthroughUpdate
      : undefined;
    if (existing === undefined || originalUpdate === undefined) {
      throw new SessionStoreStateError(
        `Event ${update.eventId} does not have an answered Walkthrough Update to retry`,
      );
    }
    if (!sameUpdateExceptExpectedRevision(originalUpdate, update)) {
      throw new SessionStoreConflictError(
        `Walkthrough Update ${update.id} cannot change the recorded answer payload`,
      );
    }
    const previousOutcomeRecord = snapshot.walkthroughUpdateOutcomes.find(
      ({ questionId }) => questionId === update.eventId,
    );
    const previousOutcome = previousOutcomeRecord?.outcome;
    const previousError = jsonObject(previousOutcome) && jsonObject(previousOutcome.error)
      ? previousOutcome.error
      : undefined;
    if (
      jsonObject(previousOutcome) &&
      previousOutcome.status === "applied" &&
      previousOutcome.currentRevision === update.expectedRevision + 1
    ) {
      return {
        ok: true,
        status: "update_applied",
        created: false,
        sessionId,
        eventId: update.eventId,
        walkthroughUpdate: previousOutcome,
      };
    }
    if (
      jsonObject(previousOutcome) &&
      previousOutcome.status === "rejected" &&
      previousError !== undefined &&
      previousError.expectedRevision === update.expectedRevision
    ) {
      return {
        ok: false,
        status: previousError.code === "REVISION_MISMATCH" ? "revision_mismatch" : "invalid_update",
        created: false,
        sessionId,
        eventId: update.eventId,
        error: previousError,
      };
    }
    if (
      !jsonObject(previousOutcome) ||
      previousOutcome.status !== "rejected" ||
      previousError?.code !== "REVISION_MISMATCH" ||
      originalUpdate.expectedRevision === update.expectedRevision
    ) {
      throw new SessionStoreConflictError(
        `Walkthrough Update ${update.id} is not awaiting revision recovery`,
      );
    }
    const state = snapshot.walkthroughState;
    if (state === undefined) throw new SessionStoreStateError("Walkthrough state is not initialized");
    const occurredAt = timestampAfter(snapshot);
    let artifact: WalkthroughArtifact;
    let updatedArtifact: WalkthroughArtifact;
    try {
      artifact = WalkthroughArtifactSchema.parse(state.artifact);
      updatedArtifact = applyWalkthroughUpdate(artifact, update);
    } catch (error: unknown) {
      const mismatch = error instanceof RevisionMismatchError;
      const outcome = {
        error: {
          code: mismatch ? "REVISION_MISMATCH" : "INVALID_UPDATE",
          currentRevision: state.revision,
          expectedRevision: update.expectedRevision,
          message: error instanceof Error ? error.message : "The Walkthrough Update is invalid",
          recoverable: mismatch,
        },
        status: "rejected",
        updateId: update.id,
      } as const;
      transaction.recordWalkthroughUpdateOutcome({
        eventId: progressId({ update, outcome }),
        questionId: update.eventId,
        sessionId,
        outcome,
        updatedAt: occurredAt,
      });
      return {
        ok: false,
        status: mismatch ? "revision_mismatch" : "invalid_update",
        created: true,
        sessionId,
        eventId: update.eventId,
        error: outcome.error,
      };
    }
    const outcome = {
      changedIds: changedIdsForAppliedUpdate(artifact, updatedArtifact, update),
      currentRevision: updatedArtifact.revision,
      status: "applied",
      updateId: update.id,
    } as const;
    transaction.updateWalkthroughState({
      sessionId,
      artifact: updatedArtifact as unknown as JsonValue,
      expectedRevision: update.expectedRevision,
      revision: updatedArtifact.revision,
      updatedAt: occurredAt,
    });
    transaction.recordWalkthroughUpdateOutcome({
      eventId: progressId({ update, outcome }),
      questionId: update.eventId,
      sessionId,
      outcome,
      updatedAt: occurredAt,
    });
    return {
      ok: true,
      status: "update_applied",
      created: true,
      sessionId,
      eventId: update.eventId,
      walkthroughUpdate: outcome,
    };
  });
}

async function fail(store: SessionStore, arguments_: readonly string[]): Promise<AgentCommandResult> {
  requireArguments("fail", arguments_, 3, "<session-id> <event-id> <error.json>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  const eventId = requireStableId(arguments_[1], "Event ID");
  const parsed = ErrorResponseSchema.safeParse(await structuredFile(arguments_[2] ?? ""));
  if (!parsed.success) throw new AgentCommandInputError(validationMessage("Error response", parsed.error.issues));
  if (parsed.data.eventId !== eventId) {
    throw new AgentCommandInputError("Error response eventId must match the command argument");
  }
  return recordTerminalReply(store, sessionId, eventId, "failure", parsed.data);
}

export function endLiveSession(store: SessionStore, sessionId: string): AgentCommandResult {
  let created = false;
  store.transaction((transaction) => {
    const snapshot = requireSnapshot(transaction, sessionId);
    if (snapshot.session.state === "ended") return;
    const occurredAt = timestampAfter(snapshot);
    const session = requireSession(transaction, sessionId);
    if (session.state !== "ending") {
      transaction.transitionSession({
        sessionId,
        eventId: commandId("session-ending"),
        to: "ending",
        occurredAt,
      });
    }
    transaction.transitionSession({
      sessionId,
      eventId: commandId("session-ended"),
      to: "ended",
      occurredAt,
    });
    created = true;
  });
  return { ok: true, status: "ended", created, sessionId };
}

function end(store: SessionStore, arguments_: readonly string[]): AgentCommandResult {
  requireArguments("end", arguments_, 1, "<session-id>");
  const sessionId = requireStableId(arguments_[0], "Session ID");
  return endLiveSession(store, sessionId);
}

export async function executeAgentCommand(
  command: string,
  arguments_: readonly string[],
  providedStore?: SessionStore,
): Promise<AgentCommandResult> {
  const store = providedStore ?? new SqliteSessionStore({ projectRoot: process.cwd() });
  try {
    switch (command) {
      case "poll": return await poll(store, arguments_);
      case "acknowledge": return acknowledge(store, arguments_);
      case "progress": return await progress(store, arguments_);
      case "reply": return await reply(store, arguments_);
      case "retry-update": return await retryWalkthroughUpdate(store, arguments_);
      case "fail": return await fail(store, arguments_);
      case "end": return end(store, arguments_);
      default: throw new AgentCommandInputError(`Unknown agent command: ${command}`);
    }
  } finally {
    if (providedStore === undefined) store.close();
  }
}

export function agentCommandErrorCode(error: unknown): string {
  if (error instanceof AgentCommandInputError) return "INVALID_INPUT";
  if (error instanceof SessionStoreConflictError) return "CONFLICT";
  if (error instanceof SessionStoreStateError) return "INVALID_STATE";
  return "INTERNAL_ERROR";
}
