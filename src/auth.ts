import { Cursor } from "@cursor/sdk";
import { spawn } from "node:child_process";
import { getDefaultCursorAgentCommand } from "./cursor-agent-command.js";
import { getCursorApiKey, shouldUseCursorSdk } from "./cursor-sdk-config.js";
import { stripAnsi } from "./utils.js";

type Environment = Record<string, string | undefined>;

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CommandRunner {
	run(args: string[], options?: { cwd?: string; env?: Environment }): Promise<CommandResult>;
}

export class AgentCommandRunner implements CommandRunner {
	constructor(private readonly command: string = getDefaultCursorAgentCommand()) {}

	async run(
		args: string[],
		options?: { cwd?: string; env?: Environment },
	): Promise<CommandResult> {
		return await new Promise<CommandResult>((resolve, reject) => {
			const child = spawn(this.command, args, {
				cwd: options?.cwd,
				env: options?.env ?? process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			child.on("error", reject);
			child.on("close", (code) => {
				resolve({
					code: code ?? 1,
					stdout,
					stderr,
				});
			});
		});
	}
}

export type ParsedAuthStatus =
	| { loggedIn: true; account: string; raw: string }
	| { loggedIn: false; raw: string };

export function parseAuthStatus(output: string): ParsedAuthStatus {
	const clean = stripAnsi(output);
	const normalized = clean.replace(/\r/g, "\n");
	const loggedInMatch = normalized.match(/Logged in as\s+([^\n]+)/i);
	if (loggedInMatch) {
		return {
			loggedIn: true,
			account: loggedInMatch[1].trim(),
			raw: clean,
		};
	}

	if (/Not logged in/i.test(normalized)) {
		return {
			loggedIn: false,
			raw: clean,
		};
	}

	// Conservative fallback: treat unknown status as not logged in.
	return {
		loggedIn: false,
		raw: clean,
	};
}

export interface CursorAuthClient {
	status(): Promise<ParsedAuthStatus>;
	login(): Promise<CommandResult>;
	logout(): Promise<CommandResult>;
	ensureLoggedIn(): Promise<ParsedAuthStatus>;
}

export class CursorSdkAuth implements CursorAuthClient {
	constructor(private readonly apiKey: string = getCursorApiKey()) {}

	async status(): Promise<ParsedAuthStatus> {
		try {
			const user = await Cursor.me({ apiKey: this.apiKey });
			const account =
				user.userEmail?.trim() ||
				[user.userFirstName, user.userLastName].filter(Boolean).join(" ").trim() ||
				user.apiKeyName;
			return {
				loggedIn: true,
				account,
				raw: JSON.stringify(user),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				loggedIn: false,
				raw: message,
			};
		}
	}

	async login(): Promise<CommandResult> {
		return {
			code: 0,
			stdout: "Already authenticated via CURSOR_API_KEY. Set the key from Cursor Dashboard → Integrations.",
			stderr: "",
		};
	}

	async logout(): Promise<CommandResult> {
		return {
			code: 0,
			stdout: "SDK auth uses CURSOR_API_KEY; unset that variable to sign out.",
			stderr: "",
		};
	}

	async ensureLoggedIn(): Promise<ParsedAuthStatus> {
		const current = await this.status();
		if (current.loggedIn) {
			return current;
		}
		throw new Error(
			"CURSOR_API_KEY is missing or invalid. Create a key at https://cursor.com/dashboard/integrations",
		);
	}
}

export class CursorAuth implements CursorAuthClient {
	constructor(private readonly runner: CommandRunner = new AgentCommandRunner()) {}

	async status(): Promise<ParsedAuthStatus> {
		const result = await this.runner.run(["status"]);
		return parseAuthStatus(`${result.stdout}\n${result.stderr}`);
	}

	async login(): Promise<CommandResult> {
		return await this.runner.run(["login"]);
	}

	async logout(): Promise<CommandResult> {
		return await this.runner.run(["logout"]);
	}

	async ensureLoggedIn(): Promise<ParsedAuthStatus> {
		const current = await this.status();
		if (current.loggedIn) {
			return current;
		}

		await this.login();
		return await this.status();
	}
}

export function createCursorAuth(): CursorAuthClient {
	if (shouldUseCursorSdk()) {
		return new CursorSdkAuth();
	}
	return new CursorAuth();
}
