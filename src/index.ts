#!/usr/bin/env node

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
	console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { runAcp } from "./run-acp.js";
import { CursorAuth } from "./auth.js";
import { resolvePermissionModeSetting } from "./settings.js";

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === "login") {
		const result = await new CursorAuth().login();
		if (result.stdout) process.stderr.write(`${result.stdout}\n`);
		return;
	}
	if (command === "logout") {
		const result = await new CursorAuth().logout();
		if (result.stdout) process.stderr.write(`${result.stdout}\n`);
		if (result.stderr) process.stderr.write(`${result.stderr}\n`);
		return;
	}

	runAcp(resolvePermissionModeSetting(process.argv.slice(2)));
	process.stdin.resume();
}

void main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
