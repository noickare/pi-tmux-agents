# Safe updates

Pi and `pi-tmux-agents` are updated separately on purpose. Production installs should use a reviewed extension tag so a Pi self-update cannot also move extension code.

## Update an installed environment

1. Record the working versions and package pin:

   ```bash
   pi --version
   pi list
   ```

2. Review the [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md), then update Pi by itself:

   ```bash
   pi update --self
   pi --version
   ```

3. Start Pi normally and run `/agents-doctor`. Do not move the extension pin until a compatible `pi-tmux-agents` release is available.

4. Move to that reviewed tag explicitly and restart Pi:

   ```bash
   pi install git:github.com/noickare/pi-tmux-agents@v<verified-version>
   ```

5. Run `/agents-doctor` again and exercise one read-only child before starting mutating work.

A pinned Git source is not advanced by `pi update --extensions` or `pi update --all`; those commands only reconcile its checkout to the configured ref. Move a pinned package with `pi install ...@<new-ref>`. Unpinned npm and Git packages do advance during package updates, which is less suitable when controlled rollout and simple rollback matter.

To roll back the extension, restore the previous known-good tag and restart Pi:

```bash
pi install git:github.com/noickare/pi-tmux-agents@v<previous-version>
```

Use `pi -ne` if a newly updated extension prevents normal startup, then restore the previous pin. Existing tmux-agent durable state is not migrated across incompatible protocol versions; check the release notes before moving between protocol generations.

## Prepare a compatible release

The repository keeps Pi runtime packages in `peerDependencies` with `"*"`, as required for Pi packages, and pins exact coordinated versions in `devDependencies` for reproducible compatibility checks. Never bundle a private copy of Pi core packages or `typebox`.

For a new Pi release:

1. Read its complete changelog and migration notes.
2. Update all host packages together, using the `typebox` version required by that Pi release:

   ```bash
   PI_VERSION=<version>
   TYPEBOX_VERSION="$(npm view "@earendil-works/pi-coding-agent@${PI_VERSION}" dependencies.typebox)"
   npm install --save-dev --save-exact \
     "@earendil-works/pi-ai@${PI_VERSION}" \
     "@earendil-works/pi-coding-agent@${PI_VERSION}" \
     "@earendil-works/pi-tui@${PI_VERSION}" \
     "typebox@${TYPEBOX_VERSION}"
   ```

3. Update the minimum checked by `src/services/doctor.ts`, the requirements in `README.md`, the package version, and `CHANGELOG.md`.
4. Run the full compatibility gate:

   ```bash
   npm ci
   npm run validate
   npm run smoke:runner
   npm run smoke:extension
   npm run pack:check
   npm audit --omit=dev
   ```

5. Review the diff, publish a new immutable Git tag, and only then instruct users to move their pin.

Dependabot groups the three Pi host packages into one pull request. The weekly and manually dispatched `pi-latest` CI job also installs the latest coordinated Pi packages plus Pi's exact `typebox` dependency and runs the full validation/smoke gate. These checks detect compatibility drift but never update an installed user's pinned extension automatically.

Upstream package behavior and peer-dependency guidance are documented in [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
