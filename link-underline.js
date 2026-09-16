"use strict";

// A dotted underline over the solid one tw5-syntax gives link text, which no theme can restyle
// (bead tw-mcp-server-17e.36); a link to a missing tiddler keeps only the LSP's squiggle.

const vscode = require("vscode");

const LANGUAGES = ["tid", "tiddlywiki5"];
// What tw5-syntax scopes markup.underline.link: a [[pretty]], [ext[ or [img[ link's target
// (group 1), an external URL, a $:/ system link and a CamelCase link.
const LINKS = [
	/\[(?:ext|img)?\[(?:[^|\]]*\|)?\s*([^\]]*?[^\s\]])\s*\]\]/dg,
	/~?(?:file|http|https|mailto|ftp|irc|news|data|skype):[^\s<>{}[\]`|'"\\^]+(?:\/|\b)/dg,
	/~?\$:\/[\w/.-]+/dg,
	/~?(?<![a-zA-Zß-öø-ÿőűÀ-ÖØ-ÞŐŰ_-])[A-ZÀ-ÖØ-ÞŐŰ]+[a-zß-öø-ÿőű]+[A-ZÀ-ÖØ-ÞŐŰ][a-zA-Zß-öø-ÿőűÀ-ÖØ-ÞŐŰ]*/dg
];
// Text the grammar reads as something other than prose: code, comments, tags, macro calls, transclusions.
const NOT_PROSE = /```[\s\S]*?```|`[^`\n]*`|<!--[\s\S]*?-->|<<[\s\S]*?>>|<[^>\n]*>|\{\{\{[\s\S]*?\}\}\}|\{\{[^}\n]*\}\}/g;
const MISSING_LINK = "No tiddler titled ";
const REFRESH_DELAY_MS = 150;
// CSS spaces a dotted underline by its thickness, so the dots are a background: one pixel every DOT_SPACING_PX.
// VS Code copies textDecoration into its stylesheet unchecked, which is what lets the value carry these properties.
const DOT_SPACING_PX = 3;
const DOTS = "none; background-image: linear-gradient(to right, currentColor 1px, transparent 1px); background-size: " +
	DOT_SPACING_PX + "px 1px; background-repeat: repeat-x; background-position: left bottom";

let dotted = null;
let bare = null;
const pending = new Map();

// The offsets of link text in the body of a .tid file, outside code, comments and tags. As in the
// grammar, an earlier kind of link claims its whole text, so a CamelCase label inside [ext[...]] is none.
function linkOffsets(text) {
	const blank = /^(?:[^\s:]+:.*\r?\n)+\r?\n/.exec(text),
		bodyStart = blank && blank.index === 0 ? blank[0].length : 0,
		claimed = [],
		found = [];
	let match;
	NOT_PROSE.lastIndex = 0;
	while((match = NOT_PROSE.exec(text)) !== null) {
		claimed.push([match.index, match.index + match[0].length]);
	}
	LINKS.forEach(function(pattern) {
		const matched = [];
		pattern.lastIndex = bodyStart;
		while((match = pattern.exec(text)) !== null) {
			const whole = match.indices[0];
			if(!claimed.some(function(range) { return whole[0] < range[1] && whole[1] > range[0]; })) {
				matched.push(whole);
				found.push(match.indices[1] || whole);
			}
		}
		claimed.push.apply(claimed, matched);
	});
	return found;
}

function decorate(editor) {
	const document = editor.document;
	if(!LANGUAGES.includes(document.languageId)) {
		return;
	}
	const missing = vscode.languages.getDiagnostics(document.uri).filter(function(diagnostic) {
			return diagnostic.source === "tiddlywiki" && diagnostic.message.startsWith(MISSING_LINK);
		}).map(function(diagnostic) {
			return diagnostic.range;
		}),
		dottedRanges = [],
		bareRanges = [];
	linkOffsets(document.getText()).forEach(function(where) {
		const range = new vscode.Range(document.positionAt(where[0]), document.positionAt(where[1])),
			isMissing = missing.some(function(warned) {
				const overlap = warned.intersection(range);
				return overlap && !overlap.isEmpty;
			});
		(isMissing ? bareRanges : dottedRanges).push(range);
	});
	editor.setDecorations(dotted, dottedRanges);
	editor.setDecorations(bare, bareRanges);
}

// Typing and the squiggles that follow it come in bursts, so each document is redrawn once they settle.
function refresh(uri) {
	const key = uri.toString();
	clearTimeout(pending.get(key));
	pending.set(key, setTimeout(function() {
		pending.delete(key);
		vscode.window.visibleTextEditors.forEach(function(editor) {
			if(editor.document.uri.toString() === key) {
				decorate(editor);
			}
		});
	}, REFRESH_DELAY_MS));
}

function activate(context) {
	dotted = vscode.window.createTextEditorDecorationType({ textDecoration: DOTS });
	bare = vscode.window.createTextEditorDecorationType({ textDecoration: "none" });
	context.subscriptions.push(
		dotted,
		bare,
		vscode.window.onDidChangeVisibleTextEditors(function(editors) {
			editors.forEach(decorate);
		}),
		vscode.workspace.onDidChangeTextDocument(function(event) {
			refresh(event.document.uri);
		}),
		vscode.languages.onDidChangeDiagnostics(function(event) {
			event.uris.forEach(refresh);
		}),
		{ dispose: function() { pending.forEach(clearTimeout); pending.clear(); } }
	);
	vscode.window.visibleTextEditors.forEach(decorate);
}

module.exports = { activate, linkOffsets };
