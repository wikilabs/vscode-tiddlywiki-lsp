"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

// Written by the wiki's --lsp in its folder, naming the port it listens on.
const DISCOVERY = path.join(".tw-mcp", "lsp");
const DISCOVERY_GLOB = "**/.tw-mcp/lsp";
const WILDCARD_HOSTS = ["0.0.0.0", "::", ""];
// A server writing its file fires create and change; one reconnect answers both.
const RECONNECT_DELAY_MS = 300;

let client = null;
let target = null;
let reconnectTimer = null;

// The extension connects to a server rather than launching one. The answers
// come from a booted wiki, and that same process is usually already serving
// --mcp and the browser, so starting a second one would only make a copy that
// drifts.
function connect(host, port) {
	return new Promise(function(resolve, reject) {
		const socket = net.connect(port, host);
		socket.once("connect", function() {
			resolve({ reader: socket, writer: socket });
		});
		socket.once("error", reject);
	});
}

// A port written in any settings scope wins over the discovery file.
function configuredPort(config) {
	const inspected = config.inspect("port");
	return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
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
	const config = vscode.workspace.getConfiguration("tiddlywikiLsp"),
		host = config.get("host"),
		port = configuredPort(config);
	if(port !== undefined) {
		return { host: host, port: port, source: "settings", file: null };
	}
	const found = await findDiscovery();
	if(found) {
		return {
			host: WILDCARD_HOSTS.includes(found.data.host) ? host : found.data.host,
			port: found.data.port,
			source: found.file,
			file: found.file
		};
	}
	return { host: host, port: config.get("port"), source: "default port", file: null };
}

function buildClient(chosen) {
	return new LanguageClient(
		"tiddlywikiLsp",
		"TiddlyWiki LSP",
		function() { return connect(chosen.host, chosen.port); },
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
			outputChannelName: "TiddlyWiki LSP"
		}
	);
}

// A wiki that is not running is the ordinary case, not a crash, so it gets a
// message naming the flag to start it with instead of an error popup.
async function start() {
	const chosen = await resolveTarget();
	target = chosen;
	client = buildClient(chosen);
	client.outputChannel.appendLine("Connecting to " + chosen.host + ":" + chosen.port + " (from " + chosen.source + ")");
	return client.start().then(undefined, function(err) {
		client = null;
		vscode.window.showWarningMessage(
			"TiddlyWiki LSP: nothing listening on " + chosen.host + ":" + chosen.port +
			" (from " + chosen.source + "). Start the wiki with --lsp. (" + err.message + ")"
		);
	});
}

function stop() {
	if(!client) {
		return Promise.resolve();
	}
	const running = client;
	client = null;
	return running.stop();
}

// A wiki (re)started with --lsp rewrites its file: follow it when it is the
// wiki this window uses, or when this window has none.
function discoveryChanged(uri) {
	const config = vscode.workspace.getConfiguration("tiddlywikiLsp");
	if(configuredPort(config) !== undefined) {
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
	const watcher = vscode.workspace.createFileSystemWatcher(DISCOVERY_GLOB, false, false, true);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider("tiddlywiki", views),
		vscode.commands.registerCommand("tiddlywikiLsp.reconnect", function() {
			return stop().then(start);
		}),
		watcher,
		watcher.onDidCreate(discoveryChanged),
		watcher.onDidChange(discoveryChanged),
		{ dispose: function() { clearTimeout(reconnectTimer); stop(); } }
	);
	start();
}

function deactivate() {
	return stop();
}

module.exports = { activate: activate, deactivate: deactivate };
