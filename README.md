# TiddlyWiki LSP (VS Code)

Connects VS Code to a running TiddlyWiki `--lsp` server, so `.tid` files get
tiddler title completion, warnings on links that point at nothing, a hover that
explains the filter, macro call or widget under the cursor, and ctrl-click to
the `.tid` file behind a link.

The extension is a thin client: every feature comes from the server.

The answers come from the booted wiki, not from a parser reading the folder.
That is the point: the server knows about shadows, plugin payloads and every
title the wiki actually has.

## Requirements

The wiki needs the `wikilabs/tw-mcp` plugin **0.16.0 or later**, which adds the
`--lsp` command. 0.16.0 is not released yet.

## Start the wiki

```
tiddlywiki ./mywiki --lsp port=6009
```

It composes with `--mcp` in one process, which is the normal way to run it:

```
tiddlywiki ./mywiki --mcp rw listen sse port=8888 --lsp port=6009
```

Socket, not `stdio`: `--mcp` already owns stdin, and the two protocols frame
their messages differently.

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

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `tiddlywikiLsp.host` | `127.0.0.1` | Host the server listens on |
| `tiddlywikiLsp.port` | `6009` | Port given to `--lsp port=<n>` |

`TiddlyWiki LSP: Reconnect to the wiki` in the command palette re-dials after
restarting the wiki. The output channel of the same name carries the protocol log.

## Licence

BSD-3-Clause, see [LICENSE](LICENSE).
