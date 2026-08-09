import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import { npmInvocation } from "./npm-executable.mjs";
import { packageRecordFromPackOutput } from "./npm-pack-result.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
const contractsPackage = JSON.parse(await readFile(
  new URL("packages/contracts/package.json", root),
  "utf8",
));
const npmConfiguration = await readFile(new URL(".npmrc", root), "utf8");
const thirdPartyNotices = await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
const zodLicense = await readFile(new URL("node_modules/zod/LICENSE", root), "utf8");
const nodeVersion = (await readFile(new URL(".nvmrc", root), "utf8")).trim();
const compatibility = JSON.parse(await readFile(
  new URL("skills/walk-me-through-code/compatibility.json", root),
  "utf8",
));
const skillInstructions = await readFile(
  new URL("skills/walk-me-through-code/SKILL.md", root),
  "utf8",
);
const codexSkillMetadata = await readFile(
  new URL("skills/walk-me-through-code/agents/openai.yaml", root),
  "utf8",
);
const cliSource = await readFile(new URL("packages/cli/src/index.ts", root), "utf8");

const expectedScripts = {
  build: "corepack npm run build --workspaces --if-present",
  "build:contracts": "corepack npm run build --workspace @walk-me-through-code/contracts",
  prelint: "corepack npm run build:contracts",
  lint: "eslint .",
  typecheck: "tsc --build --pretty false",
  prepack: "corepack npm run build",
  prepublishOnly: "corepack npm run verify:release",
  "verify:release": "corepack npm run build && node scripts/verify-release-package.mjs",
};
const expectedFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "assets/walk-me-through-the-code-banner.webp",
  "packages/cli/dist/*.js",
  "packages/cli/dist/session/*.js",
  "packages/viewer/dist",
  "skills/walk-me-through-code",
  "README.md",
];
const expectedDependencies = {
  "@walk-me-through-code/contracts": "0.1.1",
  zod: "4.4.3",
};
const expectedDevDependencies = {
  "@eslint/js": "10.0.1",
  "@types/node": "24.13.3",
  eslint: "10.7.0",
  typescript: "6.0.3",
  "typescript-eslint": "8.64.0",
};
const requiredPackageFiles = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "assets/walk-me-through-the-code-banner.webp",
  "packages/cli/dist/index.js",
  "packages/viewer/dist/index.html",
  "skills/walk-me-through-code/SKILL.md",
  "skills/walk-me-through-code/compatibility.json",
  "skills/walk-me-through-code/agents/openai.yaml",
  "skills/walk-me-through-code/references/artifact-and-bridge.md",
  "node_modules/@walk-me-through-code/contracts/dist/index.js",
];
const forbiddenPackagePaths = [
  /^\.github(?:\/|$)/,
  /^\.trip-mini\.yml$/,
  /^CONTEXT\.md$/,
  /^RELEASE\.md$/,
  /^docs(?:\/|$)/,
  /^e2e(?:\/|$)/,
  /^test(?:\/|$)/,
  /^packages\/[^/]+\/(?:src|test|fixtures)(?:\/|$)/,
  /^(?:playwright|vitest)\.config\.ts$/,
  /^test-results(?:\/|$)/,
  /^playwright-report(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)live-sessions\.sqlite3(?:-|$)/,
  /\.d\.ts(?:\.map)?$/,
];
const hostDestinations = {
  codex: [".agents", "skills", "walk-me-through-code"],
  "claude-code": [".claude", "skills", "walk-me-through-code"],
  opencode: [".config", "opencode", "skills", "walk-me-through-code"],
};

function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function assertExactVersions(dependencies, label) {
  for (const [name, version] of Object.entries(dependencies ?? {})) {
    assert.equal(
      isExactVersion(version),
      true,
      `${label} ${name} must use an exact version, found ${version}`,
    );
  }
}

