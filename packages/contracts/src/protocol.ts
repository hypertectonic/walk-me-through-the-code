import { z } from "zod";

import {
  SourceReferenceSchema,
  WalkthroughArtifactSchema,
  type ExplanationModule,
  type WalkthroughArtifact,
} from "./artifact.js";
import {
  RepositoryRelativePathSchema,
  RequiredRestrictedMarkdownSchema,
  RestrictedMarkdownSchema,
  RevisionSchema,
  SchemaVersionSchema,
  StableIdSchema,
  TimestampSchema,
} from "./primitives.js";
import { WalkthroughUpdateSchema } from "./updates.js";

export const ModuleContextSelectionSchema = z
  .object({
    kind: z.literal("module"),
    targetId: StableIdSchema,
  })
  .strict();

const SchemaOwnedTextFieldSchema = z.string().min(1).max(128).refine(
  (field) =>
    /^(?:title|trigger|path|outcome|purpose|responsibility|label|actor|action|result|leftLabel|left|rightLabel|right|conclusion|value|valueBefore|valueAfter|branch|detail|summary|content|code|explanation|output|selectionReason|inputs(?:\.\d+)?|outputs\.\d+|excludes\.\d+)$/.test(
      field,
    ),
  "field must identify a schema-owned text field",
);

export const TextRangeContextSelectionSchema = z
  .object({
    kind: z.literal("textRange"),
    targetId: StableIdSchema,
    field: SchemaOwnedTextFieldSchema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    selectedText: z.string().min(1),
  })
  .strict()
  .refine(({ startOffset, endOffset }) => endOffset > startOffset, {
    message: "Text ranges are half-open and endOffset must be greater than startOffset",
    path: ["endOffset"],
  })
  .refine(
    ({ startOffset, endOffset, selectedText }) =>
      Array.from(selectedText).length === endOffset - startOffset,
    {
      message: "selectedText must match the Unicode code-point range length",
      path: ["selectedText"],
    },
  );

