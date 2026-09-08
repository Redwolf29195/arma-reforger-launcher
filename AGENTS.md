# Arma Reforger Launcher project instructions

## Open-source scope

- This repository is the public GPL-3.0-only source project. Publishing reviewed source is an intended project workflow.
- Preserve GPL notices and author credits. Third-party components retain their own terms; update `THIRD_PARTY_NOTICES.md` when they change.
- Keep application and Workshop bridge source readable. Ordinary development and packaging must work without the owner's private signing key.
- Keep work within the launcher project. Ordinary builds and tests must not modify a user's installed game, server, mods, presets or profiles. Use temporary fixtures and mocked game interfaces.

## Validation and packaging

- Install the pinned dependency graph with `pnpm install --frozen-lockfile`.
- Run `pnpm test` for code changes and the relevant Electron UI smoke checks for UI changes.
- Use `pnpm run pack` or `pnpm run dist:win` for community builds. Preparation uses `scripts/prepare-build.js` and `.build/app`.
- Keep IPC validation, navigation restrictions, Electron hardening and downloaded-update authentication. These protect users and do not restrict access to source or ordinary builds.
- Keep generated output, dependencies, caches, logs, previews, credentials, user data and backups out of public source commits and archives. Review the actual publication file list and scan it for secrets; `.gitignore` alone is insufficient.

## Official releases

- Source repository: `Redwolf29195/arma-reforger-launcher`. Official binary update repository: `Redwolf29195/arma-reforger-launcher-updates`.
- After the version change and validation, use `pnpm run release:win:public-unsigned` for an official Windows release. This pipeline signs update artifacts with the owner's existing Ed25519 key; community packaging does not require that key.
- Re-audit an existing official build with `pnpm run release:audit:public-unsigned`. Do not manually assemble or edit signed release metadata when the automated pipeline is available.
- Never commit, log or publish private keys or credentials. Never generate a replacement for the existing official release key as a build repair. The public verification key may be distributed.
- Set the update policy through `package.json` `algzUpdatePolicy`; do not edit its signed representation in `latest.yml` by hand.
- Publish within the user's authorized scope. Existing authorization applies; do not add a repeated confirmation requirement.
- Publish the exact corresponding source and build instructions for the same version as the binaries. Provide a clear source link alongside binary downloads and preserve access while distributing them.
- Upload only verified artifacts reported by the release pipeline to the binary update repository. Publish reviewed source through the source repository; never upload an entire local project directory.
- After publication, verify public asset names, sizes and hashes, `latest.yml`, and artifact signatures before reporting success. Send an update notification only when explicitly authorized by the user.

See `RELEASE-PROCESS.md` for commands and release-channel details.
