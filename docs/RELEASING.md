# Releasing

This guide is for maintainers preparing a `pi-tmux-agents` release. End users should follow [Updating and rollback](UPDATING.md).

## Compatibility model

Pi runtime packages are peer-provided and must not be bundled into this extension:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

`package.json` keeps these packages in `peerDependencies` with `"*"`, following Pi package requirements. Exact coordinated versions belong in `devDependencies` so CI and local validation are reproducible.

All Pi host packages must move together. Use the `typebox` version required by the selected Pi coding-agent release.

## Prepare Pi compatibility

1. Read the complete upstream [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md) and migration notes.
2. Install the coordinated host versions:

   ```bash
   PI_VERSION=<version>
   TYPEBOX_VERSION="$(npm view "@earendil-works/pi-coding-agent@${PI_VERSION}" dependencies.typebox)"
   npm install --save-dev --save-exact \
     "@earendil-works/pi-ai@${PI_VERSION}" \
     "@earendil-works/pi-coding-agent@${PI_VERSION}" \
     "@earendil-works/pi-tui@${PI_VERSION}" \
     "typebox@${TYPEBOX_VERSION}"
   ```

3. Update the minimum version in `src/services/doctor.ts` and the requirements in `README.md` when compatibility changes.
4. Add tests for any changed Pi RPC, extension, TUI, package, or trust behavior.

Dependabot groups the Pi host packages. The scheduled and manually dispatched `pi-latest` CI job installs the newest coordinated host packages and their exact `typebox` dependency to detect upstream drift. That job is a signal, not a release by itself.

## Prepare the release

Update all release-facing sources together:

- `package.json` and `package-lock.json` version;
- `CHANGELOG.md`, including minimum Pi version and any protocol/configuration break;
- the pinned install command and status in `README.md`;
- documentation affected by behavior or defaults.

Keep the changelog user-focused. Call out required action, state incompatibility, security impact, and rollback constraints explicitly.

## Validation gate

From a clean checkout, run:

```bash
npm ci
npm run validate
npm run tui:fixtures
npm run smoke:runner
npm run smoke:extension
npm run pack:check
npm audit --omit=dev
```

Review the package contents from `npm run pack:check` and inspect the complete diff. Confirm that documentation links resolve and that the install command names the version being released.

## Publish

1. Merge the reviewed release commit to `main`.
2. Create a new annotated, immutable Git tag matching the package version, for example `v0.3.8`.
3. Push the commit and the new tag.
4. Publish GitHub release notes from the matching changelog entry.
5. Install the tag in a clean user environment, run `/agents-doctor`, and exercise a read-only child.

Never move or overwrite a published release tag. If a release is defective, publish a new version and document rollback to the previous known-good tag.

Upstream package behavior is documented in [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
