import { open, realpath, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  sourceContentHash,
  WalkthroughArtifactSchema,
  type ExplanationModule,
  type WalkthroughArtifact,
} from "@walk-me-through-code/contracts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const MAX_SEARCHED_FILES = 10_000;
const MAX_SEARCHED_BYTES = 1_000_000;

interface Relocation {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

interface EvidenceScan {
  files(): Promise<readonly string[]>;
  exactRange(
    file: string,
    startLine: number,
    endLine: number,
    expected: string,
  ): Promise<"current" | "changed" | "missing">;
  source(file: string): Promise<string | undefined>;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function repositoryPath(root: string, file: string): string {
  return resolve(root, ...file.split(/[\\/]/));
}

async function safeSource(
  root: string,
  file: string,
  maximumBytes?: number,
): Promise<string | undefined> {
  const candidate = repositoryPath(root, file);
  if (!isInside(root, candidate)) return undefined;
  try {
    const physical = await realpath(candidate);
    if (!isInside(root, physical)) return undefined;
    const metadata = await stat(physical);
    if (!metadata.isFile() || (maximumBytes !== undefined && metadata.size > maximumBytes)) {
      return undefined;
    }
    return await readFile(physical, "utf8");
  } catch {
    return undefined;
  }
}

async function safeExactRange(
  root: string,
  file: string,
  startLine: number,
  endLine: number,
  expected: string,
): Promise<"current" | "changed" | "missing"> {
  const candidate = repositoryPath(root, file);
  if (!isInside(root, candidate)) return "missing";
  let handle;
  try {
    const physical = await realpath(candidate);
    if (!isInside(root, physical)) return "missing";
    const metadata = await stat(physical);
    if (!metadata.isFile()) return "missing";
    handle = await open(physical, "r");

    const expectedBytes = Buffer.from(expected.replaceAll("\r\n", "\n"), "utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let expectedOffset = 0;
    let fileOffset = 0;
    let line = 1;
    let pendingCarriageReturn = false;

    const compareByte = (byte: number): boolean => {
      if (line < startLine || line > endLine) return true;
      if (expectedBytes[expectedOffset] !== byte) return false;
      expectedOffset += 1;
      return true;
    };
    const finishLine = (): boolean | undefined => {
      if (line >= startLine && line < endLine && !compareByte(0x0a)) return false;
      if (line === endLine) return expectedOffset === expectedBytes.length;
      line += 1;
      return undefined;
    };

    let bytesRead = buffer.length;
    while (bytesRead > 0) {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, fileOffset));
      if (bytesRead === 0) continue;
      fileOffset += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        const byte = buffer[index] ?? 0;
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          if (byte === 0x0a) {
            const result = finishLine();
            if (result !== undefined) return result ? "current" : "changed";
            continue;
          }
          if (!compareByte(0x0d)) return "changed";
        }
        if (byte === 0x0d) {
          pendingCarriageReturn = true;
        } else if (byte === 0x0a) {
          const result = finishLine();
          if (result !== undefined) return result ? "current" : "changed";
        } else if (!compareByte(byte)) {
          return "changed";
        }
      }
    }
    if (pendingCarriageReturn && !compareByte(0x0d)) return "changed";
    return line === endLine && expectedOffset === expectedBytes.length ? "current" : "changed";
  } catch {
    return "missing";
  } finally {
    await handle?.close();
  }
}

function matchingRanges(source: string, excerpt: string): readonly {
  readonly startLine: number;
  readonly endLine: number;
}[] {
  const sourceLines = source.split(/\r?\n/);
  const excerptLines = excerpt.split(/\r?\n/);
  const normalizedExcerpt = excerpt.replaceAll("\r\n", "\n");
  const matches = [];
  for (let index = 0; index <= sourceLines.length - excerptLines.length; index += 1) {
    const candidate = sourceLines.slice(index, index + excerptLines.length).join("\n");
    if (candidate === normalizedExcerpt) {
      matches.push({
        startLine: index + 1,
        endLine: index + excerptLines.length,
      });
    }
  }
  return matches;
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= MAX_SEARCHED_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_SEARCHED_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  await visit(root);
  return files;
}

