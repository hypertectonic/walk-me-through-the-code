import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ConversationModeSchema,
  TimestampSchema,
  WalkthroughArtifactSchema,
  type ConversationMode,
} from "@walk-me-through-code/contracts";

import { normalizeArtifactRepository, repositoryIdentity } from "../repository-identity.js";

import {
  compareProtocolTimestamps,
  type AcknowledgeQuestionInput,
  type AcknowledgementRecord,
  type AdvanceCursorInput,
  type CancelQuestionInput,
  type CreateResult,
  type CreateSessionInput,
  type CursorRecord,
  type CreateDraftInput,
  type DeliveryLeaseRecord,
  type DraftRecord,
  type DurableEventRecord,
  type DurableEventType,
  type EditDraftInput,
  type EditQuestionInput,
  type EnqueueQuestionInput,
  type FindResumableSessionInput,
  type InitializeWalkthroughStateInput,
  type JsonValue,
  type LeaseQuestionInput,
  type QuestionRecord,
  type RecordReplyInput,
  type RecordStatusInput,
  type RecordWalkthroughUpdateOutcomeInput,
  type RemoveDraftInput,
  type ReplyRecord,
  type SendDraftsInput,
  type SendDraftsResult,
  type SessionRecord,
  type SessionSnapshot,
  type SessionState,
  type SessionStore,
  type SetConversationModeInput,
  SessionStoreConflictError,
  SessionStoreMigrationError,
  SessionStoreStateError,
  type StatusRecord,
  type SynchronousResult,
  type TransitionSessionInput,
  type UpdateWalkthroughStateInput,
  type WalkthroughStateRecord,
  type WalkthroughUpdateOutcomeRecord,
} from "./session-store.js";

export const SESSION_STORE_SCHEMA_VERSION = 13;
export const SESSION_STORE_DATABASE_FILENAME = "live-sessions.sqlite3";

const SESSION_STORE_BUSY_TIMEOUT_MS = 5_000;
const SESSION_STORE_BUSY_RETRY_DELAY_MS = 10;
const RUNTIME_OWNERSHIP_HEARTBEAT_INTERVAL_MS = 5_000;
const RUNTIME_OWNERSHIP_LEASE_MS = 30_000;
const SQLITE_BUSY_ERROR_CODE = 5;
const sqliteBusyRetryWaiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface SqliteSessionStoreOptions {
  readonly projectRoot?: string;
  readonly stateScope?: "global-history" | "project";
}

const STABLE_ID = /^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/;
const INTERNAL_EVENT_ID = /^_wmtc\.(?:lease-expired|question-cancelled|question_acknowledged|status_recorded|reply_recorded)\.[a-f0-9]{64}$/;
const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  created: ["viewer_open", "ending", "interrupted"],
  viewer_open: ["agent_listening", "ending", "interrupted"],
  agent_listening: ["active", "ending", "interrupted"],
  active: ["agent_listening", "ending", "interrupted"],
  ending: ["ended", "interrupted"],
  ended: [],
  interrupted: ["viewer_open", "agent_listening", "ending", "ended"],
};

interface SessionRow {
  id: string;
  repository_key: string;
  repository_scope: string | null;
  walkthrough_id: string;
  artifact_revision: number;
  conversation_mode: ConversationMode;
  state: SessionState;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface QuestionRow {
  id: string;
  session_id: string;
  artifact_revision: number;
  queue_position: number;
  state: QuestionRecord["state"];
  mode: ConversationMode;
  message: string;
  context_json: string | null;
  created_at: string;
  updated_at: string;
  current_lease_id: string | null;
}

interface DraftRow {
  id: string;
  session_id: string;
  artifact_revision: number;
  draft_position: number;
  mode: ConversationMode;
  message: string;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LeaseRow {
  id: string;
  session_id: string;
  question_id: string;
  leased_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: DeliveryLeaseRecord["releaseReason"];
}

interface AcknowledgementRow {
  id: string;
  session_id: string;
  question_id: string;
  lease_id: string;
  acknowledged_at: string;
}

interface StatusRow {
  id: string;
  session_id: string;
  question_id: string;
  status: string;
  detail_json: string | null;
  created_at: string;
}

interface ReplyRow {
  id: string;
  session_id: string;
  question_id: string;
  outcome: ReplyRecord["outcome"];
  content_json: string;
  created_at: string;
}

interface WalkthroughStateRow {
  session_id: string;
  artifact_json: string;
  revision: number;
  updated_at: string;
}

interface WalkthroughUpdateOutcomeRow {
  question_id: string;
  session_id: string;
  outcome_json: string;
  updated_at: string;
}

interface CursorRow {
  id: string;
  session_id: string;
  consumer: string;
  last_sequence: number;
  updated_at: string;
}

interface EventRow {
  id: string;
  session_id: string;
  sequence: number;
  type: DurableEventType;
  entity_id: string;
  data_json: string | null;
  occurred_at: string;
}

interface VersionRow {
  user_version: number;
}

interface RuntimeOwnershipRow {
  session_id: string;
  owner_id: string;
  process_id: number;
  heartbeat_at: number | null;
}

const MIGRATION_1 = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    repository_key TEXT NOT NULL,
    walkthrough_id TEXT NOT NULL,
    artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 0),
    state TEXT NOT NULL CHECK (state IN ('created', 'viewer_open', 'agent_listening', 'active', 'ending', 'ended', 'interrupted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT;

  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 0),
    queue_position INTEGER NOT NULL CHECK (queue_position > 0),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'acknowledged', 'answered', 'cancelled', 'failed')),
    message TEXT NOT NULL CHECK (length(trim(message)) > 0),
    context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    current_lease_id TEXT,
    UNIQUE (session_id, queue_position)
  ) STRICT;

  CREATE TABLE delivery_leases (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    leased_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT CHECK (release_reason IS NULL OR release_reason IN ('acknowledged', 'expired'))
  ) STRICT;

  CREATE TABLE acknowledgements (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL UNIQUE REFERENCES delivery_leases(id),
    acknowledged_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE statuses (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (length(trim(status)) > 0),
    detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE replies (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('answer', 'failure')),
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE cursors (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    consumer TEXT NOT NULL CHECK (length(trim(consumer)) > 0),
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, consumer)
  ) STRICT;

  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL CHECK (type IN (
      'session_created', 'session_transitioned', 'question_queued', 'question_edited',
      'question_cancelled', 'question_leased', 'lease_expired',
      'question_acknowledged', 'status_recorded', 'reply_recorded'
    )),
    entity_id TEXT NOT NULL,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
  ) STRICT;

  CREATE INDEX questions_delivery_order ON questions(session_id, state, queue_position);
  CREATE INDEX leases_expiry ON delivery_leases(session_id, released_at, expires_at);
  CREATE INDEX statuses_question_order ON statuses(question_id, created_at, id);
  CREATE INDEX events_resume_order ON session_events(session_id, sequence);
`;

const MIGRATION_3 = `
  CREATE TABLE IF NOT EXISTS walkthrough_states (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS walkthrough_update_outcomes (
    question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
    updated_at TEXT NOT NULL
  ) STRICT;
`;

const MIGRATION_4 = `
  DROP INDEX events_resume_order;
  ALTER TABLE session_events RENAME TO session_events_v3;

  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL CHECK (type IN (
      'session_created', 'session_transitioned', 'question_queued', 'question_edited',
      'question_cancelled', 'question_leased', 'lease_expired',
      'question_acknowledged', 'status_recorded', 'reply_recorded',
      'walkthrough_update_recorded'
    )),
    entity_id TEXT NOT NULL,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
  ) STRICT;

  INSERT INTO session_events
    (id, session_id, sequence, type, entity_id, data_json, occurred_at)
    SELECT id, session_id, sequence, type, entity_id, data_json, occurred_at
    FROM session_events_v3;
  DROP TABLE session_events_v3;
  CREATE INDEX events_resume_order ON session_events(session_id, sequence);
`;

const MIGRATION_5 = `
  DROP INDEX leases_expiry;
  ALTER TABLE acknowledgements RENAME TO acknowledgements_v4;
  ALTER TABLE delivery_leases RENAME TO delivery_leases_v4;

  CREATE TABLE delivery_leases (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    leased_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT CHECK (
      release_reason IS NULL OR release_reason IN ('acknowledged', 'cancelled', 'expired')
    )
  ) STRICT;

  CREATE TABLE acknowledgements (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL UNIQUE REFERENCES questions(id) ON DELETE CASCADE,
    lease_id TEXT NOT NULL UNIQUE REFERENCES delivery_leases(id),
    acknowledged_at TEXT NOT NULL
  ) STRICT;

  INSERT INTO delivery_leases
    (id, session_id, question_id, leased_at, expires_at, released_at, release_reason)
    SELECT id, session_id, question_id, leased_at, expires_at, released_at, release_reason
    FROM delivery_leases_v4;
  INSERT INTO acknowledgements
    (id, session_id, question_id, lease_id, acknowledged_at)
    SELECT id, session_id, question_id, lease_id, acknowledged_at
    FROM acknowledgements_v4;

  DROP TABLE acknowledgements_v4;
  DROP TABLE delivery_leases_v4;
  CREATE INDEX leases_expiry ON delivery_leases(session_id, released_at, expires_at);
`;

const MIGRATION_7 = `
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active
  ON sessions ((1))
  WHERE state != 'ended';
`;

const MIGRATION_8 = `
  ALTER TABLE sessions ADD COLUMN repository_scope TEXT;
`;

const MIGRATION_9 = `
  CREATE TABLE IF NOT EXISTS runtime_ownership (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL UNIQUE,
    process_id INTEGER NOT NULL CHECK (process_id > 0)
  ) STRICT;
`;

const MIGRATION_11 = `
  UPDATE session_events
  SET data_json = json_set(data_json, '$.conversationMode', 'analyze')
  WHERE type = 'session_created'
    AND data_json IS NOT NULL
    AND json_type(data_json, '$.conversationMode') IS NULL;
  UPDATE session_events
  SET data_json = json_set(data_json, '$.mode', 'analyze')
  WHERE type = 'question_queued'
    AND data_json IS NOT NULL
    AND json_type(data_json, '$.mode') IS NULL;
`;

const MIGRATION_12 = `
  DROP INDEX events_resume_order;
  ALTER TABLE session_events RENAME TO session_events_v11;

  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL CHECK (type IN (
      'session_created', 'session_transitioned', 'conversation_mode_changed',
      'question_queued', 'question_edited', 'question_cancelled', 'question_leased',
      'lease_expired', 'question_acknowledged', 'status_recorded', 'reply_recorded',
      'walkthrough_update_recorded'
    )),
    entity_id TEXT NOT NULL,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
  ) STRICT;

  INSERT INTO session_events
    (id, session_id, sequence, type, entity_id, data_json, occurred_at)
    SELECT id, session_id, sequence, type, entity_id, data_json, occurred_at
    FROM session_events_v11;
  DROP TABLE session_events_v11;
  CREATE INDEX events_resume_order ON session_events(session_id, sequence);
`;

const MIGRATION_13 = `
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    artifact_revision INTEGER NOT NULL CHECK (artifact_revision >= 0),
    draft_position INTEGER NOT NULL CHECK (draft_position > 0),
    mode TEXT NOT NULL CHECK (mode IN ('analyze', 'learn')),
    message TEXT NOT NULL CHECK (length(trim(message)) > 0),
    context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, draft_position)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drafts_session_order ON drafts(session_id, draft_position);

  DROP INDEX events_resume_order;
  ALTER TABLE session_events RENAME TO session_events_v12;

  CREATE TABLE session_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    type TEXT NOT NULL CHECK (type IN (
      'session_created', 'session_transitioned', 'conversation_mode_changed',
      'draft_created', 'draft_updated', 'draft_removed', 'drafts_sent',
      'question_queued', 'question_edited', 'question_cancelled', 'question_leased',
      'lease_expired', 'question_acknowledged', 'status_recorded', 'reply_recorded',
      'walkthrough_update_recorded'
    )),
    entity_id TEXT NOT NULL,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    occurred_at TEXT NOT NULL,
    UNIQUE (session_id, sequence)
  ) STRICT;

  INSERT INTO session_events
    (id, session_id, sequence, type, entity_id, data_json, occurred_at)
    SELECT id, session_id, sequence, type, entity_id, data_json, occurred_at
    FROM session_events_v12;
  DROP TABLE session_events_v12;
  CREATE INDEX events_resume_order ON session_events(session_id, sequence);
