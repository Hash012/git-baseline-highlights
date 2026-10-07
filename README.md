# Git Baseline Highlights

[中文使用说明](README.zh-CN.md)

A VS Code extension that highlights files and lines changed since a Git commit you choose. Keep your normal Source Control view while seeing the cumulative changes from a fixed baseline.

- **Pale green background:** new files and pure inserted lines.
- **Pale orange background:** changed files and replacement blocks.
- **Pale red background:** the location of deleted text.
- Compare unsaved editor contents, not just files on disk.
- Choose a different baseline without checking out a commit or changing Git history.
- Use local or remote Git workspaces; repository discovery is automatic.

## Install

1. Search for `Storehouseconsciousness.git-baseline-highlights` in the VS Code Extensions view after the Marketplace release is available.
2. Until the first Marketplace release, download the `.vsix` attachment from the [latest release](https://github.com/Hash012/git-baseline-highlights/releases/latest) and run **Extensions: Install from VSIX…**.
3. Reload the VS Code window, then open a trusted Git workspace.
4. Run **Git Baseline Highlights: Select Baseline**. Enter a commit hash, tag or branch.

The selection resolves to a full commit hash and is remembered for that repository. Moving a branch later does not move a baseline chosen with this command. No baseline is selected automatically on first use.

The Marketplace identifier is `Storehouseconsciousness.git-baseline-highlights`. The repository also distributes source and VSIX packages for local or pre-release installation.

## Use

| Command | Purpose |
| --- | --- |
| **Git Baseline Highlights: Select Baseline** | Choose a comparison commit for the current repository. |
| **Git Baseline Highlights: Toggle Highlights** | Show or hide the decorations. |
| **Git Baseline Highlights: Refresh Highlights** | Recalculate file and line changes. |
| **Git Baseline Highlights: Show Legend** | Explain the colors and limits. |
| **Git Baseline Highlights: Set Base for All Repositories** | Pin one baseline in every discovered repository. |

The status bar shows the selected baseline. Hover over decorations for their meaning. When several Git repositories are open, each discovered repository keeps its own baseline and visible editors are decorated according to their repository; the status bar follows the active editor.

The Git Baseline Highlights view lists discovered repositories and their changed files. Select a repository in the view to choose its baseline, or use the title command to set one baseline in every repository. Nested repositories are discovered up to three directory levels by default; configure `gitBaselineHighlights.scanDepth` to change that.

Changes to visible, unsaved text are compared after a short debounce. Saves, file operations, window focus and Git metadata changes refresh file badges. Manual refresh is available when an external change does not emit an event.

## Coexist with Git decorations

By default, baseline changes use only subtle whole-line backgrounds. Git keeps its existing gutter indicators, overview ruler and Explorer status badges. Read cumulative baseline changes from the background and uncommitted Git changes from the usual Git indicators.

A line added and committed after the baseline retains a green background without an uncommitted Git indicator. Editing it again can display both. Hover over the background for its baseline meaning. Deletions use a red background on a neighboring existing line; an empty document has no line to mark.

These optional settings default to `false`. Enabling them may overlap Git or other extensions:

- `gitBaselineHighlights.showGutterIcons`: colored gutter diamonds.
- `gitBaselineHighlights.showOverviewRuler`: overview ruler marks.
- `gitBaselineHighlights.showFileBadges`: Explorer A/M/D/R badges and changed-folder markers.

Settings take effect automatically without reloading. Keep the defaults for the coexistence layout.

## Configuration

Defaults work without adding a project configuration file. If needed, set these in **User Settings** to keep project files untouched:

- `gitBaselineHighlights.repository`: optional repository directory; leave empty for automatic detection.
- `gitBaselineHighlights.base`: optional baseline override; leave empty to use the per-repository selection.
- `gitBaselineHighlights.comparisonMode`: `direct` compares to the selected commit; `mergeBase` compares to the common ancestor of the selected ref and `HEAD`, which is useful for PR-style review.
- `gitBaselineHighlights.followBase`: re-resolve a configured branch or tag on every refresh; disabled by default to preserve fixed-commit semantics.
- `gitBaselineHighlights.scanDepth`: nested Git repository discovery depth, defaulting to 3.

Changing the configured baseline expression resolves and saves it once. It stays fixed across refreshes unless `followBase` is enabled. A later command selection replaces the saved baseline without changing settings; changing the configuration expression again resolves a new baseline.

## What stays unchanged

The extension reads Git data and draws editor decorations. It does not write source files, stage changes, switch branches, create commits, alter Git configuration or write workspace settings. Selections and toggles use VS Code's extension workspace storage. Each discovered repository stores its baseline independently.

Temporary text comparisons use the operating system's temporary directory and are removed after comparison. An abruptly terminated process can leave a temporary directory behind.

## Limits

- Ignored files do not become new-file highlights merely because they are opened. Tracked files remain eligible even if an ignore rule matches them.
- NUL-containing binary data, files over 2 MiB and documents over 100,000 lines skip line highlighting.
- Replacement blocks are orange as a whole; this is line-level highlighting, not character-level attribution.
- Renames appear as an R status in the changes view; the old path is retained as a deleted status for decoration purposes.
- Deleted text is represented by an anchor on a neighboring current line, not recreated in the document.
- Special encodings or line-ending conversions can appear as broad replacement blocks.
- Optional Explorer badges can interact with other decoration providers; the Git Source Control view remains available.
- Git must be installed. VS Code 1.85 or later is required. Linux is locally verified; CI is configured to exercise Linux, macOS and Windows.

## Develop and package

Runtime code has no npm dependencies. Node.js 22 or later is recommended for development, and packaging uses Python 3's standard library.

```bash
npm test
python scripts/package_extension.py
```

For a local publish, set `VSCE_PAT` in your environment and run `npm run publish`. For the recommended release path, push a matching `v*.*.*` tag: GitHub Actions runs tests and `npx @vscode/vsce publish --oidc`. Before the first tag, configure a Marketplace Trusted Publishing policy for this repository and workflow, and keep the `Storehouseconsciousness` publisher account selected. OIDC avoids storing a long-lived PAT in GitHub.

The package is written to `dist/`. For a development session, open this folder in VS Code and run:

```bash
code --extensionDevelopmentPath="$(pwd)"
```

Tests create independent temporary Git repositories. They cover line changes, unusual filenames, ignored files, invalid baselines, unsaved text, repository selection, stale asynchronous results and Git index preservation.

## License

[MIT](LICENSE). Contributions and bug reports are welcome through this repository's issues and pull requests.