async function uniqueRelocation(
  scan: EvidenceScan,
  excerpt: Extract<ExplanationModule, { type: "sourceExcerpt" }>,
  originalSource: string | undefined,
): Promise<Relocation | undefined> {
  const matches: Relocation[] = [];
  if (originalSource !== undefined) {
    for (const range of matchingRanges(originalSource, excerpt.code)) {
      matches.push({ file: excerpt.sourceEvidence.file, ...range });
    }
  }
  for (const file of await scan.files()) {
    if (file === excerpt.sourceEvidence.file) continue;
    const source = await scan.source(file);
    if (source === undefined) continue;
    for (const range of matchingRanges(source, excerpt.code)) {
      matches.push({ file, ...range });
      if (matches.length > 1) return undefined;
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function evaluateExcerpt(
  scan: EvidenceScan,
  checkedAt: string,
  excerpt: Extract<ExplanationModule, { type: "sourceExcerpt" }>,
): Promise<Extract<ExplanationModule, { type: "sourceExcerpt" }>> {
  const exactState = await scan.exactRange(
    excerpt.sourceEvidence.file,
    excerpt.sourceEvidence.startLine,
    excerpt.sourceEvidence.endLine,
    excerpt.code,
  );
  if (exactState === "current") {
    return {
      ...excerpt,
      evidenceState: {
        status: "current",
        checkedAt,
        currentFile: excerpt.sourceEvidence.file,
        currentStartLine: excerpt.sourceEvidence.startLine,
        currentEndLine: excerpt.sourceEvidence.endLine,
      },
    };
  }

  const relocationSource = await scan.source(excerpt.sourceEvidence.file);
  const relocated = await uniqueRelocation(scan, excerpt, relocationSource);
  return {
    ...excerpt,
    evidenceState: relocated === undefined
      ? {
          status: exactState === "missing" ? "missing" : "changed",
          checkedAt,
        }
      : {
          status: "relocated",
          checkedAt,
          currentFile: relocated.file,
          currentStartLine: relocated.startLine,
          currentEndLine: relocated.endLine,
        },
  };
}

export async function evaluateArtifactEvidence(
  artifactInput: WalkthroughArtifact,
  checkedAt = new Date().toISOString(),
): Promise<WalkthroughArtifact> {
  const artifact = WalkthroughArtifactSchema.parse(artifactInput);
  let root: string;
  try {
    root = await realpath(artifact.repositoryState.root);
  } catch {
    root = resolve(artifact.repositoryState.root);
  }
  let files: Promise<readonly string[]> | undefined;
  const exactRanges = new Map<string, Promise<"current" | "changed" | "missing">>();
  const sources = new Map<string, Promise<string | undefined>>();
  const scan: EvidenceScan = {
    files: () => files ??= sourceFiles(root),
    exactRange: (file, startLine, endLine, expected) => {
      const key = JSON.stringify([file, startLine, endLine, sourceContentHash(expected)]);
      let result = exactRanges.get(key);
      if (result === undefined) {
        result = safeExactRange(root, file, startLine, endLine, expected);
        exactRanges.set(key, result);
      }
      return result;
    },
    source: (file) => {
      let source = sources.get(file);
      if (source === undefined) {
        source = safeSource(root, file, MAX_SEARCHED_BYTES);
        sources.set(file, source);
      }
      return source;
    },
  };
  const sections = await Promise.all(artifact.sections.map(async (section) =>
    section.type === "sourceExcerpt"
      ? await evaluateExcerpt(scan, checkedAt, section)
      : section,
  ));
  return WalkthroughArtifactSchema.parse({ ...artifact, sections });
}
