# Build and release process

The GPL source is maintained in [`Redwolf29195/arma-reforger-launcher`](https://github.com/Redwolf29195/arma-reforger-launcher). Official Windows and Linux downloads remain in [`Redwolf29195/arma-reforger-launcher-updates`](https://github.com/Redwolf29195/arma-reforger-launcher-updates).

Открытые исходники и официальные файлы обновлений находятся в разных репозиториях, указанных выше. Обычная сборка не требует ключа владельца. Закрытый ключ используется только владельцем для подписи файлов официального канала обновлений.

## Build from source

Requirements: Node.js 22+ and pnpm 11+. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run pack
```

For Windows Setup and Portable packages:

```sh
pnpm run dist:win
```

`scripts/prepare-build.js` copies readable application source, license notices and the included Workshop bridge into `.build/app`. It does not obfuscate code or require a private release key. Output directories are configured in `package.json`.

On Linux, `pnpm run dist:linux` builds separate x64 DEB and AppImage packages. The Linux workflow validates Ubuntu 22.04 and 24.04, including source tests, Electron UI checks, the installed DEB and the extracted AppImage payload with sandboxing enabled. It does not test a mounted AppImage or start Arma Reforger; Steam/Proton and real game compatibility require separate validation. The macOS target remains unvalidated.

For UI changes, also run the relevant Electron smoke checks with isolated fixtures:

```sh
node node_modules/electron/cli.js tests/uiSmoke.js
node node_modules/electron/cli.js tests/serverUiSmoke.js
```

Community builds can be modified and redistributed under GPL-3.0-only. Retain the license, notices and access to corresponding source. Describe your changes and distribution origin accurately; source availability does not grant ownership of third-party trademarks or the official project's signing credentials.

## Official Windows update channel

The maintainer uses the existing Ed25519 key through `ALGZ_RELEASE_PRIVATE_KEY_FILE` or the signing tool's configured owner-local location. Never include that key in source, build archives, logs or GitHub assets, and never generate a replacement as a routine build fix. The public verification key is part of the source.

```sh
pnpm run release:win:public-unsigned
```

This runs the release validation and packaging pipeline and signs official update artifacts. `public-unsigned` means that the Windows executable has no Authenticode publisher signature; the separate ALGZ update signature remains required for the official update channel. Signing authenticates downloads and is independent of the GPL license and the ability to build modified source.

To re-audit existing artifacts without rebuilding:

```sh
pnpm run release:audit:public-unsigned
```

Set `algzUpdatePolicy` in `package.json` before building: `optional` with zero grace, `semi-forced` with a grace period of 60–3600 seconds, or `forced` with zero configured grace. Do not manually edit signed update-policy values in `latest.yml`.

## Combined Windows and Linux release

Build Windows with the pipeline above. Obtain the Linux artifacts from the successful Ubuntu 22.04 workflow for the same application source; use Ubuntu 24.04 as an additional compatibility check. Put exactly the versioned `linux-x64.deb` and `linux-x64.AppImage` files in a separate directory, then run:

```sh
node scripts/release-public-unsigned.js --reuse-build --linux-directory /path/to/linux-packages
```

This verifies the existing five Windows files before adding the two Linux packages. The final release has seven assets. Keep `latest.yml`, the blockmap and ALGZ signature associated with the Windows Setup; Linux uses manual updates and must never run the Windows updater. After publication, check the complete release with:

```sh
node scripts/verify-public-release.js --with-linux
```

Для общего выпуска сначала соберите и проверьте Windows. Добавляйте DEB и AppImage из успешной проверки Linux для того же исходного кода. Команда выше сохраняет проверенные Windows-файлы и добавляет два Linux-пакета; существующие версии и данные пользователей не заменяются.

## Publish a version

1. Update the version and finish the source changes. Run the appropriate tests and release pipeline; do not substitute a manually assembled artifact folder.
2. Review the exact source file list and scan it for secrets. Include source, bridge resources, required build scripts, pinned dependency manifests, license texts and build instructions. Exclude generated output, dependencies, caches, logs, previews, user data, private keys and backups.
3. Tag the source version used to produce the binaries in the public source repository. Publish that version's corresponding source at no additional charge, with a clear source link alongside binary downloads. Preserve source access for as long as the binaries are distributed.
4. Within the user's publication authorization, upload only the verified release artifacts reported by the pipeline to the official binary update repository. Source releases belong in the source repository.
5. Verify the public asset list, byte sizes and hashes against local audited artifacts. Verify public `latest.yml`, the installer blockmap and the `.algz.json` artifact signature. Report publication only after those checks succeed.

Sending an update notification is a separate external-message action requiring the user's explicit authorization. Existing authorization need not be requested again. See [GNU GPL source-distribution guidance](https://www.gnu.org/licenses/gpl-faq.html#SourceAndBinaryOnDifferentSites) and the full [license](LICENSE).
