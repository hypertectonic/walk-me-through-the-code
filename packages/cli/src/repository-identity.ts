import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { WalkthroughArtifactSchema, type WalkthroughArtifact } from "@walk-me-through-code/contracts";

export interface RepositoryIdentity {
  readonly key: string;
  readonly root: string;
  readonly scope?: string;
}

export interface NormalizedArtifactRepository {
  readonly artifact: WalkthroughArtifact;
  readonly identity: RepositoryIdentity;
}

function windowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizeWindowsRoot(root: string): string {
  const lexical = win32.normalize(root);
  const normalized = /^[A-Za-z]:\\$/.test(lexical) ? lexical : lexical.replace(/[\\/]+$/, "");
  if (normalized.startsWith("\\\\")) return normalized.toLowerCase();
  return `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1).toLowerCase()}`;
}

function nearestGitRoot(start: string): string | undefined {
  for (let candidate = start;; candidate = dirname(candidate)) {
    if (existsSync(resolve(candidate, ".git"))) return candidate;
    const parent = dirname(candidate);
    if (candidate === parent) return undefined;
  }
}

function physicalDirectory(root: string): string {
  const absolute = resolve(root);
  if (!existsSync(absolute)) return absolute;
  const physical = realpathSync.native(absolute);
  return statSync(physical).isDirectory() ? physical : dirname(physical);
}

function repositoryKey(root: string): string {
  const normalizedRoot = windowsPath(root) ? root.toLowerCase() : root;
  const digest = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 32);
  return `repository-${digest}`;
}

/**
 * Produces the one repository identity used by artifacts and Live Sessions.
 * Git checkouts use their physical top-level directory. A selected package
 * below that root becomes scope. Non-Git projects retain their selected root.
 */
export function repositoryIdentity(selectedRoot: string): RepositoryIdentity {
  let root: string;
  let scope: string | undefined;
  if (windowsPath(selectedRoot) && sep !== "\\") {
    root = normalizeWindowsRoot(selectedRoot);
  } else {
    const selected = physicalDirectory(selectedRoot);
    root = nearestGitRoot(selected) ?? selected;
    const selectedScope = relative(root, selected);
    if (selectedScope !== "") scope = selectedScope.split(sep).join("/");
  }
  if (!isAbsolute(root) && !windowsPath(root)) root = resolve(root);
  return {
    key: repositoryKey(root),
    root,
    ...(scope === undefined ? {} : { scope }),
  };
}

function prefixSourceEvidenceFiles(
  value: unknown,
  prefix: string,
  sourceEvidence = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => prefixSourceEvidenceFiles(item, prefix, sourceEvidence));
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    prefixSourceEvidenceFiles(child, prefix, key === "sourceEvidence"),
  ]));
  if (sourceEvidence && typeof record.file === "string") {
    normalized.file = `${prefix}/${record.file}`;
  }
  return normalized;
}

export function normalizeArtifactRepository(
  artifact: WalkthroughArtifact,
): NormalizedArtifactRepository {
  const selectedIdentity = repositoryIdentity(artifact.repositoryState.root);
  const selectedScope = selectedIdentity.scope;
  const repositoryScope = artifact.repositoryState.scope;
  const normalizedScope = [selectedScope, repositoryScope].filter(Boolean).join("/") || undefined;
  const identity: RepositoryIdentity = {
    key: repositoryKey(selectedIdentity.root),
    root: selectedIdentity.root,
    ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
  };
  const normalized = selectedScope === undefined
    ? artifact
    : prefixSourceEvidenceFiles(artifact, selectedScope) as WalkthroughArtifact;
  return {
    artifact: WalkthroughArtifactSchema.parse({
      ...normalized,
      repositoryState: {
        ...normalized.repositoryState,
        root: identity.root,
        ...(normalizedScope === undefined ? {} : { scope: normalizedScope }),
      },
    }),
    identity,
  };
}
