import { z } from "zod";

import { sourceContentHash } from "./content-hash.js";
import {
  AbsoluteRepositoryPathSchema,
  ContentHashSchema,
  EvidenceLabelSchema,
  RepositoryRelativePathSchema,
  RequiredRestrictedMarkdownSchema,
  RestrictedMarkdownSchema,
  RevisionSchema,
  SchemaVersionSchema,
  StableIdSchema,
  TimestampSchema,
  WindowsRepositoryRelativePathSchema,
} from "./primitives.js";

export const SourceReferenceSchema = z
  .object({
    file: RepositoryRelativePathSchema,
    symbol: z.string().min(1).max(512).optional(),
    line: z.number().int().positive().optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if ((reference.startLine === undefined) !== (reference.endLine === undefined)) {
      context.addIssue({
        code: "custom",
        message: "startLine and endLine must be provided together",
      });
    } else if (
      reference.startLine !== undefined &&
      reference.endLine !== undefined &&
      reference.endLine < reference.startLine
    ) {
      context.addIssue({
        code: "custom",
        message: "endLine must be greater than or equal to startLine",
        path: ["endLine"],
      });
    }
    if (
      reference.line !== undefined &&
      (reference.startLine !== undefined || reference.endLine !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "line cannot be combined with startLine or endLine",
        path: ["line"],
      });
    }
  });

export const SourceEvidenceSchema = z
  .object({
    file: RepositoryRelativePathSchema,
    symbol: z.string().min(1).max(512),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    language: z.string().min(1).max(64),
    contentHash: ContentHashSchema,
  })
  .strict()
  .refine(({ startLine, endLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const SourceEvidenceStateSchema = z
  .object({
    status: z.enum(["current", "changed", "missing", "relocated"]),
    checkedAt: TimestampSchema,
    currentFile: RepositoryRelativePathSchema.optional(),
    currentStartLine: z.number().int().positive().optional(),
    currentEndLine: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const hasRange = state.currentStartLine !== undefined || state.currentEndLine !== undefined;
    if (
      hasRange &&
      (
        state.currentStartLine === undefined ||
        state.currentEndLine === undefined ||
        state.currentEndLine < state.currentStartLine
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Current evidence coordinates must contain a complete ordered range",
        path: ["currentEndLine"],
      });
    }
    if (state.status === "relocated" && (state.currentFile === undefined || !hasRange)) {
      context.addIssue({
        code: "custom",
        message: "Relocated evidence requires its current file and line range",
        path: ["currentFile"],
      });
    }
  });

export const AnnotationSchema = z
  .object({
    id: StableIdSchema,
    content: RequiredRestrictedMarkdownSchema,
  })
  .strict();

const ModuleBaseSchema = z.object({
  id: StableIdSchema,
  title: RestrictedMarkdownSchema.optional(),
  annotations: z.array(AnnotationSchema).optional(),
});

export const StoryModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("story"),
  trigger: RequiredRestrictedMarkdownSchema,
  path: RequiredRestrictedMarkdownSchema,
  outcome: RequiredRestrictedMarkdownSchema,
  purpose: RequiredRestrictedMarkdownSchema,
}).strict();

export const SystemFlowNodeSchema = z
  .object({
    id: StableIdSchema,
    label: RequiredRestrictedMarkdownSchema,
    responsibility: RequiredRestrictedMarkdownSchema,
    sourceEvidence: SourceReferenceSchema.optional(),
    previousId: StableIdSchema.optional(),
    nextId: StableIdSchema.optional(),
  })
  .strict();

export const SystemFlowModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("systemFlow"),
  nodes: z.array(SystemFlowNodeSchema).min(1),
})
  .strict()
  .superRefine(({ nodes }, context) => {
    const ids = new Set(nodes.map(({ id }) => id));
    for (const [index, node] of nodes.entries()) {
      for (const field of ["previousId", "nextId"] as const) {
        const relatedId = node[field];
        if (relatedId !== undefined && (!ids.has(relatedId) || relatedId === node.id)) {
          context.addIssue({
            code: "custom",
            message: `${field} must reference a different node in the same System Flow`,
            path: ["nodes", index, field],
          });
        }
      }
    }
  });

export const ResponsibilityModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("responsibility"),
  responsibility: RequiredRestrictedMarkdownSchema,
  excludes: z.array(RequiredRestrictedMarkdownSchema),
  inputs: z.array(RequiredRestrictedMarkdownSchema),
  outputs: z.array(RequiredRestrictedMarkdownSchema),
  calledBy: z.array(StableIdSchema),
  sourceEvidence: SourceReferenceSchema.optional(),
}).strict();

