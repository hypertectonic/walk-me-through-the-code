# Contributing

Thanks for helping improve Walk Me Through the Code.

Before starting substantial work, open a GitHub issue describing the user
problem and proposed scope. Keep pull requests focused, explain user-visible
behavior, and update public documentation when behavior changes.

## Local validation

Use Node.js `>=24.15.0 <25` and npm `12.0.2`.

```sh
corepack npm ci
corepack npm run lint
corepack npm run typecheck
corepack npm run build
corepack npm run verify:release
corepack npm pack --dry-run --json
```

Do not commit generated package archives, local Viewer state, environment files,
or credentials. Report unrelated failures in the pull request instead of hiding
them.

Maintainers perform the complete release review and make the final publication
decision. A merged contribution does not authorize publishing, tagging, or
creating a release.
