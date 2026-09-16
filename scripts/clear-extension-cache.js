"use strict";

// Deletes VS Code's cached scan of installed extensions, which it refreshes only
// when it installs or removes one itself, so the next window reads this package.json.
// Usage: node scripts/clear-extension-cache.js [user data folder, e.g. "%APPDATA%\Code - Insiders"]

const fs = require("fs");
const os = require("os");
const path = require("path");

const CACHE_FILE = "extensions.user.cache";

function defaultUserDataFolder() {
	if(process.platform === "win32") {
		return path.join(process.env.APPDATA, "Code");
	}
	if(process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support", "Code");
	}
	return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code");
}

// Every profile keeps its own cache.
const profiles = path.join(process.argv[2] || defaultUserDataFolder(), "CachedProfilesData");
const caches = fs.existsSync(profiles) ? fs.readdirSync(profiles).map((profile) => path.join(profiles, profile, CACHE_FILE)).filter((file) => fs.existsSync(file)) : [];

caches.forEach((file) => {
	fs.rmSync(file);
	console.log("Deleted " + file);
});
if(!caches.length) {
	console.log("No cached extension scan in " + profiles);
}
