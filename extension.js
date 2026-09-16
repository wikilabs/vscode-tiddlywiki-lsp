"use strict";

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient, State, createClientPipeTransport, generateRandomPipeName } = require("vscode-languageclient/node");

// Written by the wiki's --lsp in its folder, naming the port it listens on.
const DISCOVERY = path.join(".tw-mcp", "lsp");
const DISCOVERY_GLOB = "**/.tw-mcp/lsp";
const WIKI_INFO = "tiddlywiki.info";
const DEFAULT_COMMAND = "tiddlywiki";
const WILDCARD_HOSTS = ["0.0.0.0", "::", ""];
// A server writing its file fires create and change; one reconnect answers both.
const RECONNECT_DELAY_MS = 300;

let client = null;
let target = null;
let reconnectTimer = null;
let output = null;
// The pipe to the wiki this window started, closed when a start fails so the process ends.
let launched = null;
let statusItem = null;
// The MCP server the wiki's LSP process says it is linked to, or null.
let mcpServer = null;
let previewPanel = null;
let previewPort = null;
// Set when the window closes or reloads, before the log channel is disposed.
let deactivated = false;

const STATUS_ICONS = { none: "$(circle-slash)", starting: "$(sync~spin)", running: "$(book)", stopped: "$(warning)" };
const STATUS_WORDS = { none: "no wiki", starting: "starting", running: "running", stopped: "not running" };

// A wiki started elsewhere with --lsp is reached over its socket.
function connect(host, port) {
	return new Promise(function(resolve, reject) {
		const socket = net.connect(port, host);
		socket.once("connect", function() {
			resolve({ reader: socket, writer: socket });
		});
		socket.once("error", reject);
	});
}

