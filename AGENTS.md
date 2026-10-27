# Delivery workflow

- Before editing TrendDeck, review the user's feedback across the locally saved chats in `%APPDATA%/TrendDeck/chats/`, including archived and removed chats. Redact sensitive values before displaying excerpts. Do not commit, upload or publish the user's chat history.

- Before every push to a public repository, run a redacted secret scan of working files and outgoing commits. Stop on findings or scanner failure; never bypass it. Use blank strings for credential examples instead of realistic key-shaped literals.
- This checkout uses `npm run secret:scan` and `.githooks/pre-push`. Gitleaks must be installed; set `GITLEAKS_BIN` when it is not on PATH. Enable the hook with `git config core.hooksPath .githooks` when setting up a new checkout.

- After completing and validating requested changes, commit them and push to `origin/main` unless the user explicitly asks otherwise.
- Update the user's installed local TrendDeck desktop app to that same validated code; a source build alone is not a desktop update.
- Never force-push or overwrite unrelated work. Fetch first and resolve non-fast-forward updates safely.
- Preserve brand data, chats, credentials, recordings, and editor projects during desktop updates. Close the app gracefully; do not force-close active recording or unsaved editors.
- Verify the running installed version after updating, and report the pushed commit, desktop version, and any blocked delivery steps.
- Routine desktop updates should download in-app and be applied by the user's update button. Do not close the running app or launch a separate installer unexpectedly; stage the update and report when it is ready. Runtime changes may still require a clearly disclosed restart.
- Bump the package version for a new desktop release, keeping package.json and package-lock.json consistent. Pushes to main publish that version for the in-app updater.
