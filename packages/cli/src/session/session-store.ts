import type { ConversationMode } from "@walk-me-through-code/contracts";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface ProtocolTimestampParts {
  readonly epochMillisecondsAtSecond: number;
  readonly fraction: string;
}

function protocolTimestampParts(value: string): ProtocolTimestampParts {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) {
    throw new SessionStoreConflictError("Timestamp must be a valid protocol timestamp");
  }
  return {
    epochMillisecondsAtSecond: Date.parse(`${match[1]}${match[3]}`),
    fraction: match[2] ?? "",
  };
}

export function compareProtocolTimestamps(left: string, right: string): number {
  const leftParts = protocolTimestampParts(left);
  const rightParts = protocolTimestampParts(right);
  if (leftParts.epochMillisecondsAtSecond !== rightParts.epochMillisecondsAtSecond) {
    return leftParts.epochMillisecondsAtSecond - rightParts.epochMillisecondsAtSecond;
  }
  const precision = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(precision, "0");
  const rightFraction = rightParts.fraction.padEnd(precision, "0");
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0;
}

export type SessionState =
  | "created"
  | "viewer_open"
  | "agent_listening"
  | "active"
  | "ending"
  | "ended"
  | "interrupted";

export type QuestionState =
  | "queued"
  | "leased"
  | "acknowledged"
  | "answered"
  | "cancelled"
  | "failed";

export type DurableEventType =
  | "session_created"
  | "session_transitioned"
  | "conversation_mode_changed"
  | "draft_created"
  | "draft_updated"
  | "draft_removed"
  | "drafts_sent"
  | "question_queued"
  | "question_edited"
  | "question_cancelled"
  | "question_leased"
  | "lease_expired"
  | "question_acknowledged"
  | "status_recorded"
  | "reply_recorded"
  | "walkthrough_update_recorded";

export interface SessionRecord {
  readonly id: string;
  readonly repositoryKey: string;
  readonly repositoryScope?: string;
  readonly walkthroughId: string;
  readonly artifactRevision: number;
  readonly conversationMode: ConversationMode;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface QuestionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactRevision: number;
  readonly queuePosition: number;
  readonly state: QuestionState;
  readonly mode: ConversationMode;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentLeaseId: string | null;
}

export interface DraftRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactRevision: number;
  readonly draftPosition: number;
  readonly mode: ConversationMode;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryLeaseRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: "acknowledged" | "cancelled" | "expired" | null;
}

export interface AcknowledgementRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly leaseId: string;
  readonly acknowledgedAt: string;
}

export interface StatusRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly status: string;
  readonly detail: JsonValue | null;
  readonly createdAt: string;
}

export interface ReplyRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly outcome: "answer" | "failure";
  readonly content: JsonValue;
  readonly createdAt: string;
}

export interface WalkthroughStateRecord {
  readonly sessionId: string;
  readonly artifact: JsonValue;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface WalkthroughUpdateOutcomeRecord {
  readonly questionId: string;
  readonly sessionId: string;
  readonly outcome: JsonValue;
  readonly updatedAt: string;
}

export interface CursorRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly consumer: string;
  readonly lastSequence: number;
  readonly updatedAt: string;
}

export interface DurableEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly type: DurableEventType;
  readonly entityId: string;
  readonly data: JsonValue | null;
  readonly occurredAt: string;
}

export interface SessionSnapshot {
  readonly session: SessionRecord;
  readonly drafts: readonly DraftRecord[];
  readonly questions: readonly QuestionRecord[];
  readonly leases: readonly DeliveryLeaseRecord[];
  readonly acknowledgements: readonly AcknowledgementRecord[];
  readonly statuses: readonly StatusRecord[];
  readonly replies: readonly ReplyRecord[];
  readonly walkthroughState?: WalkthroughStateRecord;
  readonly walkthroughUpdateOutcomes: readonly WalkthroughUpdateOutcomeRecord[];
  readonly cursors: readonly CursorRecord[];
  readonly events: readonly DurableEventRecord[];
}

export interface CreateSessionInput extends SessionRecord {
  readonly state: "created";
  readonly endedAt: null;
  readonly lifecycleEventId: string;
}

export interface TransitionSessionInput {
  readonly sessionId: string;
  readonly eventId: string;
  readonly to: SessionState;
  readonly occurredAt: string;
}

export interface SetConversationModeInput {
  readonly sessionId: string;
  readonly eventId: string;
  readonly mode: ConversationMode;
  readonly changedAt: string;
}

export interface FindResumableSessionInput {
  readonly repositoryKey: string;
  readonly repositoryScope?: string;
  readonly walkthroughId: string;
  readonly artifactRevision: number;
}

export interface EnqueueQuestionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactRevision: number;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly createdAt: string;
}

export interface CreateDraftInput {
  readonly id: string;
  readonly sessionId: string;
  readonly artifactRevision: number;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly createdAt: string;
}

export interface EditDraftInput {
  readonly draftId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly expectedUpdatedAt: string;
  readonly artifactRevision: number;
  readonly mode: ConversationMode;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly updatedAt: string;
}

export interface RemoveDraftInput {
  readonly draftId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly expectedUpdatedAt: string;
  readonly removedAt: string;
}