`;

export function defaultSessionStoreDirectory(): string {
  return join(homedir(), ".wmtc");
}

export function defaultSessionStorePath(): string {
  return join(defaultSessionStoreDirectory(), SESSION_STORE_DATABASE_FILENAME);
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function repositoryRoot(start: string): string | undefined {
  for (let candidate = resolve(start);; candidate = dirname(candidate)) {
    if (existsSync(join(candidate, ".git"))) return candidate;
    if (candidate === dirname(candidate)) return undefined;
  }
}

function resolveThroughExistingAncestor(candidate: string): string {
  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), relative(existingAncestor, candidate));
}

function canonicalProjectRoot(selectedRoot: string): string {
  const projectRoot = repositoryRoot(selectedRoot) ?? resolve(selectedRoot);
  return resolveThroughExistingAncestor(projectRoot);
}

function legacyRepositoryRoot(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function assertStateDirectoryOutsideProject(
  stateDirectory: string,
  projectRoot: string,
): void {
  if (pathIsWithin(projectRoot, stateDirectory)) {
    throw new SessionStoreStateError(
      "The Live Session state directory cannot be inside the source repository",
    );
  }
  if (
    pathIsWithin(projectRoot, resolveThroughExistingAncestor(stateDirectory))
  ) {
    throw new SessionStoreStateError(
      "The Live Session state directory cannot resolve inside the source repository",
    );
  }
}

function assertConfiguredGlobalStateDirectoryOutsideRepositories(stateDirectory: string): void {
  const canonicalStateDirectory = resolveThroughExistingAncestor(stateDirectory);
  const containingRepository = repositoryRoot(canonicalStateDirectory);
  if (containingRepository !== undefined) {
    assertStateDirectoryOutsideProject(canonicalStateDirectory, canonicalProjectRoot(containingRepository));
  }
}

function assertDatabaseFileIsSafe(databasePath: string): void {
  try {
    const databaseFile = lstatSync(databasePath);
    if (databaseFile.isSymbolicLink()) {
      throw new SessionStoreStateError(
        "The Live Session database file cannot be a symbolic link",
      );
    }
    if (databaseFile.nlink > 1) {
      throw new SessionStoreStateError(
        "The Live Session database file cannot have hard links",
      );
    }
  } catch (error) {
    if (error instanceof SessionStoreStateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requiredId(value: string, label: string): void {
  if (!STABLE_ID.test(value) || value.length > 128) {
    throw new SessionStoreConflictError(`${label} must be a stable lowercase ID`);
  }
}

function requiredEventId(value: string): void {
  if (!INTERNAL_EVENT_ID.test(value)) requiredId(value, "Event ID");
}

function requiredTimestamp(value: string, label: string): void {
  if (!TimestampSchema.safeParse(value).success) {
    throw new SessionStoreConflictError(`${label} must be a valid protocol timestamp`);
  }
}

function requireNotBefore(value: string, precedingValue: string, message: string): void {
  if (compareProtocolTimestamps(value, precedingValue) < 0) {
    throw new SessionStoreConflictError(message);
  }
}

function requireAfter(value: string, precedingValue: string, message: string): void {
  if (compareProtocolTimestamps(value, precedingValue) <= 0) {
    throw new SessionStoreConflictError(message);
  }
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === SQLITE_BUSY_ERROR_CODE;
}

function requiredRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionStoreConflictError("Artifact revision must be a non-negative safe integer");
  }
}

function requiredConversationMode(value: unknown): asserts value is ConversationMode {
  if (!ConversationModeSchema.safeParse(value).success) {
    throw new SessionStoreConflictError("Conversation mode must be analyze or learn");
  }
}

function expiredLeaseEventId(leaseId: string): string {
  return `_wmtc.lease-expired.${createHash("sha256").update(leaseId).digest("hex")}`;
}

function sessionEndQuestionEventId(transitionEventId: string, questionId: string): string {
  const digest = createHash("sha256").update(`${transitionEventId}\0${questionId}`).digest("hex");
  return `_wmtc.question-cancelled.${digest}`;
}

function sessionEndDraftEventId(transitionEventId: string, draftId: string): string {
  const digest = createHash("sha256").update(`${transitionEventId}\0${draftId}`).digest("hex");
  return `session-end-draft-${digest}`;
}

function sentQuestionId(sendEventId: string, sourceId: string): string {
  const digest = createHash("sha256").update(`${sendEventId}\0${sourceId}`).digest("hex");
  return `question-sent-${digest}`;
}

function sentQuestionEventId(sendEventId: string, questionId: string): string {
  const digest = createHash("sha256").update(`${sendEventId}\0${questionId}`).digest("hex");
  return `question-sent-event-${digest}`;
}

function agentOperationEventId(
  type: "question_acknowledged" | "status_recorded" | "reply_recorded",
  idempotencyKey: string,
): string {
  return `_wmtc.${type}.${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function stringifyJson(value: JsonValue): string {
  return JSON.stringify(canonicalJson(value));
}

function parseJson(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function canonicalJson(value: JsonValue): JsonValue {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new SessionStoreConflictError("JSON numbers must be finite");
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isJsonObject(value)) return value;
  const canonical: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) canonical[key] = canonicalJson(child);
  }
  return canonical;
}

function jsonTextEquals(value: string, expected: JsonValue): boolean {
  return stringifyJson(parseJson(value)) === stringifyJson(expected);
}

function isJsonObject(value: JsonValue | null): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    repositoryKey: row.repository_key,
    ...(row.repository_scope === null ? {} : { repositoryScope: row.repository_scope }),
    walkthroughId: row.walkthrough_id,
    artifactRevision: row.artifact_revision,
    conversationMode: row.conversation_mode,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

function questionRecord(row: QuestionRow): QuestionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    artifactRevision: row.artifact_revision,
    queuePosition: row.queue_position,
    state: row.state,
    mode: row.mode,
    message: row.message,
    context: row.context_json === null ? null : parseJson(row.context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currentLeaseId: row.current_lease_id,
  };
}

function draftRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    artifactRevision: row.artifact_revision,
    draftPosition: row.draft_position,
    mode: row.mode,
    message: row.message,
    context: row.context_json === null ? null : parseJson(row.context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventDraftRecord(data: JsonValue | null): DraftRecord | undefined {
  if (!isJsonObject(data)) return undefined;
  const draft = data.draft;
  if (draft === undefined || !isJsonObject(draft)) return undefined;
  if (
    typeof draft.id !== "string" ||
    typeof draft.sessionId !== "string" ||
    typeof draft.artifactRevision !== "number" ||
    typeof draft.draftPosition !== "number" ||
    (draft.mode !== "analyze" && draft.mode !== "learn") ||
    typeof draft.message !== "string" ||
    typeof draft.createdAt !== "string" ||
    typeof draft.updatedAt !== "string" ||
    !("context" in draft)
  ) return undefined;
  return {
    id: draft.id,
    sessionId: draft.sessionId,
    artifactRevision: draft.artifactRevision,
    draftPosition: draft.draftPosition,
    mode: draft.mode,
    message: draft.message,
    context: draft.context ?? null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function leaseRecord(row: LeaseRow): DeliveryLeaseRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    questionId: row.question_id,
    leasedAt: row.leased_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function acknowledgementRecord(row: AcknowledgementRow): AcknowledgementRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    questionId: row.question_id,
    leaseId: row.lease_id,
    acknowledgedAt: row.acknowledged_at,
  };
}

function statusRecord(row: StatusRow): StatusRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    questionId: row.question_id,
    status: row.status,
    detail: row.detail_json === null ? null : parseJson(row.detail_json),
    createdAt: row.created_at,
  };
}

function replyRecord(row: ReplyRow): ReplyRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    questionId: row.question_id,
    outcome: row.outcome,
    content: parseJson(row.content_json),
    createdAt: row.created_at,
  };
}

function walkthroughStateRecord(row: WalkthroughStateRow): WalkthroughStateRecord {
  return {
    sessionId: row.session_id,
    artifact: parseJson(row.artifact_json),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function walkthroughUpdateOutcomeRecord(
  row: WalkthroughUpdateOutcomeRow,
): WalkthroughUpdateOutcomeRecord {
  return {
    questionId: row.question_id,
    sessionId: row.session_id,
    outcome: parseJson(row.outcome_json),
    updatedAt: row.updated_at,
  };
}

function cursorRecord(row: CursorRow): CursorRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    consumer: row.consumer,
    lastSequence: row.last_sequence,
    updatedAt: row.updated_at,
  };
}

function eventRecord(row: EventRow): DurableEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence: row.sequence,
    type: row.type,
    entityId: row.entity_id,
    data: row.data_json === null ? null : parseJson(row.data_json),
    occurredAt: row.occurred_at,
  };
}

class TransactionSessionStore implements SessionStore {
  public readonly schemaVersion: number;
  private active = true;

  public constructor(private readonly store: SqliteSessionStore) {
    this.schemaVersion = store.schemaVersion;
  }

  public invalidate(): void {
    this.active = false;
  }

  public transaction<T>(work: (store: SessionStore) => SynchronousResult<T>): T {
    this.assertActive();
    return this.store.transaction(work);
  }

  public claimRuntimeOwnership(sessionId: string, ownerId: string): void {
    this.assertActive();
    this.store.claimRuntimeOwnership(sessionId, ownerId);
  }

  public renewRuntimeOwnership(sessionId: string, ownerId: string): boolean {
    this.assertActive();
    return this.store.renewRuntimeOwnership(sessionId, ownerId);
  }

  public releaseRuntimeOwnership(sessionId: string, ownerId: string): void {
    this.assertActive();
    this.store.releaseRuntimeOwnership(sessionId, ownerId);
  }

  public createSession(input: CreateSessionInput): CreateResult<SessionRecord> {
    this.assertActive();
    return this.store.createSession(input);
  }

  public getSession(sessionId: string): SessionRecord | undefined {
    this.assertActive();
    return this.store.getSession(sessionId);
  }

  public listSessions(): readonly SessionRecord[] {
    this.assertActive();
    return this.store.listSessions();
  }

  public discardSession(sessionId: string): boolean {
    this.assertActive();
    return this.store.discardSession(sessionId);
  }

  public findResumableSession(input: FindResumableSessionInput): SessionRecord | undefined {
    this.assertActive();
    return this.store.findResumableSession(input);
  }

  public transitionSession(input: TransitionSessionInput): CreateResult<SessionRecord> {
    this.assertActive();
    return this.store.transitionSession(input);
  }

  public setConversationMode(input: SetConversationModeInput): CreateResult<SessionRecord> {
    this.assertActive();
    return this.store.setConversationMode(input);
  }

  public getDraft(draftId: string): DraftRecord | undefined {
    this.assertActive();
    return this.store.getDraft(draftId);
  }

  public createDraft(input: CreateDraftInput): CreateResult<DraftRecord> {
    this.assertActive();
    return this.store.createDraft(input);
  }

  public editDraft(input: EditDraftInput): CreateResult<DraftRecord> {
    this.assertActive();
    return this.store.editDraft(input);
  }

  public removeDraft(input: RemoveDraftInput): CreateResult<DraftRecord> {
    this.assertActive();
    return this.store.removeDraft(input);
  }

  public sendDrafts(input: SendDraftsInput): SendDraftsResult {
    this.assertActive();
    return this.store.sendDrafts(input);
  }

  public getQuestion(questionId: string): QuestionRecord | undefined {
    this.assertActive();
    return this.store.getQuestion(questionId);
  }

  public enqueueQuestion(input: EnqueueQuestionInput): CreateResult<QuestionRecord> {
    this.assertActive();
    return this.store.enqueueQuestion(input);
  }

  public editQuestion(input: EditQuestionInput): CreateResult<QuestionRecord> {
    this.assertActive();
    return this.store.editQuestion(input);
  }

  public cancelQuestion(input: CancelQuestionInput): CreateResult<QuestionRecord> {
    this.assertActive();
    return this.store.cancelQuestion(input);
  }

  public leaseNextQuestion(
    input: LeaseQuestionInput,
  ): CreateResult<DeliveryLeaseRecord> | undefined {
    this.assertActive();
    return this.store.leaseNextQuestion(input);
  }

  public acknowledgeQuestion(
    input: AcknowledgeQuestionInput,
  ): CreateResult<AcknowledgementRecord> {
    this.assertActive();
    return this.store.acknowledgeQuestion(input);
  }

  public recordStatus(input: RecordStatusInput): CreateResult<StatusRecord> {
    this.assertActive();
    return this.store.recordStatus(input);
  }

  public recordReply(input: RecordReplyInput): CreateResult<ReplyRecord> {
    this.assertActive();
    return this.store.recordReply(input);
  }

