# TiddlyWiki LSP (VS Code)

Gives `.tid` files completion of titles and names, warnings on links that point
at nothing, hovers on filters, operators, calls, widgets and pragma lines, go to
definition, find references, the outline, Ctrl+T, highlighting, folding,
signature help, inlay hints and rename.

Shadow tiddlers and tiddlers without a file of their own open read-only under
the `tiddlywiki:` scheme.

The extension is a thin client: every feature comes from a TiddlyWiki `--lsp`
server, which answers from the booted wiki, not from a parser reading the
folder. It knows about shadows, plugin payloads and every title the wiki
actually has.

## Requirements

The wiki needs the `wikilabs/tw-mcp` and `wikilabs/tw-mcp-core` plugins,
**tw-mcp 0.18.0 or later**. 0.18.0 is not released yet.

## Which wiki

The editor starts the wiki's LSP server itself, as a child of the window, and
stops it when the window closes. It looks for the wiki in this order:

1. A workspace folder whose `tiddlywiki.info` has an `lsp` section:

   ```json
   "lsp": {
   	"autostart": true,
   	"label": "lsp-mcp-server",
   	"command": "node ../scripts/tw.js --core dev"
   }
   ```

   `command` boots the wiki; the folder and `--lsp pipe=<name>` are appended.
   Without it, `tiddlywiki` is used. When several folders qualify, the one that
   includes another wins, so a `-server` edition is chosen over the edition it
   includes.

2. The `tiddlywiki.lsp.wiki` setting, for a wiki whose `tiddlywiki.info` is not
   yours to change, for example in a `.code-workspace` file:

   ```json
   "settings": {
   	"tiddlywiki.lsp.wiki": "${workspaceFolder}/editions/tw5.com-server",
   	"tiddlywiki.lsp.command": "tiddlywiki +plugins/wikilabs/tw-mcp-core +plugins/wikilabs/tw-mcp",
   	"tiddlywiki.lsp.label": "lsp-tw5.com-server"
   }
   ```

3. A wiki already running with `--lsp`, found through the `.tw-mcp/lsp` file it
   writes, or the `tiddlywiki.lsp.port` setting:

   ```
   tiddlywiki ./mywiki --mcp rw listen sse port=8888 --lsp
   ```

The first two run a command from the workspace, so they only happen in a
trusted workspace.

## A wiki of its own

The LSP server the editor starts holds its own copy of the wiki, so a running
MCP server can stop and start without taking the editor features down. The two
keep in step:

- Tiddler files the MCP server writes, for MCP tools and browser edits, are read
  in as they change on disk.
- A `.tid` saved in the editor is reloaded into the running MCP server too, so
  the browser and MCP tools see it.
- Hovers link shadow tiddlers to the MCP server's browser port.

Each side logs the other by label: the `TiddlyWiki LSP` output shows
`MCP server found: PID n @sse-primary, browser on port 8888`, and the MCP
server's console and `get_wiki_info` list the LSP server with its label.

## Status bar

The status bar names the LSP server this window uses, for example
`lsp-tw5.com-server`, and the MCP server it is linked to, as in
`lsp-mcp-server ⇄ sse-primary`. A spinner means the wiki is still booting, a
warning that it is not running. The tooltip gives the wiki folder, where it was
configured and the MCP server's browser port; a click opens the log.

## Preview in TiddlyWiki

While the linked MCP server serves a browser, right-click a `.tid` tab and pick
`TiddlyWiki LSP: Preview in TiddlyWiki`. The running wiki opens in a preview
panel beside the editor, on that tiddler, taken from the file's `title` field.
Previewing another tiddler reuses the panel without reloading the wiki. It shows
the saved text, and a save shows up there without a refresh.

## List undefined calls and widgets

`TiddlyWiki LSP: List undefined calls and widgets` in the command palette reads
every `.tid` file of the wiki and opens the Problems panel with the calls and
widget tags whose name nothing in the wiki defines, as information, each with
its quick fix. Links to missing tiddlers are not listed: a wiki links to
tiddlers it has yet to write, so they are warned about only in an open file.
Once listed, the entries stay while you open and close their files, so an
undefined name shows a blue squiggle instead of the grey dots until the window
reloads.

## Language ids

Binds to `tid` (`.tid`, `.meta`) and `tiddlywiki5` (`.tw`, `.tw5`), the ids the
[tw5-syntax](https://marketplace.visualstudio.com/items?itemName=joshua-fontany.tw5-syntax)
extension registers. Declaring the same ids rather than a new one keeps the two
extensions describing one document instead of fighting over the file type, and
leaves syntax highlighting and bracket behaviour to tw5-syntax.

## Install the extension

```
npm install
```

Then either:

- open this folder in VS Code and press <kbd>F5</kbd> for an Extension Development Host, or
- copy the folder (including `node_modules`) into `%USERPROFILE%\.vscode\extensions\` and reload the window.

After updating an installed copy, reload the window. When `package.json`
changed, first run

```
node scripts/clear-extension-cache.js
```

VS Code caches the manifests of installed extensions and refreshes that cache
only for its own installs, so the next window would start with the old
commands, settings and activation events, then ask for another reload.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `tiddlywiki.lsp.wiki` | | Wiki folder to start when no `tiddlywiki.info` has an `lsp` section: absolute, `${workspaceFolder}/...`, `${workspaceFolder:<name>}/...`, or relative to the first workspace folder |
| `tiddlywiki.lsp.command` | `tiddlywiki` | Command that boots `tiddlywiki.lsp.wiki` |
| `tiddlywiki.lsp.label` | `lsp-<wiki folder name>` | Label of that LSP server in both logs |
| `tiddlywiki.lsp.host` | `127.0.0.1` | Host of a wiki already running with `--lsp` |
| `tiddlywiki.lsp.port` | `6009` | Port of a wiki already running with `--lsp`; set, it wins over everything above |

`TiddlyWiki LSP: Reconnect to the wiki` (`tiddlywiki.lsp.reconnect`) in the
command palette starts or dials the wiki again. `TiddlyWiki LSP: Show the log`
(`tiddlywiki.lsp.showOutput`) opens the `TiddlyWiki LSP` output channel, which
carries the wiki's own log and the protocol log.

## Licence

BSD-3-Clause, see [LICENSE](LICENSE).
