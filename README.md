# Git Baseline Highlights

[中文使用说明](README.zh-CN.md)

A VS Code extension that highlights files and lines changed since a Git commit you choose. Keep your normal Source Control view while seeing the cumulative changes from a fixed baseline.

- **Green / N:** new files and pure inserted lines.
- **Orange / M:** changed files and replacement blocks.
- **Red diamond:** the location of deleted text.
- Compare unsaved editor contents, not just files on disk.
- Choose a different baseline without checking out a commit or changing Git history.
- Use local or remote Git workspaces; repository discovery is automatic.

## Install

1. Download the `.vsix` attachment from the [latest release](https://github.com/Hash012/git-baseline-highlights/releases/latest).
2. In VS Code, run **Extensions: Install from VSIX…** and choose the file.
3. Reload the VS Code window, then open a trusted Git workspace.
4. Run **Git Baseline Highlights: Select Baseline**. Enter a commit hash, tag or branch.

The selection resolves to a full commit hash and is remembered for that repository. Moving a branch later does not move a baseline chosen with this command. No baseline is selected automatically on first use.

This repository distributes source and a VSIX package. It is not a listing in the VS Code Marketplace.

## Use

| Command | Purpose |
| --- | --- |
| **Git Baseline Highlights: Select Baseline** | Choose a comparison commit for the current repository. |
| **Git Baseline Highlights: Toggle Highlights** | Show or hide the decorations. |
| **Git Baseline Highlights: Refresh Highlights** | Recalculate file and line changes. |
| **Git Baseline Highlights: Show Legend** | Explain the colors and limits. |

The status bar shows the selected baseline. Hover over decorations for their meaning. When several Git repositories are open, highlighting follows the active editor's repository; it does not decorate every repository simultaneously.

Changes to visible, unsaved text are compared after a short debounce. Saves, file operations, window focus and Git metadata changes refresh file badges. Manual refresh is available when an external change does not emit an event.

## Configuration

Defaults work without adding a project configuration file. If needed, set these in **User Settings** to keep project files untouched:

- `gitBaselineHighlights.repository`: optional repository directory; leave empty for automatic detection.
- `gitBaselineHighlights.base`: optional baseline override; leave empty to use the per-repository selection.

Changing the configured baseline expression resolves and saves it once. It stays fixed across refreshes. A later command selection replaces the saved baseline without changing settings; changing the configuration expression again resolves a new baseline.

## What stays unchanged

The extension reads Git data and draws editor decorations. It does not write source files, stage changes, switch branches, create commits, alter Git configuration or write workspace settings. Selections and toggles use VS Code's extension workspace storage.

Temporary text comparisons use the operating system's temporary directory and are removed after comparison. An abruptly terminated process can leave a temporary directory behind.

## Limits

- Ignored files do not become new-file highlights merely because they are opened. Tracked files remain eligible even if an ignore rule matches them.
- NUL-containing binary data, files over 2 MiB and documents over 100,000 lines skip line highlighting.
- Replacement blocks are orange as a whole; this is line-level highlighting, not character-level attribution.
- Renames appear as deletion of the old path and addition of the new path.
- Deleted text is represented by an anchor on a neighboring current line, not recreated in the document.
- Special encodings or line-ending conversions can appear as broad replacement blocks.
- Explorer badges can interact with other decoration providers; the Git Source Control view remains available.
- Git must be installed. VS Code 1.85 or later is required. Linux is locally verified; CI is configured to exercise Linux, macOS and Windows.

## Develop and package

Runtime code has no npm dependencies. Node.js 22 or later is recommended for development, and packaging uses Python 3's standard library.

```bash
npm test
python scripts/package_extension.py
```

The package is written to `dist/`. For a development session, open this folder in VS Code and run:

```bash
code --extensionDevelopmentPath="$(pwd)"
```

Tests create independent temporary Git repositories. They cover line changes, unusual filenames, ignored files, invalid baselines, unsaved text, repository selection, stale asynchronous results and Git index preservation.

## License

[MIT](LICENSE). Contributions and bug reports are welcome through this repository's issues and pull requests.
