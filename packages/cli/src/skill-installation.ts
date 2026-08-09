import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { AgentCommandInputError } from "./agent-commands.js";

const INSTALLATION_MARKER = ".wmtc-installation.json";
const SKILL_NAME = "walk-me-through-code";

export type SkillHost = "claude-code" | "codex" | "opencode";

export type SkillCommandResult = {
  readonly destination: string;
  readonly host: SkillHost;
  readonly ok: true;
  readonly restartRequired: boolean;
  readonly skillName: typeof SKILL_NAME;
  readonly skillVersion: string;
  readonly status: "skill_current" | "skill_installed" | "skill_verified";
};

export type SkillInstallationErrorCode =
  | "SKILL_INSTALLATION_CONFLICT"
  | "SKILL_INSTALLATION_MODIFIED"
  | "SKILL_NOT_INSTALLED"
  | "SKILL_OUTDATED";

export class SkillInstallationError extends Error {
  readonly code: SkillInstallationErrorCode;

  constructor(code: SkillInstallationErrorCode, message: string) {
    super(message);
    this.name = "SkillInstallationError";
    this.code = code;
  }
}

interface SkillCommandOptions {
  readonly bundledSkillDirectory: string;
  readonly homeDirectory: string;
  readonly skillVersion: string;
}

interface InstallationMarker {
  readonly contentSha256: string;
  readonly managedBy: typeof SKILL_NAME;
  readonly schemaVersion: 1;
  readonly skillName: typeof SKILL_NAME;
  readonly skillVersion: string;
}

interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface ClaimedDirectory {
  readonly destination: string;
  readonly identity: PathIdentity;
}

const HOST_DESTINATIONS: Readonly<Record<SkillHost, readonly string[]>> = {
  codex: [".agents", "skills", SKILL_NAME],
  "claude-code": [".claude", "skills", SKILL_NAME],
  opencode: [".config", "opencode", "skills", SKILL_NAME],
};

function parseCommand(arguments_: readonly string[]): {
  readonly host: SkillHost;
  readonly operation: "install" | "verify";
} {
  const [operation, hostFlag, host, ...extra] = arguments_;
  if (
    (operation !== "install" && operation !== "verify") ||
    hostFlag !== "--host" ||
    (host !== "codex" && host !== "claude-code" && host !== "opencode") ||
    extra.length > 0
  ) {
    throw new AgentCommandInputError(
      "Usage: wmtc skill install|verify --host <codex|claude-code|opencode>",
    );
  }
  return { host, operation };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathIdentity(metadata: { readonly dev: bigint; readonly ino: bigint }): PathIdentity {
  return { device: metadata.dev, inode: metadata.ino };
}

function hasSameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function readStableRegularFile(
  path: string,
): Promise<{ readonly identity: PathIdentity; readonly source: string }> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error();
  const identity = pathIdentity(before);
  const handle = await open(path, "r");
  let source: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !hasSameIdentity(identity, pathIdentity(opened))) {
      throw new Error();
    }
    source = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    !hasSameIdentity(identity, pathIdentity(after))
  ) throw new Error();
  return { identity, source };
}

async function managedDirectoryIdentity(
  destination: string,
  host: SkillHost,
): Promise<PathIdentity> {
  try {
    const metadata = await lstat(destination, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new SkillInstallationError(
        "SKILL_INSTALLATION_CONFLICT",
        `The ${host} skill destination is not a managed directory: ${destination}`,
      );
    }
    return pathIdentity(metadata);
  } catch (error) {
    if (error instanceof SkillInstallationError) throw error;
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `The ${host} skill destination changed while it was being inspected: ${destination}`,
    );
  }
}

async function requireSameDirectory(
  destination: string,
  host: SkillHost,
  expected: PathIdentity,
): Promise<void> {
  if (!hasSameIdentity(await managedDirectoryIdentity(destination, host), expected)) {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `The ${host} skill destination changed while it was being inspected: ${destination}`,
    );
  }
}

async function requireSameDirectories(
  directories: readonly ClaimedDirectory[],
  host: SkillHost,
): Promise<void> {
  for (const directory of directories) {
    await requireSameDirectory(directory.destination, host, directory.identity);
  }
}

function updateFingerprintField(digest: Hash, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  digest.update(length);
  digest.update(bytes);
}