  public initializeWalkthroughState(
    input: InitializeWalkthroughStateInput,
  ): CreateResult<WalkthroughStateRecord> {
    this.assertActive();
    return this.store.initializeWalkthroughState(input);
  }

  public updateWalkthroughState(
    input: UpdateWalkthroughStateInput,
  ): CreateResult<WalkthroughStateRecord> {
    this.assertActive();
    return this.store.updateWalkthroughState(input);
  }

  public recordWalkthroughUpdateOutcome(
    input: RecordWalkthroughUpdateOutcomeInput,
  ): CreateResult<WalkthroughUpdateOutcomeRecord> {
    this.assertActive();
    return this.store.recordWalkthroughUpdateOutcome(input);
  }

  public advanceCursor(input: AdvanceCursorInput): CreateResult<CursorRecord> {
    this.assertActive();
    return this.store.advanceCursor(input);
  }

  public listEvents(sessionId: string, afterSequence?: number): readonly DurableEventRecord[] {
    this.assertActive();
    return this.store.listEvents(sessionId, afterSequence);
  }

  public getSnapshot(sessionId: string): SessionSnapshot | undefined {
    this.assertActive();
    return this.store.getSnapshot(sessionId);
  }

  public close(): void {
    throw new SessionStoreStateError("A transaction-scoped Session Store cannot be closed");
  }

  private assertActive(): void {
    if (!this.active) {
      throw new SessionStoreStateError("Session Store transaction scope is no longer active");
    }
  }
}

export class SqliteSessionStore implements SessionStore {
  public readonly schemaVersion = SESSION_STORE_SCHEMA_VERSION;
  public readonly databasePath: string;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  private savepointNumber = 0;
  private closed = false;
  private readonly claimedRuntimeOwnership = new Map<string, {
    readonly sessionId: string;
    readonly heartbeat: NodeJS.Timeout;
  }>();