export const SourceHighlightSchema = z
  .object({
    id: StableIdSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    label: RequiredRestrictedMarkdownSchema,
  })
  .strict()
  .refine(({ startLine, endLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const SourceExcerptModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("sourceExcerpt"),
  title: RequiredRestrictedMarkdownSchema,
  evidenceLabel: EvidenceLabelSchema,
  sourceEvidence: SourceEvidenceSchema,
  evidenceState: SourceEvidenceStateSchema.optional(),
  code: z.string().min(1).max(250_000),
  explanation: RequiredRestrictedMarkdownSchema,
  inputs: RequiredRestrictedMarkdownSchema,
  output: RequiredRestrictedMarkdownSchema,
  selectionReason: RequiredRestrictedMarkdownSchema,
  highlights: z.array(SourceHighlightSchema).min(1),
  relatedIds: z.array(StableIdSchema).min(1),
})
  .strict()
  .superRefine(({ code, highlights, sourceEvidence }, context) => {
    const codeLineCount = code.split(/\r?\n/).length;
    const evidenceLineCount = sourceEvidence.endLine - sourceEvidence.startLine + 1;
    if (codeLineCount !== evidenceLineCount) {
      context.addIssue({
        code: "custom",
        message: "Source Excerpt line count must match its exact Source Evidence range",
        path: ["code"],
      });
    }
    if (sourceEvidence.contentHash !== sourceContentHash(code)) {
      context.addIssue({
        code: "custom",
        message: "Source Evidence contentHash must be the SHA-256 hash of the exact UTF-8 code",
        path: ["sourceEvidence", "contentHash"],
      });
    }
    for (const [index, highlight] of highlights.entries()) {
      if (
        highlight.startLine < sourceEvidence.startLine ||
        highlight.endLine > sourceEvidence.endLine
      ) {
        context.addIssue({
          code: "custom",
          message: "Highlights must stay within the Source Evidence range",
          path: ["highlights", index],
        });
      }
    }
  });

export const RequestSequenceStepSchema = z
  .object({
    id: StableIdSchema,
    actor: RequiredRestrictedMarkdownSchema,
    action: RequiredRestrictedMarkdownSchema,
    result: RequiredRestrictedMarkdownSchema,
    sourceEvidence: SourceReferenceSchema.optional(),
  })
  .strict();

export const RequestSequenceModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("requestSequence"),
  steps: z.array(RequestSequenceStepSchema).min(1),
}).strict();

export const ComparisonModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("comparison"),
  leftLabel: RequiredRestrictedMarkdownSchema,
  left: RequiredRestrictedMarkdownSchema,
  rightLabel: RequiredRestrictedMarkdownSchema,
  right: RequiredRestrictedMarkdownSchema,
  conclusion: RestrictedMarkdownSchema.optional(),
}).strict();

export const ValueTraceStepSchema = z
  .object({
    id: StableIdSchema,
    label: RequiredRestrictedMarkdownSchema,
    value: RequiredRestrictedMarkdownSchema,
    sourceEvidence: SourceReferenceSchema.optional(),
  })
  .strict();

export const ValueTraceModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("valueTrace"),
  steps: z.array(ValueTraceStepSchema).min(1),
}).strict();

export const ExecutionTraceStepSchema = z
  .object({
    id: StableIdSchema,
    label: RequiredRestrictedMarkdownSchema,
    action: RequiredRestrictedMarkdownSchema,
    evidenceLabel: EvidenceLabelSchema,
    sourceEvidence: SourceReferenceSchema.optional(),
    valueBefore: RestrictedMarkdownSchema.optional(),
    valueAfter: RestrictedMarkdownSchema.optional(),
    branch: RestrictedMarkdownSchema.optional(),
    detail: RestrictedMarkdownSchema.optional(),
  })
  .strict()
  .refine(
    ({ valueBefore, valueAfter }) =>
      (valueBefore === undefined) === (valueAfter === undefined),
    {
      message: "Execution Trace value changes require both valueBefore and valueAfter",
      path: ["valueAfter"],
    },
  );

export const ExecutionTraceModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("executionTrace"),
  summary: RequiredRestrictedMarkdownSchema,
  steps: z.array(ExecutionTraceStepSchema).min(1).max(100),
}).strict();

export const CalloutModuleSchema = ModuleBaseSchema.extend({
  type: z.literal("callout"),
  tone: z.enum(["info", "risk", "assumption", "edge-case"]),
  content: RequiredRestrictedMarkdownSchema,
  sourceEvidence: SourceReferenceSchema.optional(),
}).strict();

export const ExplanationModuleSchema = z.discriminatedUnion("type", [
  StoryModuleSchema,
  SystemFlowModuleSchema,
  ResponsibilityModuleSchema,
  SourceExcerptModuleSchema,
  RequestSequenceModuleSchema,
  ComparisonModuleSchema,
  ValueTraceModuleSchema,
  ExecutionTraceModuleSchema,
  CalloutModuleSchema,
]);

