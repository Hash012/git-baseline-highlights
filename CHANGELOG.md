# Changelog

## 0.4.0

- Add A→B projection onto a later C baseline with strong colors for retained changes and subdued colors for later-evolved changes.

## 0.3.3

- Prepare the `Git Baseline` VS Code extension for the Marketplace under the `git-baseline-marker` extension ID.
- Package the upload artifact with the official `@vscode/vsce package` command.

## 0.3.2

- Use GitHub Actions OIDC with Microsoft Entra ID and `vsce --azure-credential` for Marketplace publishing.
- Run publishing in the protected `marketplace` environment.

## 0.3.1

- Prepare Marketplace publishing under the `Storehouseconsciousness` publisher.
- Add VSIX ignore rules and tag-triggered Marketplace publishing workflow.

## 0.3.0

- Discover nested Git repositories with configurable scan depth.
- Add a repositories and changed-files view with a set-base-for-all command.
- Preserve A/M/D/R change states and changed-folder Explorer markers.
- Detect renames instead of always reducing them to delete plus add.
- Add direct, merge-base and optionally moving configured-baseline modes.

## 0.2.1

- Default to subtle line backgrounds so Git keeps its gutter, overview ruler and Explorer decorations.
- Represent deletion anchors with a pale red background.
- Add independent, opt-in gutter icons, overview ruler marks and Explorer badges.
- Apply display setting changes without reloading and clear obsolete decorations.

## 0.2.0

- Rename the local extension to Git Baseline Highlights.
- Remove project-specific paths, commits and naming.
- Discover Git repositories and select a baseline per repository.
- Resolve command selections to immutable commits.
- Rebind Git metadata watchers when changing repositories.
- Keep read-only file badges, inserted/replaced/deleted line decorations and unsaved-text comparison.
- Add English and Chinese installation guides, MIT licensing, packaging and CI.