  public constructor(options: SqliteSessionStoreOptions = {}) {
    const configuredStateDirectory = process.env.WMTC_STATE_DIRECTORY;
    const stateDirectory = resolve(configuredStateDirectory ?? defaultSessionStoreDirectory());
    const stateScope = options.stateScope ?? "project";
    if (stateScope === "project") {
      const selectedProjectRoot = options.projectRoot ?? process.cwd();
      assertStateDirectoryOutsideProject(stateDirectory, canonicalProjectRoot(selectedProjectRoot));
    } else {
      if (configuredStateDirectory !== undefined) {
        assertStateDirectoryOutsideProject(stateDirectory, canonicalProjectRoot(process.cwd()));
      }
      assertConfiguredGlobalStateDirectoryOutsideRepositories(stateDirectory);
    }
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(stateDirectory, 0o700);
    this.databasePath = join(stateDirectory, SESSION_STORE_DATABASE_FILENAME);
    assertDatabaseFileIsSafe(this.databasePath);
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS};`);
    this.migrate();
    this.database.exec(MIGRATION_9);
    this.enableWriteAheadLogging();
    this.database.exec("PRAGMA synchronous = FULL;");
    chmodSync(this.databasePath, 0o600);
  }

  public transaction<T>(work: (store: SessionStore) => SynchronousResult<T>): T {
    this.assertOpen();
    const savepoint = this.transactionDepth === 0 ? undefined : `session_store_${this.savepointNumber}`;
    this.savepointNumber += 1;
    this.database.exec(savepoint === undefined ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    const transactionStore = new TransactionSessionStore(this);
    try {
      const result = work(transactionStore);
      transactionStore.invalidate();
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        void Promise.resolve(result).catch(() => undefined);
        throw new SessionStoreStateError("Session Store transaction callbacks must be synchronous");
      }
      this.database.exec(savepoint === undefined ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      transactionStore.invalidate();
      if (savepoint === undefined) {
        this.database.exec("ROLLBACK");
      } else {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  public claimRuntimeOwnership(sessionId: string, ownerId: string): void {
    this.atomic(() => {
      requiredId(sessionId, "Session ID");
      requiredId(ownerId, "Runtime owner ID");
      this.requiredSession(sessionId);
      this.reapStaleRuntimeOwnership();
      const ownership = this.runtimeOwnership(sessionId);
      if (ownership !== undefined) {
        if (ownership.owner_id === ownerId && ownership.process_id === process.pid) {
          const now = Date.now();
          const renewed = this.database.prepare(`
            UPDATE runtime_ownership SET heartbeat_at = ?
            WHERE session_id = ? AND owner_id = ? AND process_id = ?
              AND heartbeat_at >= ?
          `).run(now, sessionId, ownerId, process.pid, now - RUNTIME_OWNERSHIP_LEASE_MS);
          if (renewed.changes === 0) {
            throw new SessionStoreStateError(
              `Live Session ${sessionId} runtime ownership has expired`,
            );
          }
          return;
        }
        throw new SessionStoreStateError(
          `Live Session ${sessionId} is already owned by an open runtime`,
        );
      }
      this.database.prepare(`
        INSERT INTO runtime_ownership (session_id, owner_id, process_id, heartbeat_at)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, ownerId, process.pid, Date.now());
    });
    if (!this.claimedRuntimeOwnership.has(ownerId)) {
      const heartbeat = setInterval(() => {
        if (this.closed) return;
        try {
          if (!this.renewRuntimeOwnership(sessionId, ownerId)) {
            this.stopRuntimeOwnershipHeartbeat(ownerId);
          }
        } catch {
          // A transient busy database gets another refresh attempt before the lease expires.
        }
      }, RUNTIME_OWNERSHIP_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();
      this.claimedRuntimeOwnership.set(ownerId, { sessionId, heartbeat });
    }
  }

  public renewRuntimeOwnership(sessionId: string, ownerId: string): boolean {
    return this.atomic(() => {
      requiredId(sessionId, "Session ID");
      requiredId(ownerId, "Runtime owner ID");
      const now = Date.now();
      const renewed = this.database.prepare(`
        UPDATE runtime_ownership SET heartbeat_at = ?
        WHERE session_id = ? AND owner_id = ? AND process_id = ?
          AND heartbeat_at >= ?
      `).run(now, sessionId, ownerId, process.pid, now - RUNTIME_OWNERSHIP_LEASE_MS);
      return renewed.changes === 1;
    });
  }

  public releaseRuntimeOwnership(sessionId: string, ownerId: string): void {
    this.atomic(() => {
      requiredId(sessionId, "Session ID");
      requiredId(ownerId, "Runtime owner ID");
      this.database.prepare(`
        DELETE FROM runtime_ownership
        WHERE session_id = ? AND owner_id = ? AND process_id = ?
      `).run(sessionId, ownerId, process.pid);
    });
    this.stopRuntimeOwnershipHeartbeat(ownerId);
  }

  public createSession(input: CreateSessionInput): CreateResult<SessionRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Session ID");
      requiredId(input.lifecycleEventId, "Lifecycle event ID");
      requiredId(input.walkthroughId, "Walkthrough ID");
      requiredRevision(input.artifactRevision);
      requiredConversationMode(input.conversationMode);
      requiredTimestamp(input.createdAt, "createdAt");
      requiredTimestamp(input.updatedAt, "updatedAt");
      requireNotBefore(input.updatedAt, input.createdAt, "updatedAt cannot be earlier than createdAt");
      const existing = this.sessionById(input.id);
      if (existing !== undefined) {
        const expected = sessionRecord(existing);
        const creationEvent = this.sessionCreationEvent(input.id);
        const creationData = creationEvent?.data_json === null || creationEvent === undefined
          ? null
          : parseJson(creationEvent.data_json);
        if (
          expected.repositoryKey !== input.repositoryKey ||
          expected.repositoryScope !== input.repositoryScope ||
          expected.walkthroughId !== input.walkthroughId ||
          expected.artifactRevision !== input.artifactRevision ||
          expected.createdAt !== input.createdAt ||
          creationEvent?.id !== input.lifecycleEventId ||
          creationEvent.session_id !== input.id ||
          creationEvent.type !== "session_created" ||
          creationEvent.entity_id !== input.id ||
          creationEvent.occurred_at !== input.createdAt ||
          !isJsonObject(creationData) ||
          creationData.repositoryKey !== input.repositoryKey ||
          creationData.repositoryScope !== input.repositoryScope ||
          creationData.walkthroughId !== input.walkthroughId ||
          creationData.conversationMode !== input.conversationMode ||
          creationData.updatedAt !== input.updatedAt
        ) throw new SessionStoreConflictError(`Session ID ${input.id} already identifies different data`);
        return { created: false, record: expected };
      }
      const active = this.database.prepare(`
        SELECT * FROM sessions
        WHERE state != 'ended'
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      `).get() as SessionRow | undefined;
      if (active !== undefined) {
        throw new SessionStoreConflictError(
          `Agent already has active Live Session ${active.id}; end it before starting another`,
        );
      }
      this.database.prepare(`
        INSERT INTO sessions (
          id, repository_key, repository_scope, walkthrough_id, artifact_revision,
          conversation_mode, state, created_at, updated_at, ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL)
      `).run(
        input.id,
        input.repositoryKey,
        input.repositoryScope ?? null,
        input.walkthroughId,
        input.artifactRevision,
        input.conversationMode,
        input.createdAt,
        input.updatedAt,
      );
      this.appendEvent(
        input.lifecycleEventId,
        input.id,
        "session_created",
        input.id,
        {
          repositoryKey: input.repositoryKey,
          ...(input.repositoryScope === undefined ? {} : { repositoryScope: input.repositoryScope }),
          walkthroughId: input.walkthroughId,
          conversationMode: input.conversationMode,
          updatedAt: input.updatedAt,
        },
        input.createdAt,
      );
      return { created: true, record: sessionRecord(this.requiredSession(input.id)) };
    });
  }

  public getSession(sessionId: string): SessionRecord | undefined {
    this.assertOpen();
    const row = this.sessionById(sessionId);
    return row === undefined ? undefined : sessionRecord(row);
  }

  public getQuestion(questionId: string): QuestionRecord | undefined {
    this.assertOpen();
    const row = this.questionById(questionId);
    return row === undefined ? undefined : questionRecord(row);
  }

  public listSessions(): readonly SessionRecord[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC, id DESC",
    ).all() as unknown as SessionRow[]).map(sessionRecord);
  }

  public discardSession(sessionId: string): boolean {
    return this.atomic(() => {
      requiredId(sessionId, "Session ID");
      const session = this.sessionById(sessionId);
      if (session === undefined) return false;
      this.reapStaleRuntimeOwnership();
      if (this.runtimeOwnership(sessionId) !== undefined) {
        throw new SessionStoreStateError(
          `Live Session ${sessionId} is still owned by an open runtime; close it before discarding saved history`,
        );
      }
      if (session.state !== "ended") {
        throw new SessionStoreStateError(
          `Live Session ${sessionId} is ${session.state}; end it before discarding saved history`,
        );
      }
      const result = this.database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      return result.changes === 1;
    });
  }

  public findResumableSession(input: FindResumableSessionInput): SessionRecord | undefined {
    this.assertOpen();
    requiredId(input.walkthroughId, "Walkthrough ID");
    requiredRevision(input.artifactRevision);
    const row = this.database.prepare(`
      SELECT * FROM sessions
      WHERE repository_key = ?
        AND repository_scope IS ?
        AND walkthrough_id = ?
        AND artifact_revision = ?
        AND state IN ('created', 'viewer_open', 'agent_listening', 'active', 'interrupted')
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(
      input.repositoryKey,
      input.repositoryScope ?? null,
      input.walkthroughId,
      input.artifactRevision,
    ) as SessionRow | undefined;
    return row === undefined ? undefined : sessionRecord(row);
  }

  public transitionSession(input: TransitionSessionInput): CreateResult<SessionRecord> {
    return this.atomic(() => {
      requiredId(input.eventId, "Lifecycle event ID");
      requiredTimestamp(input.occurredAt, "occurredAt");
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, input.sessionId, "session_transitioned", input.sessionId);
        const eventData = existingEvent.data_json === null ? null : parseJson(existingEvent.data_json);
        if (
          existingEvent.occurred_at !== input.occurredAt ||
          !isJsonObject(eventData) ||
          eventData.to !== input.to
        ) {
          throw new SessionStoreConflictError(
            `Lifecycle event ID ${input.eventId} already identifies different transition data`,
          );
        }
        return { created: false, record: sessionRecord(this.requiredSession(input.sessionId)) };
      }
      const current = this.requiredSession(input.sessionId);
      requireNotBefore(
        input.occurredAt,
        current.updated_at,
        "A lifecycle event cannot precede the current session state",
      );
      if (!SESSION_TRANSITIONS[current.state].includes(input.to)) {
        throw new SessionStoreStateError(`Session cannot transition from ${current.state} to ${input.to}`);
      }
      if (input.to === "ended") {
        const remainingDrafts = this.database.prepare(`
          SELECT * FROM drafts
          WHERE session_id = ?
          ORDER BY draft_position ASC
        `).all(input.sessionId) as unknown as DraftRow[];
        for (const draft of remainingDrafts) {
          requireNotBefore(
            input.occurredAt,
            draft.updated_at,
            "A session cannot end before its latest draft state",
          );
          const record = draftRecord(draft);
          this.database.prepare("DELETE FROM drafts WHERE id = ?").run(draft.id);
          this.appendEvent(
            sessionEndDraftEventId(input.eventId, draft.id),
            input.sessionId,
            "draft_removed",
            draft.id,
            { draft: record, removedAt: input.occurredAt } as unknown as JsonValue,
            input.occurredAt,
          );
        }
        const unfinishedQuestions = this.database.prepare(`
          SELECT * FROM questions
          WHERE session_id = ? AND state NOT IN ('answered', 'cancelled', 'failed')
          ORDER BY queue_position ASC
        `).all(input.sessionId) as unknown as QuestionRow[];
        for (const question of unfinishedQuestions) {
          requireNotBefore(
            input.occurredAt,
            question.updated_at,
            "A session cannot end before its latest question state",
          );
          if (question.state === "leased" && question.current_lease_id !== null) {
            this.database.prepare(`
              UPDATE delivery_leases
              SET released_at = ?, release_reason = 'cancelled'
              WHERE id = ? AND released_at IS NULL
            `).run(input.occurredAt, question.current_lease_id);
          }
          this.database.prepare(`
            UPDATE questions
            SET state = 'cancelled', current_lease_id = NULL, updated_at = ?
            WHERE id = ?
          `).run(input.occurredAt, question.id);
          this.appendEvent(
            sessionEndQuestionEventId(input.eventId, question.id),
            input.sessionId,
            "question_cancelled",
            question.id,
            { cancelledAt: input.occurredAt },
            input.occurredAt,
          );
        }
      }
      const endedAt = input.to === "ended" ? input.occurredAt : null;
      this.database.prepare("UPDATE sessions SET state = ?, updated_at = ?, ended_at = ? WHERE id = ?")
        .run(input.to, input.occurredAt, endedAt, input.sessionId);
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "session_transitioned",
        input.sessionId,
        { from: current.state, to: input.to },
        input.occurredAt,
      );
      return { created: true, record: sessionRecord(this.requiredSession(input.sessionId)) };
    });
  }

  public setConversationMode(input: SetConversationModeInput): CreateResult<SessionRecord> {
    return this.atomic(() => {
      requiredId(input.sessionId, "Session ID");
      requiredId(input.eventId, "Conversation mode event ID");
      requiredConversationMode(input.mode);
      requiredTimestamp(input.changedAt, "changedAt");
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(
          existingEvent,
          input.sessionId,
          "conversation_mode_changed",
          input.sessionId,
        );
        const eventData = existingEvent.data_json === null ? null : parseJson(existingEvent.data_json);
        if (
          existingEvent.occurred_at !== input.changedAt ||
          !isJsonObject(eventData) ||
          eventData.mode !== input.mode
        ) {
          throw new SessionStoreConflictError(
            `Conversation mode event ID ${input.eventId} already identifies different data`,
          );
        }
        return { created: false, record: sessionRecord(this.requiredSession(input.sessionId)) };
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(
          `Cannot change conversation mode while session is ${session.state}`,
        );
      }
      requireNotBefore(
        input.changedAt,
        session.updated_at,
        "changedAt cannot be earlier than the session update",
      );
      this.database.prepare(
        "UPDATE sessions SET conversation_mode = ? WHERE id = ?",
      ).run(input.mode, input.sessionId);
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "conversation_mode_changed",
        input.sessionId,
        { mode: input.mode },
        input.changedAt,
      );
      return { created: true, record: sessionRecord(this.requiredSession(input.sessionId)) };
    });
  }

  public getDraft(draftId: string): DraftRecord | undefined {
    this.assertOpen();
    const row = this.draftById(draftId);
    return row === undefined ? undefined : draftRecord(row);
  }

  public createDraft(input: CreateDraftInput): CreateResult<DraftRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Draft ID");
      requiredRevision(input.artifactRevision);
      requiredTimestamp(input.createdAt, "createdAt");
      if (input.message.trim() === "") {
        throw new SessionStoreConflictError("Draft message cannot be empty");
      }
      const existingEvent = this.eventById(input.id);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, input.sessionId, "draft_created", input.id);
        const existingRecord = eventDraftRecord(
          existingEvent.data_json === null ? null : parseJson(existingEvent.data_json),
        );
        if (
          existingRecord === undefined ||
          existingRecord.artifactRevision !== input.artifactRevision ||
          existingRecord.message !== input.message ||
          stringifyJson(existingRecord.context) !== stringifyJson(input.context) ||
          existingRecord.createdAt !== input.createdAt
        ) {
          throw new SessionStoreConflictError(
            `Draft ID ${input.id} already identifies different data`,
          );
        }
        return { created: false, record: existingRecord };
      }
      if (this.draftById(input.id) !== undefined) {
        throw new SessionStoreConflictError(`Draft ID ${input.id} is missing its creation event`);
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(`Cannot create a draft while session is ${session.state}`);
      }
      requireNotBefore(
        input.createdAt,
        session.updated_at,
        "A draft cannot be created before the current session state",
      );
      const next = this.database.prepare(
        "SELECT COALESCE(MAX(draft_position), 0) + 1 AS position FROM drafts WHERE session_id = ?",
      ).get(input.sessionId) as { position: number };
      this.database.prepare(`
        INSERT INTO drafts (
          id, session_id, artifact_revision, draft_position, mode, message,
          context_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.artifactRevision,
        next.position,
        session.conversation_mode,
        input.message,
        input.context === null ? null : stringifyJson(input.context),
        input.createdAt,
        input.createdAt,
      );
      const record = draftRecord(this.requiredDraft(input.id));
      this.appendEvent(
        input.id,
        input.sessionId,
        "draft_created",
        input.id,
        { draft: record } as unknown as JsonValue,
        this.eventTimestampAtOrAfterLatest(input.sessionId, input.createdAt),
      );
      return { created: true, record };
    });
  }

  public editDraft(input: EditDraftInput): CreateResult<DraftRecord> {
    return this.atomic(() => {
      requiredId(input.draftId, "Draft ID");
      requiredId(input.eventId, "Draft edit event ID");
      requiredTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
      requiredRevision(input.artifactRevision);
      requiredConversationMode(input.mode);
      requiredTimestamp(input.updatedAt, "updatedAt");
      if (input.message.trim() === "") {
        throw new SessionStoreConflictError("Draft message cannot be empty");
      }
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, input.sessionId, "draft_updated", input.draftId);
        const eventData = existingEvent.data_json === null ? null : parseJson(existingEvent.data_json);
        const existingRecord = eventDraftRecord(
          eventData,
        );
        if (
          existingRecord === undefined ||
          !isJsonObject(eventData) ||
          eventData.expectedUpdatedAt !== input.expectedUpdatedAt ||
          existingRecord.artifactRevision !== input.artifactRevision ||
          existingRecord.mode !== input.mode ||
          existingRecord.message !== input.message ||
          stringifyJson(existingRecord.context) !== stringifyJson(input.context) ||
          existingRecord.updatedAt !== input.updatedAt
        ) {
          throw new SessionStoreConflictError(
            `Draft edit event ID ${input.eventId} already identifies different data`,
          );
        }
        return { created: false, record: existingRecord };
      }
      const draft = this.requiredDraft(input.draftId);
      if (draft.session_id !== input.sessionId) {
        throw new SessionStoreConflictError(
          `Draft ${input.draftId} does not belong to session ${input.sessionId}`,
        );
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(`Cannot edit a draft while session is ${session.state}`);
      }
      if (draft.updated_at !== input.expectedUpdatedAt) {
        throw new SessionStoreConflictError(
          "Draft changed; review the current draft before saving",
        );
      }
      requireAfter(
        input.updatedAt,
        draft.updated_at,
        "A draft edit must advance the current draft timestamp",
      );
      this.database.prepare(`
        UPDATE drafts
        SET artifact_revision = ?, mode = ?, message = ?, context_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.artifactRevision,
        input.mode,
        input.message,
        input.context === null ? null : stringifyJson(input.context),
        input.updatedAt,
        input.draftId,
      );
      const record = draftRecord(this.requiredDraft(input.draftId));
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "draft_updated",
        input.draftId,
        { draft: record, expectedUpdatedAt: input.expectedUpdatedAt } as unknown as JsonValue,
        this.eventTimestampAtOrAfterLatest(input.sessionId, input.updatedAt),
      );
      return { created: true, record };
    });
  }

  public removeDraft(input: RemoveDraftInput): CreateResult<DraftRecord> {
    return this.atomic(() => {
      requiredId(input.draftId, "Draft ID");
      requiredId(input.eventId, "Draft removal event ID");
      requiredTimestamp(input.expectedUpdatedAt, "expectedUpdatedAt");
      requiredTimestamp(input.removedAt, "removedAt");
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, input.sessionId, "draft_removed", input.draftId);
        const eventData = existingEvent.data_json === null ? null : parseJson(existingEvent.data_json);
        const existingRecord = eventDraftRecord(eventData);
        if (
          existingRecord === undefined ||
          !isJsonObject(eventData) ||
          existingRecord.updatedAt !== input.expectedUpdatedAt ||
          eventData.removedAt !== input.removedAt
        ) {
          throw new SessionStoreConflictError(
            `Draft removal event ID ${input.eventId} already identifies different data`,
          );
        }
        return { created: false, record: existingRecord };
      }
      const draft = this.requiredDraft(input.draftId);
      if (draft.session_id !== input.sessionId) {
        throw new SessionStoreConflictError(
          `Draft ${input.draftId} does not belong to session ${input.sessionId}`,
        );
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(`Cannot remove a draft while session is ${session.state}`);
      }
      if (draft.updated_at !== input.expectedUpdatedAt) {
        throw new SessionStoreConflictError(
          "Draft changed; review the current draft before removing",
        );
      }
      requireNotBefore(
        input.removedAt,
        draft.updated_at,
        "A draft removal cannot precede the current draft state",
      );
      const record = draftRecord(draft);
      this.database.prepare("DELETE FROM drafts WHERE id = ?").run(input.draftId);
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "draft_removed",
        input.draftId,
        { draft: record, removedAt: input.removedAt } as unknown as JsonValue,
        this.eventTimestampAtOrAfterLatest(input.sessionId, input.removedAt),
      );
      return { created: true, record };
    });
  }

  public sendDrafts(input: SendDraftsInput): SendDraftsResult {
    return this.atomic(() => {
      requiredId(input.eventId, "Draft send event ID");
      requiredTimestamp(input.sentAt, "sentAt");
      for (const draft of input.drafts) {
        requiredId(draft.id, "Draft ID");
        requiredTimestamp(draft.updatedAt, "Draft updatedAt");
      }
      if (new Set(input.drafts.map(({ id }) => id)).size !== input.drafts.length) {
        throw new SessionStoreConflictError("Draft send batch contains duplicate IDs");
      }
      if (input.composer !== null) {
        requiredRevision(input.composer.artifactRevision);
        if (input.composer.message.trim() === "") {
          throw new SessionStoreConflictError("Composer message cannot be empty");
        }
      }
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, input.sessionId, "drafts_sent", input.sessionId);
        const eventData = existingEvent.data_json === null ? null : parseJson(existingEvent.data_json);
        if (
          !isJsonObject(eventData) ||
          eventData.sentAt !== input.sentAt ||
          stringifyJson(eventData.drafts ?? null) !== stringifyJson(input.drafts) ||
          stringifyJson(eventData.composer ?? null) !== stringifyJson(input.composer) ||
          !Array.isArray(eventData.questionIds) ||
          !eventData.questionIds.every((id) => typeof id === "string")
        ) {
          throw new SessionStoreConflictError(
            `Draft send event ID ${input.eventId} already identifies different data`,
          );
        }
        return {
          created: false,
          questions: eventData.questionIds.map((id) => questionRecord(this.requiredQuestion(id))),
        };
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(`Cannot send drafts while session is ${session.state}`);
      }
      const drafts = this.database.prepare(
        "SELECT * FROM drafts WHERE session_id = ? ORDER BY draft_position ASC",
      ).all(input.sessionId) as unknown as DraftRow[];
      const currentBatch = drafts.map(({ id, updated_at: updatedAt }) => ({ id, updatedAt }));
      if (stringifyJson(currentBatch) !== stringifyJson(input.drafts)) {
        throw new SessionStoreConflictError(
          "Draft queue changed; review the current queue before sending",
        );
      }
      if (drafts.length === 0 && input.composer === null) {
        throw new SessionStoreStateError("There are no drafts or composer message to send");
      }
      for (const draft of drafts) {
        requireNotBefore(
          input.sentAt,
          draft.updated_at,
          "Drafts cannot be sent before their latest update",
        );
      }
      const next = this.database.prepare(
        "SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM questions WHERE session_id = ?",
      ).get(input.sessionId) as { position: number };
      const sources = [
        ...drafts.map((draft) => ({
          sourceKey: `draft\0${draft.id}`,
          artifactRevision: draft.artifact_revision,
          mode: draft.mode,
          message: draft.message,
          context: draft.context_json === null ? null : parseJson(draft.context_json),
        })),
        ...(input.composer === null
          ? []
          : [{
              sourceKey: "composer",
              artifactRevision: input.composer.artifactRevision,
              mode: session.conversation_mode,
              message: input.composer.message,
              context: input.composer.context,
            }]),
      ];
      const eventOccurredAt = this.eventTimestampAtOrAfterLatest(input.sessionId, input.sentAt);
      const questions = sources.map((source, index) => {
        const id = sentQuestionId(input.eventId, source.sourceKey);
        const queuePosition = next.position + index;
        this.database.prepare(`
          INSERT INTO questions (
            id, session_id, artifact_revision, queue_position, state, message,
            context_json, created_at, updated_at, current_lease_id, mode
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, ?)
        `).run(
          id,
          input.sessionId,
          source.artifactRevision,
          queuePosition,
          source.message,
          source.context === null ? null : stringifyJson(source.context),
          input.sentAt,
          input.sentAt,
          source.mode,
        );
        this.appendEvent(
          sentQuestionEventId(input.eventId, id),
          input.sessionId,
          "question_queued",
          id,
          {
            artifactRevision: source.artifactRevision,
            context: source.context,
            createdAt: input.sentAt,
            message: source.message,
            mode: source.mode,
            queuePosition,
          },
          eventOccurredAt,
        );
        return questionRecord(this.requiredQuestion(id));
      });
      this.database.prepare("DELETE FROM drafts WHERE session_id = ?").run(input.sessionId);
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "drafts_sent",
        input.sessionId,
        {
          composer: input.composer,
          drafts: input.drafts,
          draftIds: drafts.map(({ id }) => id),
          questionIds: questions.map(({ id }) => id),
          sentAt: input.sentAt,
        },
        eventOccurredAt,
      );
      return { created: true, questions };
    });
  }

  public enqueueQuestion(input: EnqueueQuestionInput): CreateResult<QuestionRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Question ID");
      requiredRevision(input.artifactRevision);
      requiredTimestamp(input.createdAt, "createdAt");
      if (input.message.trim() === "") throw new SessionStoreConflictError("Question message cannot be empty");
      const existing = this.questionById(input.id);
      if (existing !== undefined) {
        const existingEvent = this.eventById(input.id);
        if (
          existingEvent === undefined ||
          existingEvent.session_id !== input.sessionId ||
          existingEvent.type !== "question_queued" ||
          existingEvent.entity_id !== input.id ||
          existingEvent.data_json === null ||
          !jsonTextEquals(existingEvent.data_json, {
            artifactRevision: input.artifactRevision,
            context: input.context,
            createdAt: input.createdAt,
            message: input.message,
            mode: existing.mode,
            queuePosition: existing.queue_position,
          })
        ) throw new SessionStoreConflictError(`Question ID ${input.id} already identifies different data`);
        return { created: false, record: questionRecord(existing) };
      }
      const session = this.requiredSession(input.sessionId);
      if (session.state === "ending" || session.state === "ended") {
        throw new SessionStoreStateError(`Cannot queue a question while session is ${session.state}`);
      }
      requireNotBefore(
        input.createdAt,
        session.updated_at,
        "A question cannot be queued before the current session state",
      );
      const next = this.database.prepare(
        "SELECT COALESCE(MAX(queue_position), 0) + 1 AS position FROM questions WHERE session_id = ?",
      ).get(input.sessionId) as { position: number };
      const eventOccurredAt = this.eventTimestampAtOrAfterLatest(input.sessionId, input.createdAt);
      this.database.prepare(`
        INSERT INTO questions (
          id, session_id, artifact_revision, queue_position, state, message,
          context_json, created_at, updated_at, current_lease_id, mode
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, NULL, ?)
      `).run(
        input.id,
        input.sessionId,
        input.artifactRevision,
        next.position,
        input.message,
        input.context === null ? null : stringifyJson(input.context),
        input.createdAt,
        input.createdAt,
        session.conversation_mode,
      );
      this.appendEvent(
        input.id,
        input.sessionId,
        "question_queued",
        input.id,
        {
          artifactRevision: input.artifactRevision,
          context: input.context,
          createdAt: input.createdAt,
          message: input.message,
          mode: session.conversation_mode,
          queuePosition: next.position,
        },
        eventOccurredAt,
      );
      return { created: true, record: questionRecord(this.requiredQuestion(input.id)) };
    });
  }

  public editQuestion(input: EditQuestionInput): CreateResult<QuestionRecord> {
    return this.atomic(() => {
      requiredId(input.sessionId, "Question edit session ID");
      requiredId(input.eventId, "Question edit event ID");
      requiredTimestamp(input.updatedAt, "updatedAt");
      if (input.message.trim() === "") throw new SessionStoreConflictError("Question message cannot be empty");
      const question = this.requiredQuestion(input.questionId);
      if (question.session_id !== input.sessionId) {
        throw new SessionStoreConflictError(
          `Question ${input.questionId} does not belong to session ${input.sessionId}`,
        );
      }
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, question.session_id, "question_edited", input.questionId);
        if (
          existingEvent.data_json === null ||
          !jsonTextEquals(existingEvent.data_json, {
            context: input.context,
            message: input.message,
            updatedAt: input.updatedAt,
          })
        ) {
          throw new SessionStoreConflictError(
            `Question edit event ID ${input.eventId} already identifies different data`,
          );
        }
        return { created: false, record: questionRecord(question) };
      }
      this.assertQuestionSessionMutable(question);
      if (question.state !== "queued") {
        throw new SessionStoreStateError(`Only queued questions can be edited, not ${question.state}`);
      }
      requireNotBefore(
        input.updatedAt,
        question.updated_at,
        "A question edit cannot precede the current question state",
      );
      const eventOccurredAt = this.eventTimestampAtOrAfterLatest(
        question.session_id,
        input.updatedAt,
      );
      this.database.prepare(
        "UPDATE questions SET message = ?, context_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        input.message,
        input.context === null ? null : stringifyJson(input.context),
        input.updatedAt,
        input.questionId,
      );
      this.appendEvent(
        input.eventId,
        question.session_id,
        "question_edited",
        input.questionId,
        { context: input.context, message: input.message, updatedAt: input.updatedAt },
        eventOccurredAt,
      );
      return { created: true, record: questionRecord(this.requiredQuestion(input.questionId)) };
    });
  }

  public cancelQuestion(input: CancelQuestionInput): CreateResult<QuestionRecord> {
    return this.atomic(() => {
      requiredId(input.sessionId, "Question cancellation session ID");
      requiredId(input.eventId, "Question cancellation event ID");
      requiredTimestamp(input.cancelledAt, "cancelledAt");
      const question = this.requiredQuestion(input.questionId);
      if (question.session_id !== input.sessionId) {
        throw new SessionStoreConflictError(
          `Question ${input.questionId} does not belong to session ${input.sessionId}`,
        );
      }
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(existingEvent, question.session_id, "question_cancelled", input.questionId);
        if (
          existingEvent.data_json === null ||
          !jsonTextEquals(existingEvent.data_json, { cancelledAt: input.cancelledAt })
        ) {
          throw new SessionStoreConflictError(
            `Question cancellation event ID ${input.eventId} already identifies different data`,
          );
        }
        return { created: false, record: questionRecord(question) };
      }
      this.assertQuestionSessionMutable(question);
      if (question.state !== "queued") {
        throw new SessionStoreStateError(`Only queued questions can be cancelled, not ${question.state}`);
      }
      requireNotBefore(
        input.cancelledAt,
        question.updated_at,
        "A question cancellation cannot precede the current question state",
      );
      const eventOccurredAt = this.eventTimestampAtOrAfterLatest(
        question.session_id,
        input.cancelledAt,
      );
      this.database.prepare("UPDATE questions SET state = 'cancelled', updated_at = ? WHERE id = ?")
        .run(input.cancelledAt, input.questionId);
      this.appendEvent(
        input.eventId,
        question.session_id,
        "question_cancelled",
        input.questionId,
        { cancelledAt: input.cancelledAt },
        eventOccurredAt,
      );
      return { created: true, record: questionRecord(this.requiredQuestion(input.questionId)) };
    });
  }

  public leaseNextQuestion(input: LeaseQuestionInput): CreateResult<DeliveryLeaseRecord> | undefined {
    return this.atomic(() => {
      requiredId(input.id, "Lease ID");
      requiredTimestamp(input.leasedAt, "leasedAt");
      requiredTimestamp(input.expiresAt, "expiresAt");
      if (compareProtocolTimestamps(input.expiresAt, input.leasedAt) <= 0) {
        throw new SessionStoreConflictError("A delivery lease must expire after it begins");
      }
      const existing = this.leaseById(input.id);
      if (existing !== undefined) {
        if (
          existing.session_id !== input.sessionId ||
          existing.leased_at !== input.leasedAt ||
          existing.expires_at !== input.expiresAt
        ) {
          throw new SessionStoreConflictError(`Lease ID ${input.id} already identifies different data`);
        }
        return { created: false, record: leaseRecord(existing) };
      }
      const session = this.requiredSession(input.sessionId);
      this.releaseExpiredLeases(input.sessionId, input.leasedAt);
      if (session.state === "ending" || session.state === "ended") return undefined;
      const next = this.database.prepare(`
        SELECT * FROM questions
        WHERE session_id = ? AND state IN ('queued', 'leased')
        ORDER BY queue_position ASC
        LIMIT 1
      `).get(input.sessionId) as QuestionRow | undefined;
      if (next === undefined || next.state === "leased") return undefined;
      requireNotBefore(
        input.leasedAt,
        next.updated_at,
        "A delivery lease cannot precede the current question state",
      );
      this.database.prepare(`
        INSERT INTO delivery_leases (
          id, session_id, question_id, leased_at, expires_at, released_at, release_reason
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `).run(input.id, input.sessionId, next.id, input.leasedAt, input.expiresAt);
      this.database.prepare(
        "UPDATE questions SET state = 'leased', current_lease_id = ?, updated_at = ? WHERE id = ?",
      ).run(input.id, input.leasedAt, next.id);
      this.appendEvent(
        input.id,
        input.sessionId,
        "question_leased",
        next.id,
        { expiresAt: input.expiresAt, leaseId: input.id },
        input.leasedAt,
      );
      return { created: true, record: leaseRecord(this.requiredLease(input.id)) };
    });
  }

  public acknowledgeQuestion(input: AcknowledgeQuestionInput): CreateResult<AcknowledgementRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Acknowledgement ID");
      requiredTimestamp(input.acknowledgedAt, "acknowledgedAt");
      const existingForQuestion = this.database.prepare(
        "SELECT * FROM acknowledgements WHERE question_id = ?",
      ).get(input.questionId) as AcknowledgementRow | undefined;
      if (existingForQuestion !== undefined) {
        if (
          existingForQuestion.id !== input.id ||
          existingForQuestion.session_id !== input.sessionId ||
          existingForQuestion.question_id !== input.questionId ||
          existingForQuestion.lease_id !== input.leaseId ||
          existingForQuestion.acknowledged_at !== input.acknowledgedAt
        ) {
          throw new SessionStoreConflictError(
            `Question ${input.questionId} already has an acknowledgement with different data`,
          );
        }
        return { created: false, record: acknowledgementRecord(existingForQuestion) };
      }
      const colliding = this.acknowledgementById(input.id);
      if (colliding !== undefined) {
        throw new SessionStoreConflictError(`Acknowledgement ID ${input.id} identifies another question`);
      }
      const question = this.requiredQuestion(input.questionId);
      this.assertQuestionSessionMutable(question);
      if (
        question.session_id !== input.sessionId ||
        question.state !== "leased" ||
        question.current_lease_id !== input.leaseId
      ) throw new SessionStoreStateError("Only the current delivery lease can be acknowledged");
      const lease = this.requiredLease(input.leaseId);
      requireNotBefore(
        input.acknowledgedAt,
        lease.leased_at,
        "An acknowledgement cannot precede its delivery lease",
      );
      requireNotBefore(
        input.acknowledgedAt,
        question.updated_at,
        "An acknowledgement cannot precede the current question state",
      );
      if (
        lease.released_at !== null ||
        compareProtocolTimestamps(lease.expires_at, input.acknowledgedAt) <= 0
      ) {
        throw new SessionStoreStateError("The delivery lease expired before acknowledgement");
      }
      this.database.prepare(`
        INSERT INTO acknowledgements (id, session_id, question_id, lease_id, acknowledged_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.id, input.sessionId, input.questionId, input.leaseId, input.acknowledgedAt);
      this.database.prepare(`
        UPDATE delivery_leases SET released_at = ?, release_reason = 'acknowledged' WHERE id = ?
      `).run(input.acknowledgedAt, input.leaseId);
      this.database.prepare(`
        UPDATE questions SET state = 'acknowledged', current_lease_id = NULL, updated_at = ? WHERE id = ?
      `).run(input.acknowledgedAt, input.questionId);
      this.appendEvent(
        agentOperationEventId("question_acknowledged", input.id),
        input.sessionId,
        "question_acknowledged",
        input.questionId,
        { leaseId: input.leaseId },
        input.acknowledgedAt,
      );
      return { created: true, record: acknowledgementRecord(this.requiredAcknowledgement(input.id)) };
    });
  }

  public recordStatus(input: RecordStatusInput): CreateResult<StatusRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Status ID");
      requiredTimestamp(input.createdAt, "createdAt");
      if (input.status.trim() === "") throw new SessionStoreConflictError("Status cannot be empty");
      const existing = this.statusById(input.id);
      if (existing !== undefined) {
        if (
          existing.question_id !== input.questionId ||
          existing.session_id !== input.sessionId ||
          existing.status !== input.status ||
          (input.detail === null
            ? existing.detail_json !== null
            : existing.detail_json === null || !jsonTextEquals(existing.detail_json, input.detail)) ||
          existing.created_at !== input.createdAt
        ) {
          throw new SessionStoreConflictError(`Status ID ${input.id} identifies another question`);
        }
        return { created: false, record: statusRecord(existing) };
      }
      const question = this.requiredQuestion(input.questionId);
      this.assertQuestionSessionMutable(question);
      if (question.session_id !== input.sessionId || question.state !== "acknowledged") {
        throw new SessionStoreStateError("Statuses can only be recorded for an acknowledged question");
      }
      requireNotBefore(
        input.createdAt,
        question.updated_at,
        "A status cannot precede the current question state",
      );
      this.database.prepare(`
        INSERT INTO statuses (id, session_id, question_id, status, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.questionId,
        input.status,
        input.detail === null ? null : stringifyJson(input.detail),
        input.createdAt,
      );
      this.appendEvent(
        agentOperationEventId("status_recorded", input.id),
        input.sessionId,
        "status_recorded",
        input.id,
        { detail: input.detail, questionId: input.questionId, status: input.status },
        input.createdAt,
      );
      return { created: true, record: statusRecord(this.requiredStatus(input.id)) };
    });
  }

  public recordReply(input: RecordReplyInput): CreateResult<ReplyRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Reply ID");
      requiredTimestamp(input.createdAt, "createdAt");
      const existingForQuestion = this.database.prepare("SELECT * FROM replies WHERE question_id = ?")
        .get(input.questionId) as ReplyRow | undefined;
      if (existingForQuestion !== undefined) {
        if (
          existingForQuestion.id !== input.id ||
          existingForQuestion.session_id !== input.sessionId ||
          existingForQuestion.outcome !== input.outcome ||
          !jsonTextEquals(existingForQuestion.content_json, input.content) ||
          existingForQuestion.created_at !== input.createdAt
        ) {
          throw new SessionStoreConflictError(
            `Question ${input.questionId} already has a reply with different data`,
          );
        }
        return { created: false, record: replyRecord(existingForQuestion) };
      }
      const colliding = this.replyById(input.id);
      if (colliding !== undefined) {
        throw new SessionStoreConflictError(`Reply ID ${input.id} identifies another question`);
      }
      const question = this.requiredQuestion(input.questionId);
      this.assertQuestionSessionMutable(question);
      if (question.session_id !== input.sessionId || question.state !== "acknowledged") {
        throw new SessionStoreStateError("Replies can only complete an acknowledged question");
      }
      requireNotBefore(
        input.createdAt,
        question.updated_at,
        "A reply cannot precede the current question state",
      );
      this.database.prepare(`
        INSERT INTO replies (id, session_id, question_id, outcome, content_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.questionId,
        input.outcome,
        stringifyJson(input.content),
        input.createdAt,
      );
      this.database.prepare("UPDATE questions SET state = ?, updated_at = ? WHERE id = ?")
        .run(input.outcome === "answer" ? "answered" : "failed", input.createdAt, input.questionId);
      this.appendEvent(
        agentOperationEventId("reply_recorded", input.id),
        input.sessionId,
        "reply_recorded",
        input.questionId,
        { outcome: input.outcome },
        input.createdAt,
      );
      return { created: true, record: replyRecord(this.requiredReply(input.id)) };
    });
  }

  public initializeWalkthroughState(
    input: InitializeWalkthroughStateInput,
  ): CreateResult<WalkthroughStateRecord> {
    return this.atomic(() => {
      requiredRevision(input.revision);
      requiredTimestamp(input.updatedAt, "updatedAt");
      this.requiredSession(input.sessionId);
      const existing = this.database.prepare("SELECT * FROM walkthrough_states WHERE session_id = ?")
        .get(input.sessionId) as WalkthroughStateRow | undefined;
      if (existing !== undefined) return { created: false, record: walkthroughStateRecord(existing) };
      this.database.prepare(`
        INSERT INTO walkthrough_states (session_id, artifact_json, revision, updated_at) VALUES (?, ?, ?, ?)
      `).run(input.sessionId, stringifyJson(input.artifact), input.revision, input.updatedAt);
      const created = this.database.prepare("SELECT * FROM walkthrough_states WHERE session_id = ?")
        .get(input.sessionId) as unknown as WalkthroughStateRow;
      return { created: true, record: walkthroughStateRecord(created) };
    });
  }

  public updateWalkthroughState(
    input: UpdateWalkthroughStateInput,
  ): CreateResult<WalkthroughStateRecord> {
    return this.atomic(() => {
      requiredRevision(input.expectedRevision);
      requiredRevision(input.revision);
      requiredTimestamp(input.updatedAt, "updatedAt");
      this.assertSessionAllowsSemanticUpdates(input.sessionId);
      const existing = this.database.prepare("SELECT * FROM walkthrough_states WHERE session_id = ?")
        .get(input.sessionId) as WalkthroughStateRow | undefined;
      if (existing === undefined) throw new SessionStoreStateError("Walkthrough state is not initialized");
      if (existing.revision !== input.expectedRevision) {
        throw new SessionStoreConflictError(
          `Expected walkthrough revision ${input.expectedRevision}, current revision is ${existing.revision}`,
        );
      }
      if (input.revision !== input.expectedRevision + 1) {
        throw new SessionStoreConflictError("A Walkthrough Update must produce exactly one new revision");
      }
      requireNotBefore(input.updatedAt, existing.updated_at, "A Walkthrough Update cannot move backward in time");
      this.database.prepare(`
        UPDATE walkthrough_states SET artifact_json = ?, revision = ?, updated_at = ? WHERE session_id = ?
      `).run(stringifyJson(input.artifact), input.revision, input.updatedAt, input.sessionId);
      const updated = this.database.prepare("SELECT * FROM walkthrough_states WHERE session_id = ?")
        .get(input.sessionId) as unknown as WalkthroughStateRow;
      return { created: true, record: walkthroughStateRecord(updated) };
    });
  }

  public recordWalkthroughUpdateOutcome(
    input: RecordWalkthroughUpdateOutcomeInput,
  ): CreateResult<WalkthroughUpdateOutcomeRecord> {
    return this.atomic(() => {
      requiredId(input.eventId, "Walkthrough Update event ID");
      requiredTimestamp(input.updatedAt, "updatedAt");
      this.assertSessionAllowsSemanticUpdates(input.sessionId);
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent !== undefined) {
        this.assertEventIdentity(
          existingEvent,
          input.sessionId,
          "walkthrough_update_recorded",
          input.questionId,
        );
        const existingOutcome = this.database.prepare(
          "SELECT * FROM walkthrough_update_outcomes WHERE question_id = ?",
        ).get(input.questionId) as WalkthroughUpdateOutcomeRow | undefined;
        if (existingOutcome === undefined || !jsonTextEquals(existingOutcome.outcome_json, input.outcome)) {
          throw new SessionStoreConflictError(`Event ${input.eventId} has a different Walkthrough Update outcome`);
        }
        return { created: false, record: walkthroughUpdateOutcomeRecord(existingOutcome) };
      }
      const question = this.requiredQuestion(input.questionId);
      if (question.session_id !== input.sessionId) {
        throw new SessionStoreConflictError("Walkthrough Update outcome belongs to another session");
      }
      const existing = this.database.prepare(
        "SELECT * FROM walkthrough_update_outcomes WHERE question_id = ?",
      ).get(input.questionId) as WalkthroughUpdateOutcomeRow | undefined;
      if (existing !== undefined && jsonTextEquals(existing.outcome_json, input.outcome)) {
        return { created: false, record: walkthroughUpdateOutcomeRecord(existing) };
      }
      if (existing === undefined) {
        this.database.prepare(`
          INSERT INTO walkthrough_update_outcomes (question_id, session_id, outcome_json, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(input.questionId, input.sessionId, stringifyJson(input.outcome), input.updatedAt);
      } else {
        requireNotBefore(input.updatedAt, existing.updated_at, "A Walkthrough Update retry cannot move backward in time");
        this.database.prepare(`
          UPDATE walkthrough_update_outcomes SET outcome_json = ?, updated_at = ? WHERE question_id = ?
        `).run(stringifyJson(input.outcome), input.updatedAt, input.questionId);
      }
      const recorded = this.database.prepare(
        "SELECT * FROM walkthrough_update_outcomes WHERE question_id = ?",
      ).get(input.questionId) as unknown as WalkthroughUpdateOutcomeRow;
      this.appendEvent(
        input.eventId,
        input.sessionId,
        "walkthrough_update_recorded",
        input.questionId,
        input.outcome,
        input.updatedAt,
      );
      return { created: true, record: walkthroughUpdateOutcomeRecord(recorded) };
    });
  }

  public advanceCursor(input: AdvanceCursorInput): CreateResult<CursorRecord> {
    return this.atomic(() => {
      requiredId(input.id, "Cursor ID");
      requiredTimestamp(input.updatedAt, "updatedAt");
      if (input.consumer.trim() === "") {
        throw new SessionStoreConflictError("Cursor consumer cannot be empty");
      }
      if (!Number.isSafeInteger(input.lastSequence) || input.lastSequence < 0) {
        throw new SessionStoreConflictError("Cursor sequence must be a non-negative safe integer");
      }
      this.requiredSession(input.sessionId);
      if (
        input.lastSequence !== 0 &&
        this.database.prepare(
          "SELECT 1 FROM session_events WHERE session_id = ? AND sequence = ?",
        ).get(input.sessionId, input.lastSequence) === undefined
      ) {
        throw new SessionStoreConflictError(
          `Cursor sequence ${input.lastSequence} is not committed for session ${input.sessionId}`,
        );
      }
      const existingByConsumer = this.database.prepare(
        "SELECT * FROM cursors WHERE session_id = ? AND consumer = ?",
      ).get(input.sessionId, input.consumer) as CursorRow | undefined;
      if (existingByConsumer !== undefined) {
        if (existingByConsumer.id !== input.id) {
          throw new SessionStoreConflictError("A cursor consumer must retain its stable cursor ID");
        }
        if (input.lastSequence <= existingByConsumer.last_sequence) {
          return { created: false, record: cursorRecord(existingByConsumer) };
        }
        requireNotBefore(
          input.updatedAt,
          existingByConsumer.updated_at,
          "A forward cursor update cannot precede the current cursor state",
        );
        this.database.prepare("UPDATE cursors SET last_sequence = ?, updated_at = ? WHERE id = ?")
          .run(input.lastSequence, input.updatedAt, input.id);
        return { created: true, record: cursorRecord(this.requiredCursor(input.id)) };
      }
      if (this.cursorById(input.id) !== undefined) {
        throw new SessionStoreConflictError(`Cursor ID ${input.id} belongs to another consumer`);
      }
      this.database.prepare(`
        INSERT INTO cursors (id, session_id, consumer, last_sequence, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.id, input.sessionId, input.consumer, input.lastSequence, input.updatedAt);
      return { created: true, record: cursorRecord(this.requiredCursor(input.id)) };
    });
  }

  public listEvents(sessionId: string, afterSequence = 0): readonly DurableEventRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(sessionId, afterSequence) as unknown as EventRow[]).map(eventRecord);
  }

  public getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.readTransaction(() => {
      const session = this.sessionById(sessionId);
      if (session === undefined) return undefined;
      const drafts = (this.database.prepare(
        "SELECT * FROM drafts WHERE session_id = ? ORDER BY draft_position ASC",
      ).all(sessionId) as unknown as DraftRow[]).map(draftRecord);
      const questions = (this.database.prepare(
        "SELECT * FROM questions WHERE session_id = ? ORDER BY queue_position ASC",
      ).all(sessionId) as unknown as QuestionRow[]).map(questionRecord);
      const leases = (this.database.prepare(
        "SELECT * FROM delivery_leases WHERE session_id = ? ORDER BY leased_at, id",
      ).all(sessionId) as unknown as LeaseRow[]).map(leaseRecord);
      const acknowledgements = (this.database.prepare(
        "SELECT * FROM acknowledgements WHERE session_id = ? ORDER BY acknowledged_at, id",
      ).all(sessionId) as unknown as AcknowledgementRow[]).map(acknowledgementRecord);
      const statuses = (this.database.prepare(
        `
          SELECT statuses.* FROM statuses
          INNER JOIN session_events event
            ON event.session_id = statuses.session_id
            AND event.type = 'status_recorded'
            AND event.entity_id = statuses.id
          WHERE statuses.session_id = ?
          ORDER BY event.sequence
        `,
      ).all(sessionId) as unknown as StatusRow[]).map(statusRecord);
      const replies = (this.database.prepare(
        "SELECT * FROM replies WHERE session_id = ? ORDER BY created_at, id",
      ).all(sessionId) as unknown as ReplyRow[]).map(replyRecord);
      const walkthroughStateRow = this.database.prepare(
        "SELECT * FROM walkthrough_states WHERE session_id = ?",
      ).get(sessionId) as WalkthroughStateRow | undefined;
      const walkthroughUpdateOutcomes = (this.database.prepare(`
        SELECT * FROM walkthrough_update_outcomes WHERE session_id = ? ORDER BY updated_at, question_id
      `).all(sessionId) as unknown as WalkthroughUpdateOutcomeRow[]).map(walkthroughUpdateOutcomeRecord);
      const cursors = (this.database.prepare(
        "SELECT * FROM cursors WHERE session_id = ? ORDER BY consumer, id",
      ).all(sessionId) as unknown as CursorRow[]).map(cursorRecord);
      return {
        session: sessionRecord(session),
        drafts,
        questions,
        leases,
        acknowledgements,
        statuses,
        replies,
        ...(walkthroughStateRow === undefined
          ? {}
          : { walkthroughState: walkthroughStateRecord(walkthroughStateRow) }),
        walkthroughUpdateOutcomes,
        cursors,
        events: this.listEvents(sessionId),
      };
    });
  }

  public close(): void {
    if (this.closed) return;
    if (this.transactionDepth > 0) throw new SessionStoreStateError("Cannot close during a transaction");
    if (this.claimedRuntimeOwnership.size > 0) {
      const release = this.database.prepare(
        "DELETE FROM runtime_ownership WHERE owner_id = ? AND process_id = ?",
      );
      for (const [ownerId, ownership] of this.claimedRuntimeOwnership) {
        clearInterval(ownership.heartbeat);
        release.run(ownerId, process.pid);
      }
    }
    this.claimedRuntimeOwnership.clear();
    this.database.close();
    this.closed = true;
  }

  private enableWriteAheadLogging(): void {
    const retryDeadline = Date.now() + SESSION_STORE_BUSY_TIMEOUT_MS;
    let lastBusyError: unknown;
    let remainingMs = SESSION_STORE_BUSY_TIMEOUT_MS;
    while (remainingMs > 0) {
      try {
        this.database.exec("PRAGMA journal_mode = WAL;");
        return;
      } catch (error) {
        if (!isSqliteBusy(error)) {
          this.database.close();
          throw new SessionStoreMigrationError(
            "Could not enable write-ahead logging for the Live Session database",
            { cause: error },
          );
        }
        lastBusyError = error;
        remainingMs = retryDeadline - Date.now();
        if (remainingMs > 0) {
          Atomics.wait(
            sqliteBusyRetryWaiter,
            0,
            0,
            Math.min(SESSION_STORE_BUSY_RETRY_DELAY_MS, remainingMs),
          );
        }
      }
    }
    this.database.close();
    throw new SessionStoreMigrationError(
      "Timed out while enabling write-ahead logging for the Live Session database",
      { cause: lastBusyError },
    );
  }

  private migrate(): void {
    const version = (this.database.prepare("PRAGMA user_version").get() as unknown as VersionRow).user_version;
    if (version > SESSION_STORE_SCHEMA_VERSION) {
      this.database.close();
      throw new SessionStoreMigrationError(
        `Session database schema ${version} is newer than supported schema ${SESSION_STORE_SCHEMA_VERSION}`,
      );
    }
    if (version === SESSION_STORE_SCHEMA_VERSION) {
      const integrity = this.database.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (integrity.quick_check !== "ok") {
        this.database.close();
        throw new SessionStoreMigrationError(`Session database failed integrity check: ${integrity.quick_check}`);
      }
      return;
    }
    this.database.exec("BEGIN EXCLUSIVE");
    try {
      const lockedVersion = (
        this.database.prepare("PRAGMA user_version").get() as unknown as VersionRow
      ).user_version;
      if (lockedVersion > SESSION_STORE_SCHEMA_VERSION) {
        throw new SessionStoreMigrationError(
          `Session database schema ${lockedVersion} is newer than supported schema ${SESSION_STORE_SCHEMA_VERSION}`,
        );
      }
      if (lockedVersion < 1) {
        this.database.exec(MIGRATION_1);
        this.database.exec("PRAGMA user_version = 1");
      }
      if (lockedVersion < 2) {
        this.migrateStatusEvents();
        this.database.exec("PRAGMA user_version = 2");
      }
      if (lockedVersion < 3) {
        this.database.exec(MIGRATION_3);
        this.database.exec("PRAGMA user_version = 3");
      }
      if (lockedVersion < 4) {
        this.database.exec(MIGRATION_4);
        this.database.exec("PRAGMA user_version = 4");
      }
      if (lockedVersion < 5) {
        this.database.exec(MIGRATION_5);
        this.database.exec("PRAGMA user_version = 5");
      }
      if (lockedVersion < 6) {
        this.migrateRepositoryKeys();
        this.database.exec("PRAGMA user_version = 6");
      }
      if (lockedVersion < 7) {
        this.migrateRepositoryKeys();
        this.reconcileActiveSessions();
        this.database.exec(MIGRATION_7);
        this.database.exec("PRAGMA user_version = 7");
      }
      if (lockedVersion < 8) {
        const hasRepositoryScope = (this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{
          name: string;
        }>).some(({ name }) => name === "repository_scope");
        if (!hasRepositoryScope) this.database.exec(MIGRATION_8);
        this.migrateRepositoryKeys();
        this.database.exec("PRAGMA user_version = 8");
      }
      if (lockedVersion < 9) {
        this.database.exec(MIGRATION_9);
        this.database.exec("PRAGMA user_version = 9");
      }
      if (lockedVersion < 10) {
        const hasHeartbeat = (this.database.prepare("PRAGMA table_info(runtime_ownership)").all() as Array<{
          name: string;
        }>).some(({ name }) => name === "heartbeat_at");
        if (!hasHeartbeat) {
          this.database.exec("ALTER TABLE runtime_ownership ADD COLUMN heartbeat_at INTEGER");
        }
        this.database.exec("UPDATE runtime_ownership SET heartbeat_at = 0 WHERE heartbeat_at IS NULL");
        this.database.exec("PRAGMA user_version = 10");
      }
      if (lockedVersion < 11) {
        const sessionColumns = (this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{
          name: string;
        }>).map(({ name }) => name);
        if (!sessionColumns.includes("conversation_mode")) {
          this.database.exec(`
            ALTER TABLE sessions ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'analyze'
              CHECK (conversation_mode IN ('analyze', 'learn'))
          `);
        }
        const questionColumns = (this.database.prepare("PRAGMA table_info(questions)").all() as Array<{
          name: string;
        }>).map(({ name }) => name);
        if (!questionColumns.includes("mode")) {
          this.database.exec(`
            ALTER TABLE questions ADD COLUMN mode TEXT NOT NULL DEFAULT 'analyze'
              CHECK (mode IN ('analyze', 'learn'))
          `);
        }
        this.database.exec(MIGRATION_11);
        this.database.exec("PRAGMA user_version = 11");
      }
      if (lockedVersion < 12) {
        this.database.exec(MIGRATION_12);
        this.database.exec("PRAGMA user_version = 12");
      }
      if (lockedVersion < 13) {
        this.database.exec(MIGRATION_13);
        this.database.exec("PRAGMA user_version = 13");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.database.close();
      throw new SessionStoreMigrationError("Could not migrate the Live Session database", { cause: error });
    }
  }

  private migrateRepositoryKeys(): void {
    const sessions = this.database.prepare("SELECT * FROM sessions ORDER BY id")
      .all() as unknown as SessionRow[];
    const storesScope = (this.database.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>).some(({ name }) => name === "repository_scope");
    const updateSession = this.database.prepare(storesScope
      ? "UPDATE sessions SET repository_key = ?, repository_scope = ? WHERE id = ?"
      : "UPDATE sessions SET repository_key = ? WHERE id = ?");
    const creationEvent = this.database.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND type = 'session_created' AND entity_id = ?
      LIMIT 1
    `);
    const updateEvent = this.database.prepare("UPDATE session_events SET data_json = ? WHERE id = ?");
    const walkthroughState = this.database.prepare(
      "SELECT * FROM walkthrough_states WHERE session_id = ?",
    );
    const updateWalkthroughState = this.database.prepare(
      "UPDATE walkthrough_states SET artifact_json = ? WHERE session_id = ?",
    );
    for (const session of sessions) {
      const state = walkthroughState.get(session.id) as WalkthroughStateRow | undefined;
      const artifact = state === undefined
        ? undefined
        : WalkthroughArtifactSchema.safeParse(parseJson(state.artifact_json));
      const normalizedArtifact = artifact?.success === true
        ? normalizeArtifactRepository(artifact.data)
        : undefined;
      const repositoryKey = normalizedArtifact?.identity.key ?? (
        legacyRepositoryRoot(session.repository_key)
          ? repositoryIdentity(session.repository_key).key
          : session.repository_key
      );
      const repositoryScope = normalizedArtifact?.identity.scope;
      if (storesScope) updateSession.run(repositoryKey, repositoryScope ?? null, session.id);
      else updateSession.run(repositoryKey, session.id);
      const event = creationEvent.get(session.id, session.id) as EventRow | undefined;
      if (event !== undefined && event.data_json !== null) {
        const data = parseJson(event.data_json);
        if (isJsonObject(data)) {
          const eventData = Object.fromEntries(
            Object.entries(data).filter(([key]) => key !== "repositoryScope"),
          );
          updateEvent.run(stringifyJson({
            ...eventData,
            repositoryKey,
            ...(repositoryScope === undefined ? {} : { repositoryScope }),
          }), event.id);
        }
      }
      if (state === undefined || normalizedArtifact === undefined) continue;
      updateWalkthroughState.run(
        stringifyJson(normalizedArtifact.artifact as unknown as JsonValue),
        session.id,
      );
    }
  }

  private reconcileActiveSessions(): void {
    const activeSessions = (this.database.prepare(`
      SELECT * FROM sessions
      WHERE state != 'ended'
    `).all() as unknown as SessionRow[]).sort((left, right) => {
      const updatedOrder = compareProtocolTimestamps(right.updated_at, left.updated_at);
      if (updatedOrder !== 0) return updatedOrder;
      const createdOrder = compareProtocolTimestamps(right.created_at, left.created_at);
      return createdOrder !== 0 ? createdOrder : right.id.localeCompare(left.id);
    });
    for (const session of activeSessions.slice(1)) {
      const timestamps = (this.database.prepare(`
        SELECT updated_at AS value FROM sessions WHERE id = ?
        UNION ALL SELECT updated_at FROM questions WHERE session_id = ?
        UNION ALL SELECT occurred_at FROM session_events WHERE session_id = ?
        UNION ALL SELECT updated_at FROM walkthrough_states WHERE session_id = ?
        UNION ALL SELECT updated_at FROM walkthrough_update_outcomes WHERE session_id = ?
        UNION ALL SELECT updated_at FROM cursors WHERE session_id = ?
      `).all(
        session.id,
        session.id,
        session.id,
        session.id,
        session.id,
        session.id,
      ) as unknown as Array<{ value: string }>).map(({ value }) => value);
      const occurredAt = timestamps.reduce((latest, candidate) => (
        compareProtocolTimestamps(candidate, latest) > 0 ? candidate : latest
      ), session.updated_at);
      const digest = createHash("sha256").update(session.id).digest("hex").slice(0, 32);
      const endingEventId = `migration-v7-ending-${digest}`;
      const endedEventId = `migration-v7-ended-${digest}`;

      if (session.state !== "ending") {
        this.database.prepare("UPDATE sessions SET state = 'ending', updated_at = ? WHERE id = ?")
          .run(occurredAt, session.id);
        this.appendEvent(
          endingEventId,
          session.id,
          "session_transitioned",
          session.id,
          { from: session.state, to: "ending" },
          occurredAt,
        );
      }

      const unfinishedQuestions = this.database.prepare(`
        SELECT * FROM questions
        WHERE session_id = ? AND state NOT IN ('answered', 'cancelled', 'failed')
        ORDER BY queue_position ASC
      `).all(session.id) as unknown as QuestionRow[];
      for (const question of unfinishedQuestions) {
        if (question.state === "leased" && question.current_lease_id !== null) {
          this.database.prepare(`
            UPDATE delivery_leases
            SET released_at = ?, release_reason = 'cancelled'
            WHERE id = ? AND released_at IS NULL
          `).run(occurredAt, question.current_lease_id);
        }
        this.database.prepare(`
          UPDATE questions
          SET state = 'cancelled', current_lease_id = NULL, updated_at = ?
          WHERE id = ?
        `).run(occurredAt, question.id);
        this.appendEvent(
          sessionEndQuestionEventId(endedEventId, question.id),
          session.id,
          "question_cancelled",
          question.id,
          { cancelledAt: occurredAt },
          occurredAt,
        );
      }

      this.database.prepare(`
        UPDATE sessions SET state = 'ended', updated_at = ?, ended_at = ? WHERE id = ?
      `).run(occurredAt, occurredAt, session.id);
      this.appendEvent(
        endedEventId,
        session.id,
        "session_transitioned",
        session.id,
        { from: "ending", to: "ended" },
        occurredAt,
      );
    }
  }

  private migrateStatusEvents(): void {
    const statuses = this.database.prepare("SELECT * FROM statuses ORDER BY id")
      .all() as unknown as StatusRow[];
    const eventById = this.database.prepare("SELECT * FROM session_events WHERE id = ?");
    const updateEvent = this.database.prepare(`
      UPDATE session_events SET entity_id = ?, data_json = ? WHERE id = ?
    `);
    for (const status of statuses) {
      const eventId = agentOperationEventId("status_recorded", status.id);
      const event = eventById.get(eventId) as EventRow | undefined;
      if (
        event === undefined ||
        event.session_id !== status.session_id ||
        event.type !== "status_recorded"
      ) {
        throw new SessionStoreMigrationError(
          `Status ${status.id} does not have its expected durable event`,
        );
      }
      const detail = status.detail_json === null ? null : parseJson(status.detail_json);
      updateEvent.run(
        status.id,
        stringifyJson({ detail, questionId: status.question_id, status: status.status }),
        eventId,
      );
    }
  }

  private atomic<T>(work: () => SynchronousResult<T>): T {
    return this.transaction(() => work());
  }

  private readTransaction<T>(work: () => T): T {
    this.assertOpen();
    if (this.transactionDepth > 0) return work();
    this.database.exec("BEGIN");
    this.transactionDepth += 1;
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private assertQuestionSessionMutable(question: QuestionRow): void {
    const session = this.requiredSession(question.session_id);
    if (session.state === "ended") {
      throw new SessionStoreStateError(`Cannot modify a question after session ${session.id} has ended`);
    }
  }

  private assertSessionAllowsSemanticUpdates(sessionId: string): void {
    const session = this.requiredSession(sessionId);
    if (session.state === "ending" || session.state === "ended") {
      throw new SessionStoreStateError(
        `Cannot modify Walkthrough state after session ${session.id} has ${session.state}`,
      );
    }
  }

  private releaseExpiredLeases(sessionId: string, asOf: string): void {
    const unreleased = this.database.prepare(`
      SELECT l.* FROM delivery_leases l
      INNER JOIN questions q ON q.id = l.question_id
      WHERE l.session_id = ? AND l.released_at IS NULL AND q.state = 'leased'
      ORDER BY q.queue_position ASC
    `).all(sessionId) as unknown as LeaseRow[];
    const expired = unreleased.filter(
      (lease) => compareProtocolTimestamps(lease.expires_at, asOf) <= 0,
    );
    for (const lease of expired) {
      this.database.prepare(`
        UPDATE delivery_leases SET released_at = ?, release_reason = 'expired' WHERE id = ?
      `).run(asOf, lease.id);
      this.database.prepare(`
        UPDATE questions
        SET state = 'queued', current_lease_id = NULL, updated_at = ?
        WHERE id = ? AND current_lease_id = ?
      `).run(asOf, lease.question_id, lease.id);
      this.appendEvent(
        expiredLeaseEventId(lease.id),
        sessionId,
        "lease_expired",
        lease.question_id,
        { leaseId: lease.id },
        asOf,
      );
    }
  }

  private appendEvent(
    id: string,
    sessionId: string,
    type: DurableEventType,
    entityId: string,
    data: JsonValue | null,
    occurredAt: string,
  ): void {
    requiredEventId(id);
    requiredId(entityId, "Event entity ID");
    requiredTimestamp(occurredAt, "Event occurredAt");
    const collision = this.eventById(id);
    if (collision !== undefined) {
      throw new SessionStoreConflictError(`Event ID ${id} is already committed`);
    }
    const next = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM session_events WHERE session_id = ?
    `).get(sessionId) as { sequence: number };
    const preceding = this.database.prepare(`
      SELECT occurred_at FROM session_events WHERE session_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(sessionId) as Pick<EventRow, "occurred_at"> | undefined;
    if (preceding !== undefined) {
      requireNotBefore(
        occurredAt,
        preceding.occurred_at,
        "A durable event cannot precede the previously committed event",
      );
    }
    this.database.prepare(`
      INSERT INTO session_events (id, session_id, sequence, type, entity_id, data_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      next.sequence,
      type,
      entityId,
      data === null ? null : stringifyJson(data),
      occurredAt,
    );
  }

  private eventTimestampAtOrAfterLatest(sessionId: string, requestedAt: string): string {
    const latest = this.database.prepare(`
      SELECT occurred_at FROM session_events
      WHERE session_id = ?
      ORDER BY sequence DESC
      LIMIT 1
    `).get(sessionId) as Pick<EventRow, "occurred_at"> | undefined;
    return latest === undefined ||
      compareProtocolTimestamps(requestedAt, latest.occurred_at) >= 0
      ? requestedAt
      : latest.occurred_at;
  }

  private assertEventIdentity(
    event: EventRow,
    sessionId: string,
    type: DurableEventType,
    entityId: string,
  ): void {
    if (event.session_id !== sessionId || event.type !== type || event.entity_id !== entityId) {
      throw new SessionStoreConflictError(`Event ID ${event.id} identifies a different operation`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionStoreStateError("Session store is closed");
  }

  private runtimeOwnership(sessionId: string): RuntimeOwnershipRow | undefined {
    return this.database.prepare(
      "SELECT session_id, owner_id, process_id, heartbeat_at FROM runtime_ownership WHERE session_id = ?",
    ).get(sessionId) as RuntimeOwnershipRow | undefined;
  }

  private reapStaleRuntimeOwnership(): void {
    const ownership = this.database.prepare(
      "SELECT session_id, owner_id, process_id, heartbeat_at FROM runtime_ownership ORDER BY session_id",
    ).all() as unknown as RuntimeOwnershipRow[];
    const remove = this.database.prepare(
      "DELETE FROM runtime_ownership WHERE session_id = ? AND owner_id = ? AND process_id = ?",
    );
    const staleBefore = Date.now() - RUNTIME_OWNERSHIP_LEASE_MS;
    for (const owner of ownership) {
      if (owner.heartbeat_at === null || owner.heartbeat_at < staleBefore) {
        remove.run(owner.session_id, owner.owner_id, owner.process_id);
      }
    }
  }

  private stopRuntimeOwnershipHeartbeat(ownerId: string): void {
    const ownership = this.claimedRuntimeOwnership.get(ownerId);
    if (ownership === undefined) return;
    clearInterval(ownership.heartbeat);
    this.claimedRuntimeOwnership.delete(ownerId);
  }

  private sessionById(id: string): SessionRow | undefined {
    return this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  private sessionCreationEvent(sessionId: string): EventRow | undefined {
    return this.database.prepare(`
      SELECT * FROM session_events
      WHERE session_id = ? AND type = 'session_created' AND entity_id = ?
      ORDER BY sequence ASC LIMIT 1
    `).get(sessionId, sessionId) as EventRow | undefined;
  }

  private requiredSession(id: string): SessionRow {
    const row = this.sessionById(id);
    if (row === undefined) throw new SessionStoreStateError(`Session ${id} does not exist`);
    return row;
  }

  private questionById(id: string): QuestionRow | undefined {
    return this.database.prepare("SELECT * FROM questions WHERE id = ?").get(id) as QuestionRow | undefined;
  }

  private draftById(id: string): DraftRow | undefined {
    return this.database.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  }

  private requiredDraft(id: string): DraftRow {
    const row = this.draftById(id);
    if (row === undefined) throw new SessionStoreStateError(`Draft ${id} does not exist`);
    return row;
  }

  private requiredQuestion(id: string): QuestionRow {
    const row = this.questionById(id);
    if (row === undefined) throw new SessionStoreStateError(`Question ${id} does not exist`);
    return row;
  }

  private leaseById(id: string): LeaseRow | undefined {
    return this.database.prepare("SELECT * FROM delivery_leases WHERE id = ?").get(id) as LeaseRow | undefined;
  }

  private requiredLease(id: string): LeaseRow {
    const row = this.leaseById(id);
    if (row === undefined) throw new SessionStoreStateError(`Delivery lease ${id} does not exist`);
    return row;
  }

  private acknowledgementById(id: string): AcknowledgementRow | undefined {
    return this.database.prepare("SELECT * FROM acknowledgements WHERE id = ?").get(id) as AcknowledgementRow | undefined;
  }

  private requiredAcknowledgement(id: string): AcknowledgementRow {
    const row = this.acknowledgementById(id);
    if (row === undefined) throw new SessionStoreStateError(`Acknowledgement ${id} does not exist`);
    return row;
  }

  private statusById(id: string): StatusRow | undefined {
    return this.database.prepare("SELECT * FROM statuses WHERE id = ?").get(id) as StatusRow | undefined;
  }

  private requiredStatus(id: string): StatusRow {
    const row = this.statusById(id);
    if (row === undefined) throw new SessionStoreStateError(`Status ${id} does not exist`);
    return row;
  }

  private replyById(id: string): ReplyRow | undefined {
    return this.database.prepare("SELECT * FROM replies WHERE id = ?").get(id) as ReplyRow | undefined;
  }

  private requiredReply(id: string): ReplyRow {
    const row = this.replyById(id);
    if (row === undefined) throw new SessionStoreStateError(`Reply ${id} does not exist`);
    return row;
  }

  private cursorById(id: string): CursorRow | undefined {
    return this.database.prepare("SELECT * FROM cursors WHERE id = ?").get(id) as CursorRow | undefined;
  }

  private requiredCursor(id: string): CursorRow {
    const row = this.cursorById(id);
    if (row === undefined) throw new SessionStoreStateError(`Cursor ${id} does not exist`);
    return row;
  }

  private eventById(id: string): EventRow | undefined {
    return this.database.prepare("SELECT * FROM session_events WHERE id = ?").get(id) as EventRow | undefined;
  }
}