// Only a shell finds a command such as tiddlywiki.cmd on Windows, so arguments are quoted for it.
function quoteArg(arg) {
	if(/^[\w\-.:\\/=@+]+$/.test(arg)) {
		return arg;
	}
	return process.platform === "win32" ? '"' + arg + '"' : "'" + arg.replace(/'/g, "'\\''") + "'";
}

// The wiki process can still print or end after a reload has closed the log.
function logFromChild(level, message) {
	if(!deactivated) {
		output[level](message);
	}
}

// Each line the wiki prints becomes one log entry, without TiddlyWiki's terminal colours.
function logLines(stream) {
	let pending = "";
	stream.on("data", function(chunk) {
		const lines = (pending + chunk.toString()).split(/\r?\n/);
		pending = lines.pop();
		lines.forEach(function(line) {
			logFromChild("info", line.replace(/\x1b\[[0-9;]*m/g, ""));
		});
	});
	stream.on("end", function() {
		if(pending) {
			logFromChild("info", pending.replace(/\x1b\[[0-9;]*m/g, ""));
		}
	});
}

// The wiki runs as this window's child: it connects back over a pipe, so its own
// console output cannot corrupt the protocol, and it ends when the pipe closes.
function launch(wiki) {
	return async function() {
		const pipeName = generateRandomPipeName(),
			transport = await createClientPipeTransport(pipeName),
			commandLine = wiki.command + " " + quoteArg(wiki.path) + " --lsp " + quoteArg("pipe=" + pipeName) + (wiki.label ? " " + quoteArg("label=" + wiki.label) : "");
		output.info("Starting " + wiki.path + (wiki.label ? " @" + wiki.label : "") + ": " + commandLine);
		const child = childProcess.spawn(commandLine, { cwd: wiki.path, shell: true, windowsHide: true });
		logLines(child.stdout);
		logLines(child.stderr);
		let connected = false;
		const failed = new Promise(function(resolve, reject) {
			child.once("error", function(err) {
				logFromChild("error", "The wiki process failed: " + err.message);
				if(!connected) {
					reject(err);
				}
			});
			child.once("exit", function(code) {
				logFromChild(code === 0 ? "info" : "warn", "The wiki process ended (exit code " + code + ")");
				if(!connected) {
					reject(new Error("the wiki process ended with exit code " + code + " before it connected"));
				}
			});
		});
		const transports = await Promise.race([transport.onConnected(), failed]);
		connected = true;
		launched = transports;
		return { reader: transports[0], writer: transports[1] };
	};
}

// A port written in any settings scope wins over the discovery file.
function configuredPort(config) {
	const inspected = config.inspect("port");
	return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
}

// A workspace folder whose tiddlywiki.info asks the editor to start its LSP process.
function readAutostart(folder) {
	const file = path.join(folder.uri.fsPath, WIKI_INFO);
	if(folder.uri.scheme !== "file" || !fs.existsSync(file)) {
		return null;
	}
	let info;
	try {
		info = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch(err) {
		if(!(err instanceof SyntaxError)) {
			throw err;
		}
		output.info("Skipping " + file + ": " + err.message);
		return null;
	}
	if(!info.lsp || info.lsp.autostart !== true) {
		return null;
	}
	const wikiPath = folder.uri.fsPath;
	return {
		path: wikiPath,
		command: info.lsp.command || DEFAULT_COMMAND,
		label: info.lsp.label || defaultLabel(wikiPath),
		includes: (info.includeWikis || []).map(function(entry) {
			return path.resolve(wikiPath, typeof entry === "string" ? entry : entry.path);
		})
	};
}

// A -server edition includes the edition it serves, and it is the one meant to run.
function autostartWiki() {
	const wikis = (vscode.workspace.workspaceFolders || []).map(readAutostart).filter(Boolean);
	return wikis.find(function(wiki) {
		return wikis.some(function(other) { return wiki.includes.includes(other.path); });
	}) || wikis[0] || null;
}

// For a wiki whose tiddlywiki.info is not yours to change, the workspace settings name it instead.
function settingsWiki(config) {
	const setting = config.get("wiki");
	if(!setting) {
		return null;
	}
	const folders = vscode.workspace.workspaceFolders || [],
		firstFolder = folders[0] ? folders[0].uri.fsPath : null;
	// ${workspaceFolder} as in tasks.json, ${workspaceFolder:<name>} for a folder of a multi-root workspace.
	const wiki = setting.replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, function(match, name) {
		const folder = name ? folders.find(function(candidate) { return candidate.name === name; }) : folders[0];
		return folder ? folder.uri.fsPath : match;
	});
	if(wiki.includes("${") || (!firstFolder && !path.isAbsolute(wiki))) {
		output.warn("Cannot resolve tiddlywiki.lsp.wiki: " + setting);
		return null;
	}
	const wikiPath = path.resolve(firstFolder || "", wiki);
	return {
		path: wikiPath,
		command: config.get("command") || DEFAULT_COMMAND,
		label: config.get("label") || defaultLabel(wikiPath),
		includes: []
	};
}

// The server names itself the same way when no label is given.
function defaultLabel(wikiPath) {
	return "lsp-" + path.basename(wikiPath);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch(err) {
		if(err.code === "ESRCH") {
			return false;
		}
		if(err.code === "EPERM") {
			return true;
		}
		throw err;
	}
}

// Returns the file's data when a running server wrote it, else null.
function readDiscovery(file) {
	if(!fs.existsSync(file)) {
		return null;
	}
	const raw = fs.readFileSync(file, "utf8");
	if(!raw.trim()) {
		return null;
	}
	const data = JSON.parse(raw);
	return data.port && data.pid && isAlive(data.pid) ? data : null;
}

// The file nearest a document names the wiki that files it.
function discoveryAbove(filePath) {
	let dir = path.dirname(filePath);
	for(;;) {
		const file = path.join(dir, DISCOVERY),
			data = readDiscovery(file);
		if(data) {
			return { file: file, data: data };
		}
		const parent = path.dirname(dir);
		if(parent === dir) {
			return null;
		}
		dir = parent;
	}
}

async function findDiscovery() {
	const editor = vscode.window.activeTextEditor,
		documents = (editor ? [editor.document] : []).concat(vscode.workspace.textDocuments);
	for(const document of documents) {
		if(document.uri.scheme === "file") {
			const found = discoveryAbove(document.uri.fsPath);
			if(found) {
				return found;
			}
		}
	}
	// Otherwise the first wiki in workspace folder order.
	const uris = await vscode.workspace.findFiles(DISCOVERY_GLOB, "**/node_modules/**", 50);
	uris.sort(function(a, b) {
		const folderA = vscode.workspace.getWorkspaceFolder(a),
			folderB = vscode.workspace.getWorkspaceFolder(b);
		return ((folderA ? folderA.index : 0) - (folderB ? folderB.index : 0)) || a.fsPath.localeCompare(b.fsPath);
	});
	for(const uri of uris) {
		const data = readDiscovery(uri.fsPath);
		if(data) {
			return { file: uri.fsPath, data: data };
		}
	}
	return null;
}

async function resolveTarget() {
	const config = vscode.workspace.getConfiguration("tiddlywiki.lsp"),
		host = config.get("host"),
		port = configuredPort(config);
	if(port !== undefined) {
		return { host: host, port: port, source: "settings", file: null };
	}
	// The command comes from a file in the workspace, so only a trusted workspace may run it.
	const infoWiki = vscode.workspace.isTrusted ? autostartWiki() : null;
	if(infoWiki) {
		return { wiki: infoWiki, source: path.join(infoWiki.path, WIKI_INFO), file: null };
	}
	const configuredWiki = vscode.workspace.isTrusted ? settingsWiki(config) : null;
	if(configuredWiki) {
		return { wiki: configuredWiki, source: "settings", file: null };
	}
	const found = await findDiscovery();
	if(found) {
		return {
			host: WILDCARD_HOSTS.includes(found.data.host) ? host : found.data.host,
			port: found.data.port,
			label: found.data.label || null,
			source: found.file,
			file: found.file
		};
	}
	return null;
}

function buildClient(chosen) {
	return new LanguageClient(
		"tiddlywiki.lsp",
		"TiddlyWiki LSP",
		chosen.wiki ? launch(chosen.wiki) : function() { return connect(chosen.host, chosen.port); },
		{
			// The language ids are the ones the tw5-syntax extension already
			// registers, so both extensions describe the same document rather
			// than competing for the .tid file type.
			documentSelector: [
				{ scheme: "file", language: "tid" },
				{ scheme: "file", language: "tiddlywiki5" },
				// The server's read-only views; a view of JavaScript is left alone.
				{ scheme: "tiddlywiki", language: "tid" }
			],
			outputChannel: output
		}
	);
}

// The footer names the LSP server this window uses and, once linked, its MCP server.
function showStatus(state, problem) {
	const label = !target ? null : target.wiki ? target.wiki.label : (target.label || target.host + ":" + target.port),
		linked = state === "running" && mcpServer,
		tooltip = new vscode.MarkdownString();
	statusItem.text = STATUS_ICONS[state] + " " + (label || "TiddlyWiki LSP") +
		(linked ? " $(arrow-swap) " + (mcpServer.label || "MCP PID " + mcpServer.pid) : "");
	tooltip.appendMarkdown("**TiddlyWiki LSP**: ");
	tooltip.appendText(STATUS_WORDS[state] + (label ? " @" + label : ""));
	if(target) {
		tooltip.appendMarkdown("\n\n");
		tooltip.appendText(target.wiki ? "Wiki " + target.wiki.path + " (from " + target.source + ")" : "Connected to " + target.host + ":" + target.port + " (from " + target.source + ")");
	}
	if(state === "running") {
		tooltip.appendMarkdown("\n\n");
		tooltip.appendText(mcpServer ? "MCP server PID " + mcpServer.pid + (mcpServer.label ? " @" + mcpServer.label : "") + (mcpServer.browserPort ? ", browser on port " + mcpServer.browserPort : ", no browser") : "No MCP server linked");
	}
	if(problem) {
		tooltip.appendMarkdown("\n\n");
		tooltip.appendText(problem);
	}
	tooltip.appendMarkdown("\n\n_Click to show the log_");
	statusItem.tooltip = tooltip;
	statusItem.backgroundColor = state === "stopped" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
	statusItem.show();
}

// A workspace without a wiki is the ordinary case, not a crash: it gets a log
// line saying how to name one, and a wiki started later with --lsp is followed.
async function start() {
	const chosen = await resolveTarget();
	target = chosen;
	setMcpServer(null);
	if(!chosen) {
		output.info("No wiki to start or connect to. Add an lsp section to the wiki's tiddlywiki.info, set tiddlywiki.lsp.wiki, or start the wiki with --lsp.");
		showStatus("none");
		return;
	}
	client = buildClient(chosen);
	const started = client;
	started.onDidChangeState(function(event) {
		if(client === started) {
			showStatus(event.newState === State.Running ? "running" : event.newState === State.Starting ? "starting" : "stopped");
		}
	});
	started.onNotification("tiddlywiki/mcpServer", function(params) {
		if(client !== started) {
			return;
		}
		setMcpServer(params.server);
		if(started.isRunning()) {
			showStatus("running");
		}
	});
	showStatus("starting");
	if(!chosen.wiki) {
		output.info("Connecting to " + chosen.host + ":" + chosen.port + (chosen.label ? " @" + chosen.label : "") + " (from " + chosen.source + ")");
	}
	return client.start().then(undefined, function(err) {
		client = null;
		if(launched) {
			launched[1].dispose();
			launched = null;
		}
		output.error(err.message);
		showStatus("stopped", err.message);
		vscode.window.showWarningMessage(chosen.wiki ?
			"TiddlyWiki LSP: could not start the wiki in " + chosen.wiki.path + " (" + err.message + "). The TiddlyWiki LSP output shows its log." :
			"TiddlyWiki LSP: nothing listening on " + chosen.host + ":" + chosen.port +
			" (from " + chosen.source + "). Start the wiki with --lsp. (" + err.message + ")"
		);
	});
}

function stop() {
	setMcpServer(null);
	if(!client) {
		return Promise.resolve();
	}
	const running = client;
	client = null;
	return running.stop();
}

// The preview menu shows only while a linked MCP server serves a browser.
function setMcpServer(server) {
	mcpServer = server;
	vscode.commands.executeCommand("setContext", "tiddlywiki.lsp.browser", !!(server && server.browserPort));
}

// A .tid file names its tiddler in the title field of its header, which ends at the first blank line.
function titleOf(text) {
	for(const line of text.split(/\r?\n/)) {
		if(!line.trim()) {
			return null;
		}
		const match = /^title:\s*(.*)$/.exec(line);
		if(match) {
			return match[1].trim() || null;
		}
	}
	return null;
}

// Opens the tiddler of a .tid file in the running wiki, beside the editor.
async function previewInWiki(uri) {
	const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
	if(!target) {
		return;
	}
	const port = mcpServer && mcpServer.browserPort;
	if(!port) {
		vscode.window.showWarningMessage("TiddlyWiki LSP: no MCP server with a browser is linked to this wiki. Start the wiki server, for example with npm start.");
		return;
	}
	const document = await vscode.workspace.openTextDocument(target),
		title = titleOf(document.getText());
	if(!title) {
		vscode.window.showWarningMessage("TiddlyWiki LSP: " + path.basename(target.fsPath) + " has no title field.");
		return;
	}
	const address = "http://127.0.0.1:" + port + "/#" + encodeURIComponent(title);
	output.info("Preview " + title + " at " + address);
	if(!previewPanel) {
		previewPanel = vscode.window.createWebviewPanel("tiddlywiki.lsp.preview", "Preview", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
		previewPanel.onDidDispose(function() {
			previewPanel = null;
			previewPort = null;
		});
	}
	previewPanel.title = "Preview " + title;
	// Another tiddler of the same wiki only moves the fragment, so the wiki does not boot again.
	if(previewPort === port) {
		previewPanel.webview.postMessage({ address: address });
		previewPanel.reveal(previewPanel.viewColumn, true);
	} else {
		previewPort = port;
		previewPanel.webview.html = previewHtml(address, port);
	}
}

// The running wiki in a frame that fills the panel; the page script moves the frame when asked.
function previewHtml(address, port) {
	const nonce = crypto.randomBytes(16).toString("base64");
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${port}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }
</style>
</head>
<body>
<iframe id="wiki" src="${address}"></iframe>
<script nonce="${nonce}">
	const frame = document.getElementById("wiki");
	window.addEventListener("message", (event) => {
		if(event.data && event.data.address) {
			frame.src = event.data.address;
		}
	});
</script>
</body>
</html>`;
}

// A wiki (re)started with --lsp rewrites its file: follow it when it is the
// wiki this window uses, or when this window has none. A wiki this window
// started itself is not replaced by one running elsewhere.
function discoveryChanged(uri) {
	const config = vscode.workspace.getConfiguration("tiddlywiki.lsp");
	if(configuredPort(config) !== undefined || (target && target.wiki)) {
		return;
	}
	const connected = !!(client && client.isRunning());
	if(connected && target && target.file !== uri.fsPath) {
		return;
	}
	const data = readDiscovery(uri.fsPath);
	if(!data || (connected && target.port === data.port)) {
		return;
	}
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(function() {
		stop().then(start);
	}, RECONNECT_DELAY_MS);
}

// A shadow, a module or a tiddler packed into a .json file has no file to open,
// so the editor shows the wiki's own text of it, read-only, under this scheme.
const views = {
	provideTextDocumentContent: function(uri) {
		if(!client) {
			return "TiddlyWiki LSP is not connected, so this tiddler cannot be shown.";
		}
		return client.sendRequest("tiddlywiki/tiddler", { uri: uri.toString() }).then(function(result) {
			return result.text;
		});
	}
};

function activate(context) {
	// A log channel: the language client writes to it with error() and info().
	output = vscode.window.createOutputChannel("TiddlyWiki LSP", { log: true });
	statusItem = vscode.window.createStatusBarItem("tiddlywiki.lsp.status", vscode.StatusBarAlignment.Right, 100);
	statusItem.name = "TiddlyWiki LSP";
	statusItem.command = "tiddlywiki.lsp.showOutput";
	const watcher = vscode.workspace.createFileSystemWatcher(DISCOVERY_GLOB, false, false, true);
	context.subscriptions.push(
		output,
		statusItem,
		vscode.commands.registerCommand("tiddlywiki.lsp.showOutput", function() {
			output.show(true);
		}),
		vscode.commands.registerCommand("tiddlywiki.lsp.preview", previewInWiki),
		vscode.workspace.registerTextDocumentContentProvider("tiddlywiki", views),
		vscode.commands.registerCommand("tiddlywiki.lsp.reconnect", function() {
			return stop().then(start);
		}),
		watcher,
		watcher.onDidCreate(discoveryChanged),
		watcher.onDidChange(discoveryChanged),
		vscode.workspace.onDidGrantWorkspaceTrust(function() {
			return stop().then(start);
		}),
		vscode.workspace.onDidChangeConfiguration(function(event) {
			if(event.affectsConfiguration("tiddlywiki.lsp")) {
				return stop().then(start);
			}
		}),
		{ dispose: function() { deactivated = true; clearTimeout(reconnectTimer); stop(); } }
	);
	start();
}

function deactivate() {
	deactivated = true;
	return stop();
}

module.exports = { activate: activate, deactivate: deactivate };
