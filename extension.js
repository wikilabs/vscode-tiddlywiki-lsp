"use strict";

const net = require("net");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client = null;

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

function buildClient() {
	const config = vscode.workspace.getConfiguration("tiddlywikiLsp");
	const host = config.get("host");
	const port = config.get("port");
	const created = new LanguageClient(
		"tiddlywikiLsp",
		"TiddlyWiki LSP",
		function() { return connect(host, port); },
		{
			// The language ids are the ones the tw5-syntax extension already
			// registers, so both extensions describe the same document rather
			// than competing for the .tid file type.
			documentSelector: [
				{ scheme: "file", language: "tid" },
				{ scheme: "file", language: "tiddlywiki5" }
			],
			outputChannelName: "TiddlyWiki LSP"
		}
	);
	return { client: created, host: host, port: port };
}

// A wiki that is not running is the ordinary case, not a crash, so it gets a
// message naming the flag to start it with instead of an error popup.
function start() {
	const built = buildClient();
	client = built.client;
	return client.start().then(undefined, function(err) {
		client = null;
		vscode.window.showWarningMessage(
			"TiddlyWiki LSP: nothing listening on " + built.host + ":" + built.port +
			". Start the wiki with --lsp port=" + built.port + ". (" + err.message + ")"
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

function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("tiddlywikiLsp.reconnect", function() {
			return stop().then(start);
		}),
		{ dispose: function() { stop(); } }
	);
	start();
}

function deactivate() {
	return stop();
}

module.exports = { activate: activate, deactivate: deactivate };