async function contentSha256(root: string): Promise<string> {
  const digest = createHash("sha256");

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      if (relativePath === INSTALLATION_MARKER) continue;
      if (entry.isDirectory()) {
        updateFingerprintField(digest, "directory");
        updateFingerprintField(digest, relativePath);
        await visit(absolutePath);
      } else if (entry.isFile()) {
        updateFingerprintField(digest, "file");
        updateFingerprintField(digest, relativePath);
        updateFingerprintField(digest, await readFile(absolutePath));
      } else {
        throw new SkillInstallationError(
          "SKILL_INSTALLATION_CONFLICT",
          `Skill content contains an unsupported filesystem entry: ${relativePath}`,
        );
      }
    }
  };

  await visit(root);
  return `sha256:${digest.digest("hex")}`;
}

async function publishStagedEntry(
  source: string,
  destination: string,
  host: SkillHost,
  claimedParents: readonly ClaimedDirectory[],
  allClaimedDirectories: ClaimedDirectory[],
): Promise<void> {
  await requireSameDirectories(claimedParents, host);
  const metadata = await lstat(source);
  if (metadata.isDirectory()) {
    await mkdir(destination);
    await requireSameDirectories(claimedParents, host);
    const claimedDirectory = {
      destination,
      identity: await managedDirectoryIdentity(destination, host),
    };
    allClaimedDirectories.push(claimedDirectory);
    const claimedPath = [...claimedParents, claimedDirectory];
    await requireSameDirectories(claimedPath, host);
    const entries = await readdir(source);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await publishStagedEntry(
        join(source, entry),
        join(destination, entry),
        host,
        claimedPath,
        allClaimedDirectories,
      );
    }
    await requireSameDirectories(claimedPath, host);
  } else if (metadata.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await requireSameDirectories(claimedParents, host);
  } else {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `Skill content contains an unsupported filesystem entry: ${source}`,
    );
  }
}

async function requirePublishedMarker(
  markerPath: string,
  host: SkillHost,
  markerHandle: FileHandle,
  expectedIdentity: PathIdentity,
  expectedSource: string,
): Promise<void> {
  try {
    const openedMarker = await markerHandle.stat({ bigint: true });
    if (
      !openedMarker.isFile() ||
      !hasSameIdentity(expectedIdentity, pathIdentity(openedMarker))
    ) throw new Error();
    const publishedMarker = await readStableRegularFile(markerPath);
    if (
      !hasSameIdentity(expectedIdentity, publishedMarker.identity) ||
      publishedMarker.source !== expectedSource
    ) throw new Error();
  } catch {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `The ${host} skill management marker changed while the skill was being installed: ${markerPath}`,
    );
  }
}

async function installFresh(
  host: SkillHost,
  destination: string,
  options: SkillCommandOptions,
  skillVersion: string,
): Promise<SkillCommandResult> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(join(parent, `.${SKILL_NAME}-install-`));
  const stagedDestination = join(stagingRoot, SKILL_NAME);
  try {
    await cp(options.bundledSkillDirectory, stagedDestination, { recursive: true });
    const stagedSkill = await lstat(join(stagedDestination, "SKILL.md"));
    if (stagedSkill.isSymbolicLink() || !stagedSkill.isFile()) {
      throw new SkillInstallationError(
        "SKILL_INSTALLATION_CONFLICT",
        "The bundled skill must contain a regular SKILL.md file.",
      );
    }
    const marker: InstallationMarker = {
      schemaVersion: 1,
      managedBy: SKILL_NAME,
      skillName: SKILL_NAME,
      skillVersion,
      contentSha256: await contentSha256(stagedDestination),
    };
    const markerSource = `${JSON.stringify(marker, null, 2)}\n`;
    try {
      await mkdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new SkillInstallationError(
          "SKILL_INSTALLATION_CONFLICT",
          `The ${host} skill destination appeared while the skill was being installed: ${destination}`,
        );
      }
      throw error;
    }

    const claimedRoot = {
      destination,
      identity: await managedDirectoryIdentity(destination, host),
    };
    const claimedDirectories = [claimedRoot];
    const entries = (await readdir(stagedDestination))
      .filter((entry) => entry !== INSTALLATION_MARKER)
      .sort((left, right) => left.localeCompare(right));
    let markerHandle: FileHandle | undefined;
    try {
      for (const entry of entries) {
        if (entry === "SKILL.md") continue;
        await publishStagedEntry(
          join(stagedDestination, entry),
          join(destination, entry),
          host,
          [claimedRoot],
          claimedDirectories,
        );
      }
      const markerPath = join(destination, INSTALLATION_MARKER);
      try {
        markerHandle = await open(markerPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SkillInstallationError(
            "SKILL_INSTALLATION_CONFLICT",
            `The ${host} skill management marker appeared while the skill was being installed: ${markerPath}`,
          );
        }
        throw error;
      }
      const markerMetadata = await markerHandle.stat({ bigint: true });
      if (!markerMetadata.isFile()) {
        throw new SkillInstallationError(
          "SKILL_INSTALLATION_CONFLICT",
          `The ${host} skill management marker is not a regular file: ${markerPath}`,
        );
      }
      const markerIdentity = pathIdentity(markerMetadata);
      await markerHandle.writeFile(markerSource, "utf8");
      await requireSameDirectories(claimedDirectories, host);
      await publishStagedEntry(
        join(stagedDestination, "SKILL.md"),
        join(destination, "SKILL.md"),
        host,
        [claimedRoot],
        claimedDirectories,
      );
      await requireSameDirectories(claimedDirectories, host);
      const publishedFingerprint = await contentSha256(destination);
      await requireSameDirectories(claimedDirectories, host);
      if (publishedFingerprint !== marker.contentSha256) {
        throw new SkillInstallationError(
          "SKILL_INSTALLATION_CONFLICT",
          `The ${host} skill destination changed while the skill was being installed: ${destination}`,
        );
      }
      await requireSameDirectory(destination, host, claimedRoot.identity);
      await requirePublishedMarker(
        markerPath,
        host,
        markerHandle,
        markerIdentity,
        markerSource,
      );
      await requireSameDirectories(claimedDirectories, host);
    } catch (error) {
      if (error instanceof SkillInstallationError) throw error;
      throw new SkillInstallationError(
        "SKILL_INSTALLATION_CONFLICT",
        `The ${host} skill destination changed while the skill was being installed: ${destination}`,
      );
    } finally {
      await markerHandle?.close();
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  return {
    ok: true,
    status: "skill_installed",
    host,
    skillName: SKILL_NAME,
    skillVersion,
    destination,
    restartRequired: true,
  };
}