export const SourceLinesContextSelectionSchema = z
  .object({
    kind: z.literal("sourceLines"),
    targetId: StableIdSchema,
    file: RepositoryRelativePathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine(({ startLine, endLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const ContextSelectionItemSchema = z.discriminatedUnion("kind", [
  ModuleContextSelectionSchema,
  TextRangeContextSelectionSchema,
  SourceLinesContextSelectionSchema,
]);

export const ContextSelectionSchema = z.array(ContextSelectionItemSchema).min(1);

const EventBaseSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  eventId: StableIdSchema,
  sessionId: StableIdSchema,
  artifactRevision: RevisionSchema,
  createdAt: TimestampSchema,
});

export const ConversationModeSchema = z.enum(["analyze", "learn"]);

export const ContextualQuestionSchema = EventBaseSchema.extend({
  type: z.literal("question"),
  mode: ConversationModeSchema,
  contextSelection: ContextSelectionSchema.optional(),
  message: RequiredRestrictedMarkdownSchema,
}).strict();

export const BrowserToAgentEventSchema = ContextualQuestionSchema;

type TextTarget = Record<string, unknown>;

function moduleTextFields(module: ExplanationModule): TextTarget {
  const fields: TextTarget = {};
  if (module.title !== undefined) fields.title = module.title;
  switch (module.type) {
    case "story":
      return { ...fields, trigger: module.trigger, path: module.path, outcome: module.outcome, purpose: module.purpose };
    case "systemFlow":
      return fields;
    case "responsibility":
      return { ...fields, responsibility: module.responsibility, excludes: module.excludes, inputs: module.inputs, outputs: module.outputs };
    case "sourceExcerpt":
      return {
        ...fields,
        code: module.code,
        explanation: module.explanation,
        inputs: module.inputs,
        output: module.output,
        selectionReason: module.selectionReason,
      };
    case "requestSequence":
    case "valueTrace":
      return fields;
    case "executionTrace":
      return { ...fields, summary: module.summary };
    case "comparison":
      return {
        ...fields,
        leftLabel: module.leftLabel,
        left: module.left,
        rightLabel: module.rightLabel,
        right: module.right,
        ...(module.conclusion === undefined ? {} : { conclusion: module.conclusion }),
      };
    case "callout":
      return { ...fields, content: module.content };
  }
}

function textTarget(artifact: WalkthroughArtifact, targetId: string): TextTarget | undefined {
  for (const module of artifact.sections) {
    if (module.id === targetId) return moduleTextFields(module);
    const annotation = module.annotations?.find(({ id }) => id === targetId);
    if (annotation !== undefined) return { content: annotation.content };

    switch (module.type) {
      case "systemFlow": {
        const node = module.nodes.find(({ id }) => id === targetId);
        if (node !== undefined) return { label: node.label, responsibility: node.responsibility };
        break;
      }
      case "sourceExcerpt": {
        const highlight = module.highlights.find(({ id }) => id === targetId);
        if (highlight !== undefined) return { label: highlight.label };
        break;
      }
      case "requestSequence": {
        const step = module.steps.find(({ id }) => id === targetId);
        if (step !== undefined) return { actor: step.actor, action: step.action, result: step.result };
        break;
      }
      case "valueTrace": {
        const step = module.steps.find(({ id }) => id === targetId);
        if (step !== undefined) return { label: step.label, value: step.value };
        break;
      }
      case "executionTrace": {
        const step = module.steps.find(({ id }) => id === targetId);
        if (step !== undefined) {
          return {
            label: step.label,
            action: step.action,
            ...(step.valueBefore === undefined ? {} : { valueBefore: step.valueBefore }),
            ...(step.valueAfter === undefined ? {} : { valueAfter: step.valueAfter }),
            ...(step.branch === undefined ? {} : { branch: step.branch }),
            ...(step.detail === undefined ? {} : { detail: step.detail }),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return undefined;
}

function textField(target: TextTarget, path: string): string | undefined {
  const [field, indexText] = path.split(".");
  if (field === undefined) return undefined;
  const value = target[field];
  if (indexText === undefined) return typeof value === "string" ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const item: unknown = (value as unknown[])[Number.parseInt(indexText, 10)];
  return typeof item === "string" ? item : undefined;
}

function addContextSelectionIssues(
  artifact: WalkthroughArtifact,
  event: BrowserToAgentEvent,
  context: z.core.$RefinementCtx<BrowserToAgentEvent>,
): void {
  if (!("contextSelection" in event) || event.contextSelection === undefined) return;

  for (const [index, selection] of event.contextSelection.entries()) {
    if (selection.kind === "module") {
      if (!artifact.sections.some(({ id }) => id === selection.targetId)) {
        context.addIssue({
          code: "custom",
          message: "targetId must identify an Explanation Module in the artifact",
          path: ["contextSelection", index, "targetId"],
          input: selection.targetId,
        });
      }
      continue;
    }

    if (selection.kind === "textRange") {
      const target = textTarget(artifact, selection.targetId);
      const source = target === undefined ? undefined : textField(target, selection.field);
      if (source === undefined) {
        context.addIssue({
          code: "custom",
          message: "field must identify a text field on the target artifact item",
          path: ["contextSelection", index, target === undefined ? "targetId" : "field"],
          input: target === undefined ? selection.targetId : selection.field,
        });
        continue;
      }
      const selectedText = Array.from(source)
        .slice(selection.startOffset, selection.endOffset)
        .join("");
      if (selectedText !== selection.selectedText) {
        context.addIssue({
          code: "custom",
          message: "selectedText must exactly match the selected target field range",
          path: ["contextSelection", index, "selectedText"],
          input: selection.selectedText,
        });
      }
      continue;
    }

    const sourceModule = artifact.sections.find(
      (module): module is Extract<ExplanationModule, { type: "sourceExcerpt" }> =>
        module.id === selection.targetId && module.type === "sourceExcerpt",
    );
    if (sourceModule === undefined) {
      context.addIssue({
        code: "custom",
        message: "targetId must identify a Source Excerpt module in the artifact",
        path: ["contextSelection", index, "targetId"],
        input: selection.targetId,
      });
    } else if (
      selection.file !== sourceModule.sourceEvidence.file ||
      selection.startLine < sourceModule.sourceEvidence.startLine ||
      selection.endLine > sourceModule.sourceEvidence.endLine
    ) {
      context.addIssue({
        code: "custom",
        message: "source lines must use the target module's exact Source Evidence coordinates",
        path: ["contextSelection", index],
        input: selection,
      });
    }
  }
}

export function browserToAgentEventSchemaForArtifact(artifactInput: unknown) {
  const artifact = WalkthroughArtifactSchema.parse(artifactInput);
  return BrowserToAgentEventSchema.superRefine((event, context) => {
    if (event.artifactRevision !== artifact.revision) {
      context.addIssue({
        code: "custom",
        message: "artifactRevision must match the selected artifact",
        path: ["artifactRevision"],
        input: event.artifactRevision,
      });
    }
    addContextSelectionIssues(artifact, event, context);
  });
}

export const EventBatchSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    events: z.array(BrowserToAgentEventSchema),
  })
  .strict()
  .superRefine(({ events }, context) => {
    const eventIds = events.map(({ eventId }) => eventId);
    const duplicate = eventIds.find((eventId, index) => eventIds.indexOf(eventId) !== index);
    if (duplicate !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Event IDs must be unique; duplicate ID: ${duplicate}`,
        path: ["events"],
      });
    }
  });

export function eventBatchSchemaForArtifact(artifactInput: unknown) {
  const eventSchema = browserToAgentEventSchemaForArtifact(artifactInput);
  return EventBatchSchema.superRefine((batch, context) => {
    for (const [eventIndex, event] of batch.events.entries()) {
      const result = eventSchema.safeParse(event);
      if (result.success) continue;
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: ["events", eventIndex, ...issue.path],
          input: event,
        });
      }
    }
  });
}

export const EventAcknowledgementSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    eventId: StableIdSchema,
    sessionId: StableIdSchema,
    acknowledgedAt: TimestampSchema,
  })
  .strict();

export const ProgressStatusSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    eventId: StableIdSchema,
    sessionId: StableIdSchema,
    status: z.enum(["investigating", "reconnecting"]),
    message: RestrictedMarkdownSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict();

export const AnswerResponseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    eventId: StableIdSchema,
    type: z.literal("answer"),
    content: RequiredRestrictedMarkdownSchema,
    references: z.array(SourceReferenceSchema).optional(),
    walkthroughUpdate: WalkthroughUpdateSchema.optional(),
  })
  .strict()
  .refine(
    ({ eventId, walkthroughUpdate }) =>
      walkthroughUpdate === undefined || walkthroughUpdate.eventId === eventId,
    {
      message: "A Walkthrough Update must be caused by the response event",
      path: ["walkthroughUpdate", "eventId"],
    },
  );

export const ErrorResponseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    eventId: StableIdSchema,
    type: z.literal("error"),
    code: z.string().min(1).max(128),
    content: RequiredRestrictedMarkdownSchema,
  })
  .strict();

export const AgentResponseSchema = z.discriminatedUnion("type", [
  AnswerResponseSchema,
  ErrorResponseSchema,
]);

export const SessionLifecycleStateSchema = z.enum([
  "created",
  "viewer_open",
  "agent_listening",
  "active",
  "ending",
  "ended",
  "interrupted",
]);

export const EventLifecycleStateSchema = z.enum([
  "queued",
  "leased",
  "acknowledged",
  "answered",
  "cancelled",
  "failed",
]);

export const LiveSessionSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: StableIdSchema,
    walkthroughId: StableIdSchema,
    artifactRevision: RevisionSchema,
    state: SessionLifecycleStateSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    endedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.state === "ended" && session.endedAt === undefined) {
      context.addIssue({ code: "custom", message: "Ended sessions require endedAt", path: ["endedAt"] });
    }
    if (session.state !== "ended" && session.endedAt !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only ended sessions may declare endedAt",
        path: ["endedAt"],
      });
    }
    const createdAt = Date.parse(session.createdAt);
    const updatedAt = Date.parse(session.updatedAt);
    if (updatedAt < createdAt) {
      context.addIssue({
        code: "custom",
        message: "updatedAt cannot be earlier than createdAt",
        path: ["updatedAt"],
      });
    }
    if (session.endedAt !== undefined) {
      const endedAt = Date.parse(session.endedAt);
      if (endedAt < createdAt) {
        context.addIssue({
          code: "custom",
          message: "endedAt cannot be earlier than createdAt",
          path: ["endedAt"],
        });
      }
      if (updatedAt < endedAt) {
        context.addIssue({
          code: "custom",
          message: "updatedAt cannot be earlier than endedAt",
          path: ["updatedAt"],
        });
      }
    }
  });

export const SESSION_TRANSITIONS = {
  created: ["viewer_open", "ending", "interrupted"],
  viewer_open: ["agent_listening", "ending", "interrupted"],
  agent_listening: ["active", "ending", "interrupted"],
  active: ["agent_listening", "ending", "interrupted"],
  ending: ["ended", "interrupted"],
  ended: [],
  interrupted: ["viewer_open", "agent_listening", "ending", "ended"],
} as const satisfies Record<z.infer<typeof SessionLifecycleStateSchema>, readonly string[]>;

export const EVENT_TRANSITIONS = {
  queued: ["leased", "cancelled"],
  leased: ["queued", "acknowledged"],
  acknowledged: ["answered", "failed"],
  answered: [],
  cancelled: [],
  failed: [],
} as const satisfies Record<z.infer<typeof EventLifecycleStateSchema>, readonly string[]>;

export function isSessionTransitionAllowed(
  from: z.infer<typeof SessionLifecycleStateSchema>,
  to: z.infer<typeof SessionLifecycleStateSchema>,
): boolean {
  return (SESSION_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isEventTransitionAllowed(
  from: z.infer<typeof EventLifecycleStateSchema>,
  to: z.infer<typeof EventLifecycleStateSchema>,
): boolean {
  return (EVENT_TRANSITIONS[from] as readonly string[]).includes(to);
}

export type ContextSelectionItem = z.infer<typeof ContextSelectionItemSchema>;
export type ConversationMode = z.infer<typeof ConversationModeSchema>;
export type ContextualQuestion = z.infer<typeof ContextualQuestionSchema>;
export type BrowserToAgentEvent = z.infer<typeof BrowserToAgentEventSchema>;
export type EventAcknowledgement = z.infer<typeof EventAcknowledgementSchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type LiveSession = z.infer<typeof LiveSessionSchema>;
