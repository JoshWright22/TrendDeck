# Delivery workflow

- After completing and validating requested changes, commit them and push to `origin/main` unless the user explicitly asks otherwise.
- Update the user's installed local TrendDeck desktop app to that same validated code; a source build alone is not a desktop update.
- Never force-push or overwrite unrelated work. Fetch first and resolve non-fast-forward updates safely.
- Preserve brand data, chats, credentials, recordings, and editor projects during desktop updates. Close the app gracefully; do not force-close active recording or unsaved editors.
- Verify the running installed version after updating, and report the pushed commit, desktop version, and any blocked delivery steps.