function isInstallationMarker(value: unknown): value is InstallationMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Partial<InstallationMarker>;
  return marker.schemaVersion === 1 &&
    marker.managedBy === SKILL_NAME &&
    marker.skillName === SKILL_NAME &&
    typeof marker.skillVersion === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(marker.contentSha256 ?? "");
}

async function requireCurrentInstallation(
  destination: string,
  host: SkillHost,
  skillVersion: string,
): Promise<void> {
  const destinationIdentity = await managedDirectoryIdentity(destination, host);

  let marker: unknown;
  try {
    const markerPath = join(destination, INSTALLATION_MARKER);
    const { source } = await readStableRegularFile(markerPath);
    await requireSameDirectory(destination, host, destinationIdentity);
    marker = JSON.parse(source);
  } catch {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `The existing ${host} skill installation is not managed by ${SKILL_NAME}.`,
    );
  }
  if (!isInstallationMarker(marker)) {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_CONFLICT",
      `The existing ${host} skill installation has an invalid management marker.`,
    );
  }
  if (marker.skillVersion !== skillVersion) {
    throw new SkillInstallationError(
      "SKILL_OUTDATED",
      `${host} has ${SKILL_NAME} skill ${marker.skillVersion}; runtime ${skillVersion} requires a managed update.`,
    );
  }
  const currentFingerprint = await contentSha256(destination);
  await requireSameDirectory(destination, host, destinationIdentity);
  if (currentFingerprint !== marker.contentSha256) {
    throw new SkillInstallationError(
      "SKILL_INSTALLATION_MODIFIED",
      `The managed ${host} skill installation contains local modifications.`,
    );
  }
}

export async function executeSkillCommand(
  arguments_: readonly string[],
  options: SkillCommandOptions,
): Promise<SkillCommandResult> {
  const { host, operation } = parseCommand(arguments_);
  const destination = join(options.homeDirectory, ...HOST_DESTINATIONS[host]);
  const skillVersion = options.skillVersion;

  if (operation === "install" && !(await pathExists(destination))) {
    return installFresh(host, destination, options, skillVersion);
  }
  if (!(await pathExists(destination))) {
    throw new SkillInstallationError(
      "SKILL_NOT_INSTALLED",
      `The ${SKILL_NAME} skill is not installed for ${host}.`,
    );
  }
  await requireCurrentInstallation(destination, host, skillVersion);
  return {
    ok: true,
    status: operation === "install" ? "skill_current" : "skill_verified",
    host,
    skillName: SKILL_NAME,
    skillVersion,
    destination,
    restartRequired: false,
  };
}