function runNode(arguments_, options) {
  const result = spawnSync(process.execPath, arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function startInstalledViewer(executable, artifactPath, environment) {
  const child = spawn(
    process.execPath,
    [
      executable,
      "open",
      artifactPath,
      "--skill-version",
      packageJson.version,
      "--no-open",
      "--port",
      "0",
    ],
    { cwd: environment.HOME, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Installed Viewer did not start in time: ${stderr || stdout}`));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      try {
        resolve({ child, result: JSON.parse(stdout.slice(0, newline)) });
      } catch (error) {
        child.kill("SIGTERM");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(
        `Installed Viewer exited before startup with code ${String(code)} and signal ${String(signal)}: ${stderr || stdout}`,
      ));
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function stopInstalledViewer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Installed Viewer did not stop after SIGTERM")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

assert.equal(packageJson.name, "@hypertectonic/walk-me-through-the-code");
assert.equal(packageJson.version, "0.1.1");
assert.equal(
  packageJson.description,
  "Interactive local code walkthroughs with source-linked explanations and agent-guided follow-up",
);
assert.equal(packageJson.license, "MIT");
assert.equal(packageJson.private, false);
assert.deepEqual(packageJson.keywords, [
  "code-comprehension",
  "developer-tools",
  "ai-agent",
  "walkthrough",
  "cli",
]);
assert.deepEqual(packageJson.workspaces, ["packages/*"]);
assert.deepEqual(packageJson.files, expectedFiles);
assert.deepEqual(packageJson.scripts, expectedScripts);
assert.deepEqual(packageJson.dependencies, expectedDependencies);
assert.deepEqual(packageJson.devDependencies, expectedDevDependencies);
assert.deepEqual(packageJson.bundleDependencies, ["@walk-me-through-code/contracts"]);
assert.deepEqual(packageJson.allowScripts, { fsevents: false });
assert.deepEqual(packageJson.overrides, { "brace-expansion": "5.0.9" });
assert.deepEqual(packageJson.exports, {});
assert.equal(packageJson.engines.node, ">=24.15.0 <25");
assert.deepEqual(packageJson.devEngines, {
  runtime: { name: "node", version: ">=24.15.0 <25", onFail: "error" },
  packageManager: { name: "npm", version: "12.0.2", onFail: "error" },
});
assert.equal(packageJson.packageManager, "npm@12.0.2");
assert.equal(nodeVersion, "24.18.1");
assert.deepEqual(packageJson.repository, {
  type: "git",
  url: "git+https://github.com/hypertectonic/walk-me-through-the-code.git",
});
assert.equal(
  packageJson.homepage,
  "https://github.com/hypertectonic/walk-me-through-the-code#readme",
);
assert.deepEqual(packageJson.bugs, {
  url: "https://github.com/hypertectonic/walk-me-through-the-code/issues",
});
assert.deepEqual(packageJson.publishConfig, { access: "public" });
assertExactVersions(packageJson.dependencies, "production dependency");
assertExactVersions(packageJson.devDependencies, "development dependency");
assert.match(npmConfiguration, /^strict-allow-scripts=true$/mu);
assert.match(thirdPartyNotices, /The bundled browser Viewer includes portions of Zod 4\.4\.3\./u);
assert.equal(thirdPartyNotices.includes(zodLicense.trim()), true, "the Zod license notice is missing");

assert.equal(packageLock.name, packageJson.name);
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.lockfileVersion, 3);
assert.equal(packageLock.packages[""].version, packageJson.version);
assert.equal(packageLock.packages[""].license, packageJson.license);
assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node);
assert.deepEqual(packageLock.packages[""].workspaces, packageJson.workspaces);
assert.deepEqual(packageLock.packages[""].bundleDependencies, packageJson.bundleDependencies);
assert.deepEqual(packageLock.packages[""].dependencies, expectedDependencies);
assert.deepEqual(packageLock.packages[""].devDependencies, expectedDevDependencies);

for (const workspace of ["cli", "contracts", "viewer"]) {
  const manifest = JSON.parse(await readFile(
    new URL(`packages/${workspace}/package.json`, root),
    "utf8",
  ));
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.private, true);
  assert.equal(packageLock.packages[`packages/${workspace}`].version, packageJson.version);
  assertExactVersions(manifest.dependencies, `${workspace} dependency`);
  assertExactVersions(manifest.peerDependencies, `${workspace} peer dependency`);
  assertExactVersions(manifest.devDependencies, `${workspace} development dependency`);
}

assert.deepEqual(contractsPackage.files, ["dist/*.js"]);
assert.deepEqual(contractsPackage.exports, { ".": { import: "./dist/index.js" } });
assert.deepEqual(contractsPackage.peerDependencies, { zod: "4.4.3" });
assert.equal(Object.hasOwn(contractsPackage, "dependencies"), false);
assert.equal(compatibility.skillVersion, packageJson.version);
assert.deepEqual(compatibility.supportedRuntimeVersions, [packageJson.version]);
assert.match(skillInstructions, /Use only when the user explicitly invokes or names/u);
assert.doesNotMatch(skillInstructions, /walk through, explain, trace, understand/u);
assert.match(codexSkillMetadata, /allow_implicit_invocation: false/u);
assert.match(cliSource, /const VERSION = "0\.1\.1";/u);
assert.match(cliSource, /const SUPPORTED_SKILL_VERSIONS = \["0\.1\.1"\] as const;/u);

const temporaryRoot = await mkdtemp(join(tmpdir(), "wmtc-public-package-"));
try {
  const packDirectory = join(temporaryRoot, "pack");
  const installPrefix = join(temporaryRoot, "install");
  const npmCache = join(temporaryRoot, "npm-cache");
  const isolatedHome = join(temporaryRoot, "home");
  const repositoryRoot = join(temporaryRoot, "repository");
  const stateRoot = join(temporaryRoot, "state");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(installPrefix),
    mkdir(isolatedHome),
    mkdir(repositoryRoot),
  ]);

  const environment = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    WMTC_STATE_DIRECTORY: stateRoot,
    npm_config_cache: npmCache,
  };
  const npm = npmInvocation();
  const npmVersion = spawnSync(npm.executable, [...npm.arguments, "--version"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  assert.equal(npmVersion.status, 0, npmVersion.stderr || npmVersion.stdout);
  assert.equal(npmVersion.stdout.trim(), "12.0.2", "release verification requires npm 12.0.2");

  const packed = spawnSync(
    npm.executable,
    [
      ...npm.arguments,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
    ],
    { cwd: rootPath, encoding: "utf8", env: environment },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packageRecord = packageRecordFromPackOutput(
    JSON.parse(packed.stdout),
    packageJson.name,
  );
  assert.ok(packageRecord.entryCount <= 100, "packed package contains more than 100 entries");
  assert.ok(packageRecord.size <= 500_000, "packed package exceeds 500,000 bytes");
  assert.ok(packageRecord.unpackedSize <= 1_000_000, "unpacked package exceeds 1,000,000 bytes");

  const packagePaths = packageRecord.files.map(({ path }) => path);
  for (const requiredPath of requiredPackageFiles) {
    assert.ok(packagePaths.includes(requiredPath), `${requiredPath} is missing from the package`);
  }
  for (const packagePath of packagePaths) {
    assert.equal(
      forbiddenPackagePaths.some((pattern) => pattern.test(packagePath)),
      false,
      `publicly excluded path is present in the package: ${packagePath}`,
    );
  }
  assert.ok(packageRecord.bundled.includes("@walk-me-through-code/contracts"));
  assert.equal(packageRecord.bundled.includes("zod"), false);
  assert.equal(
    packagePaths.some((path) => path.startsWith("node_modules/zod/")),
    false,
    "zod must be installed as a normal runtime dependency",
  );

  const viewerAssets = packagePaths.filter((path) => (
    path.startsWith("packages/viewer/dist/") && /\.(?:css|html|js)$/.test(path)
  ));
  assert.ok(viewerAssets.length >= 3, "bundled Viewer assets are incomplete");
  for (const assetPath of viewerAssets) {
    const contents = await readFile(new URL(assetPath, root), "utf8");
    assert.doesNotMatch(contents, /(?:src|href)\s*=\s*["']https?:\/\//i);
    assert.doesNotMatch(contents, /@import\s+(?:url\()?\s*["']?https?:\/\//i);
  }

  const tarballPath = join(packDirectory, packageRecord.filename);
  const installation = spawnSync(
    npm.executable,
    [
      ...npm.arguments,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installPrefix,
      tarballPath,
    ],
    { cwd: temporaryRoot, encoding: "utf8", env: environment },
  );
  assert.equal(installation.status, 0, installation.stderr || installation.stdout);

  const installedPackageRoot = join(
    installPrefix,
    "node_modules",
    ...packageJson.name.split("/"),
  );
  const installedManifest = JSON.parse(await readFile(
    join(installedPackageRoot, "package.json"),
    "utf8",
  ));
  assert.equal(installedManifest.version, packageJson.version);
  assert.equal(installedManifest.bin.wmtc, "packages/cli/dist/index.js");
  assert.deepEqual(installedManifest.exports, {});

  const installedZod = JSON.parse(await readFile(
    join(installPrefix, "node_modules", "zod", "package.json"),
    "utf8",
  ));
  assert.equal(installedZod.version, packageJson.dependencies.zod);

  const installedCli = join(installedPackageRoot, installedManifest.bin.wmtc);
  const versionResult = runNode([installedCli, "--version"], {
    cwd: temporaryRoot,
    env: environment,
  });
  assert.equal(versionResult.stderr, "");
  assert.equal(versionResult.stdout.trim(), packageJson.version);

  const helpResult = runNode([installedCli, "--help"], {
    cwd: temporaryRoot,
    env: environment,
  });
  assert.equal(helpResult.stderr, "");
  assert.match(helpResult.stdout, /Usage: wmtc <command> \[options\]/u);

  const compatibilityResult = runNode([installedCli, "compatibility"], {
    cwd: temporaryRoot,
    env: environment,
  });
  assert.equal(compatibilityResult.stderr, "");
  assert.deepEqual(JSON.parse(compatibilityResult.stdout), {
    schemaVersion: 1,
    runtimeVersion: packageJson.version,
    supportedSkillVersions: [packageJson.version],
  });

  const publicImport = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(packageJson.name)})`],
    { cwd: installPrefix, encoding: "utf8", env: environment },
  );
  assert.notEqual(publicImport.status, 0, "the CLI-only package unexpectedly supports root import");
  assert.match(publicImport.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);

  for (const [host, destinationParts] of Object.entries(hostDestinations)) {
    const destination = join(isolatedHome, ...destinationParts);
    const installResult = runNode(
      [installedCli, "skill", "install", "--host", host],
      { cwd: temporaryRoot, env: environment },
    );
    assert.equal(installResult.stderr, "");
    assert.deepEqual(JSON.parse(installResult.stdout), {
      ok: true,
      status: "skill_installed",
      host,
      skillName: "walk-me-through-code",
      skillVersion: packageJson.version,
      destination,
      restartRequired: true,
    });

    const verifyResult = runNode(
      [installedCli, "skill", "verify", "--host", host],
      { cwd: temporaryRoot, env: environment },
    );
    assert.equal(verifyResult.stderr, "");
    assert.deepEqual(JSON.parse(verifyResult.stdout), {
      ok: true,
      status: "skill_verified",
      host,
      skillName: "walk-me-through-code",
      skillVersion: packageJson.version,
      destination,
      restartRequired: false,
    });
  }

  const artifactPath = join(temporaryRoot, "walkthrough.json");
  await writeFile(artifactPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "release-smoke-walkthrough",
    revision: 1,
    title: "Release package smoke walkthrough",
    repositoryState: {
      root: repositoryRoot,
      generatedAt: "2026-08-08T00:00:00.000Z",
      hasUncommittedChanges: false,
    },
    sections: [{
      id: "release-smoke-story",
      type: "story",
      title: "Installed package lifecycle",
      trigger: "A user opens a valid local Walkthrough Artifact.",
      path: "The installed CLI validates the artifact and starts the local Viewer.",
      outcome: "The user can end the created Live Session cleanly.",
      purpose: "Verify the packed CLI works outside its source checkout.",
    }],
  })}\n`);
  const opened = await startInstalledViewer(installedCli, artifactPath, environment);
  try {
    assert.equal(opened.result.ok, true);
    assert.equal(opened.result.status, "viewer_open");
    assert.match(opened.result.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const ended = runNode(
      [
        installedCli,
        "end",
        opened.result.sessionId,
        "--skill-version",
        packageJson.version,
      ],
      { cwd: repositoryRoot, env: environment },
    );
    assert.equal(JSON.parse(ended.stdout).status, "ended");
  } finally {
    await stopInstalledViewer(opened.child);
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

process.stdout.write("Public package acceptance verified.\n");