export interface SendDraftsInput {
  readonly sessionId: string;
  readonly eventId: string;
  readonly sentAt: string;
  readonly drafts: readonly {
    readonly id: string;
    readonly updatedAt: string;
  }[];
  readonly composer: {
    readonly artifactRevision: number;
    readonly message: string;
    readonly context: JsonValue | null;
  } | null;
}

export interface SendDraftsResult {
  readonly created: boolean;
  readonly questions: readonly QuestionRecord[];
}

export interface EditQuestionInput {
  readonly questionId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly message: string;
  readonly context: JsonValue | null;
  readonly updatedAt: string;
}

export interface CancelQuestionInput {
  readonly questionId: string;
  readonly sessionId: string;
  readonly eventId: string;
  readonly cancelledAt: string;
}

export interface LeaseQuestionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export interface AcknowledgeQuestionInput {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly leaseId: string;
  readonly acknowledgedAt: string;
}

export interface RecordStatusInput {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly status: string;
  readonly detail: JsonValue | null;
  readonly createdAt: string;
}

export interface RecordReplyInput {
  readonly id: string;
  readonly sessionId: string;
  readonly questionId: string;
  readonly outcome: "answer" | "failure";
  readonly content: JsonValue;
  readonly createdAt: string;
}

export interface InitializeWalkthroughStateInput {
  readonly sessionId: string;
  readonly artifact: JsonValue;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface UpdateWalkthroughStateInput extends InitializeWalkthroughStateInput {
  readonly expectedRevision: number;
}

export interface RecordWalkthroughUpdateOutcomeInput {
  readonly eventId: string;
  readonly questionId: string;
  readonly sessionId: string;
  readonly outcome: JsonValue;
  readonly updatedAt: string;
}

export interface AdvanceCursorInput {
  readonly id: string;
  readonly sessionId: string;
  readonly consumer: string;
  readonly lastSequence: number;
  readonly updatedAt: string;
}

export interface CreateResult<T> {
  readonly created: boolean;
  readonly record: T;
}

export type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * The application-facing persistence boundary for a Live Session.
 *
 * This contract deliberately contains no database, transport, or Viewer types.
 * Implementations must make every method atomic. A transaction callback groups
 * several method calls into one commit and rolls all of them back on failure.
 */
export interface SessionStore {
  readonly schemaVersion: number;
  transaction<T>(work: (store: SessionStore) => SynchronousResult<T>): T;
  claimRuntimeOwnership(sessionId: string, ownerId: string): void;
  renewRuntimeOwnership(sessionId: string, ownerId: string): boolean;
  releaseRuntimeOwnership(sessionId: string, ownerId: string): void;
  createSession(input: CreateSessionInput): CreateResult<SessionRecord>;
  getSession(sessionId: string): SessionRecord | undefined;
  listSessions(): readonly SessionRecord[];
  discardSession(sessionId: string): boolean;
  findResumableSession(input: FindResumableSessionInput): SessionRecord | undefined;
  transitionSession(input: TransitionSessionInput): CreateResult<SessionRecord>;
  setConversationMode(input: SetConversationModeInput): CreateResult<SessionRecord>;
  getDraft(draftId: string): DraftRecord | undefined;
  createDraft(input: CreateDraftInput): CreateResult<DraftRecord>;
  editDraft(input: EditDraftInput): CreateResult<DraftRecord>;
  removeDraft(input: RemoveDraftInput): CreateResult<DraftRecord>;
  sendDrafts(input: SendDraftsInput): SendDraftsResult;
  getQuestion(questionId: string): QuestionRecord | undefined;
  enqueueQuestion(input: EnqueueQuestionInput): CreateResult<QuestionRecord>;
  editQuestion(input: EditQuestionInput): CreateResult<QuestionRecord>;
  cancelQuestion(input: CancelQuestionInput): CreateResult<QuestionRecord>;
  leaseNextQuestion(input: LeaseQuestionInput): CreateResult<DeliveryLeaseRecord> | undefined;
  acknowledgeQuestion(input: AcknowledgeQuestionInput): CreateResult<AcknowledgementRecord>;
  recordStatus(input: RecordStatusInput): CreateResult<StatusRecord>;
  recordReply(input: RecordReplyInput): CreateResult<ReplyRecord>;
  initializeWalkthroughState(input: InitializeWalkthroughStateInput): CreateResult<WalkthroughStateRecord>;
  updateWalkthroughState(input: UpdateWalkthroughStateInput): CreateResult<WalkthroughStateRecord>;
  recordWalkthroughUpdateOutcome(
    input: RecordWalkthroughUpdateOutcomeInput,
  ): CreateResult<WalkthroughUpdateOutcomeRecord>;
  advanceCursor(input: AdvanceCursorInput): CreateResult<CursorRecord>;
  listEvents(sessionId: string, afterSequence?: number): readonly DurableEventRecord[];
  getSnapshot(sessionId: string): SessionSnapshot | undefined;
  close(): void;
}

export class SessionStoreConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionStoreConflictError";
  }
}

export class SessionStoreStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionStoreStateError";
  }
}

export class SessionStoreMigrationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionStoreMigrationError";
  }
}
