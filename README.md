<div align="center">

# ⚡ pi-fast-tree

**Instant session-tree navigator for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_Same `/tree`. Same keys. A slim projection so fat sessions don't freeze the picker._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fast-tree/main/media/cover.svg" alt="pi-fast-tree: a session tree lighting up from a slim scan while the full-payload blob stays dark" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fast-tree?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fast-tree)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fast-tree/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fast-tree/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

Built-in `/tree` freezes on fat sessions because the picker keeps every `SessionEntry` — tool arguments, images, whole assistant bodies — on the nodes it flattens, filters, and searches. pi-fast-tree hijacks `/tree` and paints from a **slim projection**: ids, topology, a 200-character preview, and a precomputed search haystack.

Selecting a node still calls Pi's `navigateTree`. Branch summarization, leaf movement, and the transcript rebuild are unchanged.

## Why this is not pi-fast-resume

| | [pi-fast-resume](https://github.com/monotykamary/pi-fast-resume) | pi-fast-tree |
|---|---|---|
| Command | `/resume` | `/tree` |
| Data | thousands of JSONL files | **one already-loaded session** |
| Win | skip bytes on disk | skip work on in-memory payloads |
| First paint | stream top-N file headers | project the id/parentId skeleton once |

Partial JSONL reads do not help `/tree`. The current session is already parsed. The freeze is CPU: `getTree()` copies every entry, `flattenTree()` stashes every toolCall **including arguments**, and `extractContent` does `extractFullContent(content).slice(0, 200)` on every node, every search keystroke.

## Install

```sh
pi install npm:pi-fast-tree
```

<details>
<summary>Other install methods</summary>

From GitHub:

```sh
pi install git:github.com/monotykamary/pi-fast-tree
```

From a local checkout:

```sh
bun install
pi install /absolute/path/to/pi-fast-tree
```

Then `/reload`.

</details>

Hijack mode is **on by default** — `/tree`, double-escape, and `app.session.tree` open the fast navigator.

## Usage

```
/tree                 Open fast navigator (hijack mode)
/fast-tree            Open fast navigator (only when hijackTree is false)
```

### Picker controls

Identical to built-in `/tree`:

| Key | Action |
|-----|--------|
| ↑ / ↓ | Navigate visible entries |
| ← / → | Page up/down |
| Ctrl+← / Ctrl+→ or Alt+← / Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label |
| Shift+T | Toggle label timestamps |
| Ctrl+X | Copy the selected message |
| Enter | Jump to that point |
| Escape | Cancel (clears search first) |
| Ctrl+O | Cycle filter mode |
| typing | Filter by precomputed preview + label + role |

Filter modes: default, no-tools, user-only, labeled-only, and all. Default comes from `treeFilterMode` in settings.

## Config

All options go in `~/.pi/agent/extensions/pi-fast-tree.json`:

| Key | Type | Default | Description |
| --- | ---- | ------- | ----------- |
| `hijackTree` | `boolean` | `true` | When `true`, `/tree` and `app.session.tree` open the fast navigator. Set `false` to keep built-in `/tree` and register `/fast-tree` as a separate command. |
| `shortcut` | `string` | (none) | Standalone keybinding for the fast navigator. Works regardless of `hijackTree`. Example: `"ctrl+shift+t"`. |

```json
{
  "hijackTree": false,
  "shortcut": "ctrl+shift+t"
}
```

Reload with `/reload` after changing config.

### How hijack works

On load, the extension patches `InteractiveMode.prototype.showTreeSelector`. Built-in `/tree` returns early inside interactive `onSubmit` before extension commands run, so this is the same approach as [pi-fast-resume](https://github.com/monotykamary/pi-fast-resume). On `session_shutdown` the prototype is restored. If `showTreeSelector` is missing, it falls back to the original.

## Known limitations

| Area | Built-in `/tree` | pi-fast-tree | Impact |
| ---- | ---------------- | ------------ | ------ |
| **Search depth** | Matches against extracted message text (still capped at 200 after a full concat) | Matches the **capped preview** + label + role computed once | A token that only appears after the first 200 characters of a message will not match. |
| **Unknown tool args** | `JSON.stringify(args).slice(0, 40)` | Same 40-char snippet, but only from **shallow** scalars (nested objects become `...`) | Custom tool rows still show `[name: {…}]`. Megabyte nested payloads are not stringified. |
| **Abort-during-summary** | Re-opens `/tree` on summarization abort | Cancelled `navigateTree` notifies and returns | Escape-during-summary uses pi's navigation result; the picker does not auto-reopen on abort. |

Copy (`Ctrl+X`) reads the **full** selected entry via `sessionManager.getEntry`, so it is not capped.

## Development

```sh
bun install
bun run check        # typecheck + vitest + knip
```

## License

[MIT](LICENSE).

## Pi 1.0 compatibility (0.1.4)

Tested against Pi **1.0.0** with exact SDK development pins and wildcard host peers.
The live mapped InteractiveMode opens the fast tree and restores its selector hook on shutdown.

Run `bun run test:host` for the offline real-host regression. Set `PI1_HOST_PACKAGE` to an installed Pi package directory and `PI1_HOST_ENTRY=bundle` to test its bundled CLI runtime.

## Pi 0.99 compatibility (0.1.3)

TUI-scoped selector/shortcut patches restore safely in either extension cleanup order. Usage entries stay hidden and context edits have native-compatible labels/search/filtering. Verified native 0.99 methods, loading and UI lifecycle.

Tested with Pi 0.99.0. Host-provided Pi packages are wildcard peers, not bundled dependencies; development uses exact 0.99.0 versions.
