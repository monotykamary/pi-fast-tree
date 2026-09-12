<div align="center">

# ⚡ pi-fast-tree

**Instant session tree navigator for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Projects each entry down to ids, topology, and a 200-character preview — no full payload walks._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

> Built-in `/tree` freezes on fat sessions because the picker keeps every `SessionEntry` — tool arguments, images, whole assistant bodies — on the nodes it flattens, filters, and searches.
> pi-fast-tree's hijacked `/tree` paints from a **slim projection** instead.

Same navigator UI and keybindings as `/tree`. The difference is the picker never materializes full message content to draw a row or match a keystroke. Search and labels run against a precomputed haystack. Copy still reads the real entry, and Enter still calls pi's `navigateTree`.

```
──────────────────────────────────────────────────────────

  Session Tree
  ↑/↓ move · ←/→ page · Ctrl+←/→ branch · Ctrl+X copy · Shift+L label
  Type to search: oauth_

› • user: Fix the auth bypass in middleware
    └─ assistant: Here's the patch…
       ├─ user: Let's try approach A
       └─ user: Actually, approach B          ← active

  (4/128)

──────────────────────────────────────────────────────────
```

## Why this is not pi-fast-resume

| | [pi-fast-resume](https://github.com/monotykamary/pi-fast-resume) | pi-fast-tree |
|---|---|---|
| Command | `/resume` | `/tree` |
| Data | thousands of JSONL files | **one already-loaded session** |
| Win | skip bytes on disk | skip work on in-memory payloads |
| First paint | stream top-N file headers | project the id/parentId skeleton once |

Partial JSONL reads do not help `/tree`. The current session is already parsed. The freeze is CPU: `getTree()` copies every entry, `flattenTree()` stashes every toolCall **including arguments**, and `extractContent` does `extractFullContent(content).slice(0, 200)` on every node, every search keystroke.

## Install

**With `pi install`** (recommended):

```bash
pi install npm:pi-fast-tree
```

Or install from GitHub:

```bash
pi install https://github.com/monotykamary/pi-fast-tree
```

**Local development** — add the extension path directly:

```json
{
  "extensions": ["./path/to/pi-fast-tree/fast-tree.ts"]
}
```

Reload with `/reload` after any install method.

## Usage

Hijack mode is **on by default** — `/tree`, double-escape, and `app.session.tree` open the fast navigator.

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

Filter modes: default, no-tools, user-only, labeled-only, all. Default comes from `treeFilterMode` in settings.

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

On load, the extension patches `InteractiveMode.prototype.showTreeSelector`. Built-in `/tree` returns early inside interactive `onSubmit` before extension commands run, so this is the same approach as pi-fast-resume. On `session_shutdown` the prototype is restored. If `showTreeSelector` is missing, it falls back to the original.

Selecting a node still calls `ctx.navigateTree()` — branch summarization, leaf movement, and transcript rebuild are pi's, not a reimplementation.

## Known limitations

| Area | Built-in `/tree` | pi-fast-tree | Impact |
| ---- | ---------------- | ------------ | ------ |
| **Search depth** | Matches against extracted message text (still capped at 200 after a full concat) | Matches the **capped preview** + label + role computed once | A token that only appears after the first 200 characters of a message will not match. |
| **Unknown tool args** | `JSON.stringify(args).slice(0, 40)` | Shows `[name]` or a single known string field (`path` / `command` / `pattern`) | Custom tools with no path-like field show the name only. Avoids walking megabyte argument blobs. |
| **Abort-during-summary** | Re-opens `/tree` on summarization abort | Cancelled `navigateTree` notifies and returns | Escape-during-summary uses pi's navigation result; the picker does not auto-reopen on abort. |

Copy (`Ctrl+X`) reads the **full** selected entry via `sessionManager.getEntry`, so it is not capped.

## License

[MIT](./LICENSE)
