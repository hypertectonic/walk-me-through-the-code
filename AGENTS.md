# Installation agent instructions

These instructions apply when a user asks you to install Walk Me Through the
Code from this source checkout. They are installation guidance only. They do
not authorize publishing, pushing, changing remotes, creating tags or releases,
or updating a registry.

## Safe installation workflow

1. Identify the user's agent host before installing. The supported host values
   are `codex`, `claude-code`, and `opencode`. If the host is ambiguous, ask.
2. Confirm that this checkout's `package.json` identifies
   `@hypertectonic/walk-me-through-the-code` version `0.1.1`, requires Node `>=24.15.0 <25`, and pins
   npm `12.0.2` through `packageManager`.
3. Run `node --version` and `corepack npm --version`, then verify both requirements.
   Stop with a clear explanation if either does not match.
4. Never use `sudo` for npm or skill installation. If the npm global prefix is
   not writable, stop and ask the user to configure a user-writable prefix.
5. From the repository root, run `corepack npm ci` and then `corepack npm pack`. Capture the exact
   tarball path reported by `corepack npm pack`.
6. Install that exact generated tarball with `corepack npm install --global <tarball>`.
   Do not substitute the Git URL or an unpacked checkout path.
7. Run `wmtc --version` and require `0.1.1`. Run `wmtc compatibility` and
   require runtime `0.1.1` with supported skill version `0.1.1`.
8. Run `wmtc skill install --host <chosen-host>`, using the literal host value
   selected in step 1. Then run `wmtc skill verify --host <chosen-host>`.
9. If either skill command reports an unmanaged, modified, outdated, symlinked,
   or otherwise conflicting destination, stop. Do not delete, move, rename, or
   overwrite the destination. Report the exact path and error and ask the user
   how they want to preserve or resolve it.
10. Restart or reload the agent host if the new skill is not discovered in the
    running session. Do not claim success until verification passes.
11. Report the host, Node version, installed runtime version, compatibility
    result, tarball path, skill destination, install status, verify status, and
    any restart or reload still required.

Do not run `npm publish`, push commits, modify remotes, or perform any other
publication action unless the user gives separate explicit authorization and
the repository's publication workflow is followed.