export const RepositoryStateSchema = z
  .object({
    root: AbsoluteRepositoryPathSchema,
    scope: RepositoryRelativePathSchema.optional(),
    generatedAt: TimestampSchema,
    gitCommit: z.string().min(1).max(128).optional(),
    hasUncommittedChanges: z.boolean().optional(),
  })
  .strict();

function nestedIds(module: z.infer<typeof ExplanationModuleSchema>): string[] {
  const annotationIds = module.annotations?.map(({ id }) => id) ?? [];
  switch (module.type) {
    case "systemFlow":
      return [...annotationIds, ...module.nodes.map(({ id }) => id)];
    case "sourceExcerpt":
      return [...annotationIds, ...module.highlights.map(({ id }) => id)];
    case "requestSequence":
    case "valueTrace":
    case "executionTrace":
      return [...annotationIds, ...module.steps.map(({ id }) => id)];
    default:
      return annotationIds;
  }
}

interface ArtifactSourcePath {
  file: string;
  path: (string | number)[];
}

function sourcePaths(
  module: z.infer<typeof ExplanationModuleSchema>,
  sectionIndex: number,
): ArtifactSourcePath[] {
  const sectionPath = ["sections", sectionIndex] as const;
  switch (module.type) {
    case "systemFlow":
      return module.nodes.flatMap((node, nodeIndex) =>
        node.sourceEvidence === undefined
          ? []
          : [
              {
                file: node.sourceEvidence.file,
                path: [...sectionPath, "nodes", nodeIndex, "sourceEvidence", "file"],
              },
            ],
      );
    case "responsibility":
    case "sourceExcerpt":
    case "callout":
      return module.sourceEvidence === undefined
        ? []
        : [{ file: module.sourceEvidence.file, path: [...sectionPath, "sourceEvidence", "file"] }];
    case "requestSequence":
    case "valueTrace":
    case "executionTrace":
      return module.steps.flatMap((step, stepIndex) =>
        step.sourceEvidence === undefined
          ? []
          : [
              {
                file: step.sourceEvidence.file,
                path: [...sectionPath, "steps", stepIndex, "sourceEvidence", "file"],
              },
            ],
      );
    case "story":
    case "comparison":
      return [];
  }
}

export const WalkthroughArtifactSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: StableIdSchema,
    revision: RevisionSchema,
    title: RequiredRestrictedMarkdownSchema,
    repositoryState: RepositoryStateSchema,
    sections: z.array(ExplanationModuleSchema).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const isWindowsRepository =
      /^[A-Za-z]:[\\/]/.test(artifact.repositoryState.root) ||
      artifact.repositoryState.root.startsWith("\\\\");
    if (isWindowsRepository) {
      const scope = artifact.repositoryState.scope;
      if (
        scope !== undefined &&
        !WindowsRepositoryRelativePathSchema.safeParse(scope).success
      ) {
        context.addIssue({
          code: "custom",
          message: "scope must use valid Windows path segments for a Windows repository",
          path: ["repositoryState", "scope"],
        });
      }

      for (const [sectionIndex, section] of artifact.sections.entries()) {
        for (const sourcePath of sourcePaths(section, sectionIndex)) {
          if (!WindowsRepositoryRelativePathSchema.safeParse(sourcePath.file).success) {
            context.addIssue({
              code: "custom",
              message: "Source file must use valid Windows path segments for a Windows repository",
              path: sourcePath.path,
            });
          }
        }
      }
    }

    const interactiveIds: string[] = [];
    for (const section of artifact.sections) {
      interactiveIds.push(section.id, ...nestedIds(section));
    }
    const ids = [artifact.id, ...interactiveIds];
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Interactive IDs must be unique; duplicate ID: ${duplicate}`,
        path: ["sections"],
      });
    }

    const knownIds = new Set(interactiveIds);
    for (const [sectionIndex, section] of artifact.sections.entries()) {
      const relationships =
        section.type === "responsibility"
          ? (["calledBy", section.calledBy] as const)
          : section.type === "sourceExcerpt"
            ? (["relatedIds", section.relatedIds] as const)
            : undefined;
      if (relationships === undefined) continue;

      const [field, relatedIds] = relationships;
      for (const [relatedIndex, relatedId] of relatedIds.entries()) {
        if (!knownIds.has(relatedId)) {
          context.addIssue({
            code: "custom",
            message: `${field} must reference an interactive ID in the same artifact`,
            path: ["sections", sectionIndex, field, relatedIndex],
          });
        }
      }
    }
  });

export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type ExplanationModule = z.infer<typeof ExplanationModuleSchema>;
export type RepositoryState = z.infer<typeof RepositoryStateSchema>;
export type WalkthroughArtifact = z.infer<typeof WalkthroughArtifactSchema>;
