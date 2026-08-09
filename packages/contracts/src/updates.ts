import { z } from "zod";

import {
  AnnotationSchema,
  ExplanationModuleSchema,
  WalkthroughArtifactSchema,
  type ExplanationModule,
  type WalkthroughArtifact,
} from "./artifact.js";
import { RevisionSchema, SchemaVersionSchema, StableIdSchema } from "./primitives.js";

export const AddModuleOperationSchema = z
  .object({
    type: z.literal("add"),
    module: ExplanationModuleSchema,
    afterId: StableIdSchema.optional(),
  })
  .strict();

export const ReplaceModuleOperationSchema = z
  .object({
    type: z.literal("replace"),
    targetId: StableIdSchema,
    module: ExplanationModuleSchema,
  })
  .strict()
  .refine(({ targetId, module }) => targetId === module.id, {
    message: "Replacement modules must preserve the stable target ID",
    path: ["module", "id"],
  });

export const MoveModuleOperationSchema = z
  .object({
    type: z.literal("move"),
    targetId: StableIdSchema,
    afterId: StableIdSchema.nullable(),
  })
  .strict()
  .refine(({ targetId, afterId }) => targetId !== afterId, {
    message: "A module cannot be moved after itself",
    path: ["afterId"],
  });

export const AnnotateModuleOperationSchema = z
  .object({
    type: z.literal("annotate"),
    targetId: StableIdSchema,
    annotation: AnnotationSchema,
  })
  .strict();

export const RemoveModuleOperationSchema = z
  .object({
    type: z.literal("remove"),
    targetId: StableIdSchema,
  })
  .strict();

export const SemanticOperationSchema = z.discriminatedUnion("type", [
  AddModuleOperationSchema,
  ReplaceModuleOperationSchema,
  MoveModuleOperationSchema,
  AnnotateModuleOperationSchema,
  RemoveModuleOperationSchema,
]);

export const WalkthroughUpdateSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    id: StableIdSchema,
    eventId: StableIdSchema,
    expectedRevision: RevisionSchema,
    operations: z.array(SemanticOperationSchema).min(1),
  })
  .strict();

export type SemanticOperation = z.infer<typeof SemanticOperationSchema>;
export type WalkthroughUpdate = z.infer<typeof WalkthroughUpdateSchema>;

export class RevisionMismatchError extends Error {
  readonly code = "REVISION_MISMATCH";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(`Expected artifact revision ${expectedRevision}, but current revision is ${currentRevision}`);
    this.name = "RevisionMismatchError";
  }
}

function indexOf(sections: ExplanationModule[], id: string): number {
  return sections.findIndex((section) => section.id === id);
}

function requireIndex(sections: ExplanationModule[], id: string): number {
  const index = indexOf(sections, id);
  if (index === -1) {
    throw new Error(`Unknown Explanation Module ID: ${id}`);
  }
  return index;
}

function insertIndex(sections: ExplanationModule[], afterId: string | null | undefined): number {
  if (afterId === null || afterId === undefined) {
    return afterId === null ? 0 : sections.length;
  }
  return requireIndex(sections, afterId) + 1;
}

function applyOperation(sections: ExplanationModule[], operation: SemanticOperation): void {
  switch (operation.type) {
    case "add": {
      if (indexOf(sections, operation.module.id) !== -1) {
        throw new Error(`Explanation Module ID already exists: ${operation.module.id}`);
      }
      sections.splice(insertIndex(sections, operation.afterId), 0, operation.module);
      return;
    }
    case "replace": {
      sections[requireIndex(sections, operation.targetId)] = operation.module;
      return;
    }
    case "move": {
      const sourceIndex = requireIndex(sections, operation.targetId);
      const [module] = sections.splice(sourceIndex, 1);
      if (module === undefined) {
        throw new Error(`Unknown Explanation Module ID: ${operation.targetId}`);
      }
      sections.splice(insertIndex(sections, operation.afterId), 0, module);
      return;
    }
    case "annotate": {
      const target = sections[requireIndex(sections, operation.targetId)];
      if (target === undefined) {
        throw new Error(`Unknown Explanation Module ID: ${operation.targetId}`);
      }
      target.annotations = [...(target.annotations ?? []), operation.annotation];
      return;
    }
    case "remove": {
      sections.splice(requireIndex(sections, operation.targetId), 1);
      return;
    }
  }
}

export function applyWalkthroughUpdate(
  artifactInput: WalkthroughArtifact,
  updateInput: WalkthroughUpdate,
): WalkthroughArtifact {
  const artifact = WalkthroughArtifactSchema.parse(artifactInput);
  const update = WalkthroughUpdateSchema.parse(updateInput);
  if (update.expectedRevision !== artifact.revision) {
    throw new RevisionMismatchError(update.expectedRevision, artifact.revision);
  }

  const sections = structuredClone(artifact.sections);
  for (const operation of update.operations) {
    applyOperation(sections, operation);
  }

  return WalkthroughArtifactSchema.parse({
    ...artifact,
    revision: artifact.revision + 1,
    sections,
  });
}
