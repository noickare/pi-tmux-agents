# Updating and rollback

Pi and `pi-tmux-agents` are updated separately on purpose. Keep the extension pinned to a reviewed tag so a Pi self-update cannot also change extension code.

## Before updating

1. Let active children settle, review their results, and preserve any dirty worktrees.
2. Record the working Pi version and installed package source:

   ```bash
   pi --version
   pi list
   ```

3. Read this project's [changelog](../CHANGELOG.md) for minimum Pi versions, protocol changes, and required user action.
4. Read the [Pi changelog](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md).

Durable state is not migrated between incompatible protocol generations. Finish or archive important work before crossing a documented protocol boundary.

## Update Pi first

Update Pi independently:

```bash
pi update --self
pi --version
```

Start Pi with the currently pinned extension and run:

```text
/agents-doctor
```

Do not move the extension pin until a compatible `pi-tmux-agents` release is available. Compatibility requirements are recorded in each release's changelog entry and the README requirements table.

## Update the extension

Move to a reviewed release tag explicitly, then restart Pi:

```bash
pi install git:github.com/noickare/pi-tmux-agents@v<version>
```

Run `/agents-doctor` again. Before starting mutating work, create one read-only child and confirm that it starts, returns a result, and reaches parent review.

Pinned Git refs do not advance during `pi update --extensions` or `pi update --all`. Those commands reconcile the checkout to the configured ref. Moving a pinned package requires another `pi install ...@<new-ref>` command. This behavior makes rollout and rollback explicit.

## Roll back

Install the previous known-good tag and restart Pi:

```bash
pi install git:github.com/noickare/pi-tmux-agents@v<previous-version>
```

If the updated extension prevents normal startup, start Pi without extensions:

```bash
pi -ne
```

Then restore the previous pin or fix the configuration error. Do not delete durable state or worktrees as a first troubleshooting step.

## Maintainers

The compatibility and publication procedure is documented separately in [Releasing](RELEASING.md).
