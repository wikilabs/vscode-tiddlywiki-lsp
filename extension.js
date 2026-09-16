"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient, createClientPipeTransport, generateRandomPipeName } = require("vscode-languageclient/node");

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

// Each line the wiki prints becomes one log entry, without TiddlyWiki's terminal colours.
function logLines(stream) {
	let pending = "";
	stream.on("data", function(chunk) {
		const lines = (pending + chunk.toString()).split(/\r?\n/);
		pending = lines.pop();
		lines.forEach(function(line) {
			output.info(line.replace(/\x1b\[[0-9;]*m/g, ""));
		});
	});
	stream.on("end", function() {
		if(pending) {
			output.info(pending.replace(/\x1b\[[0-9;]*m/g, ""));
		}
	});
}

// The wiki runs as this window's child: it connects back over a pipe, so its own
// console output cannot corrupt the protocol, and it ends when the pipe closes.
function launch(wiki) {
	return async function() {
		const pipeName = generateRandomPipeName(),
			transport = await createClientPipeTransport(pipeName),
			commandLine = wiki.command + " " + quoteArg(wiki.path) + " --lsp " + quoteArg("pipe=" + pipeName);
		output.info("Starting " + wiki.path + (wiki.label ? " @" + wiki.label : "") + ": " + commandLine);
		const child = childProcess.spawn(commandLine, { cwd: wiki.path, shell: true, windowsHide: true });
		logLines(child.stdout);
		logLines(child.stderr);
		let connected = false;
		const failed = new Promise(function(resolve, reject) {
			child.once("error", function(err) {
				output.error("The wiki process failed: " + err.message);
				if(!connected) {
					reject(err);
				}
			});
			child.once("exit", function(code) {
				(code === 0 ? output.info : output.warn).call(output, "The wiki process ended (exit code " + code + ")");
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
		label: info.lsp.label || null,
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
	// The command comes from a file in the workspace, so only a trusted workspace may run it.
	const wiki = vscode.workspace.isTrusted ? autostartWiki() : null;
	if(wiki) {
		return { wiki: wiki, source: path.join(wiki.path, WIKI_INFO), file: null };
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
	return { host: host, port: config.get("port"), source: "default port", file: null };
}

function buildClient(chosen) {
	return new LanguageClient(
		"tiddlywikiLsp",
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

// A wiki that is not running is the ordinary case, not a crash, so it gets a
// message naming the flag to start it with instead of an error popup.
async function start() {
	const chosen = await resolveTarget();
	target = chosen;
	client = buildClient(chosen);
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
		vscode.window.showWarningMessage(chosen.wiki ?
			"TiddlyWiki LSP: could not start the wiki in " + chosen.wiki.path + " (" + err.message + "). The TiddlyWiki LSP output shows its log." :
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
// wiki this window uses, or when this window has none. A wiki this window
// started itself is not replaced by one running elsewhere.
function discoveryChanged(uri) {
	const config = vscode.workspace.getConfiguration("tiddlywikiLsp");
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
	const watcher = vscode.workspace.createFileSystemWatcher(DISCOVERY_GLOB, false, false, true);
	context.subscriptions.push(
		output,
		vscode.workspace.registerTextDocumentContentProvider("tiddlywiki", views),
		vscode.commands.registerCommand("tiddlywikiLsp.reconnect", function() {
			return stop().then(start);
		}),
		watcher,
		watcher.onDidCreate(discoveryChanged),
		watcher.onDidChange(discoveryChanged),
		vscode.workspace.onDidGrantWorkspaceTrust(function() {
			return stop().then(start);
		}),
		{ dispose: function() { clearTimeout(reconnectTimer); stop(); } }
	);
	start();
}

function deactivate() {
	return stop();
}

module.exports = { activate: activate, deactivate: deactivate };
