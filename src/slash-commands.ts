import { AvailableCommand } from "@agentclientprotocol/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CursorAuthClient } from "./auth.js";
import { resolveModelId } from "./model-id.js";
import {
	ADVERTISED_MODE_IDS,
	modeDisplayName,
	normalizeModeId,
	SessionModeId,
} from "./settings.js";
import { CustomSkill, resolveSkillPrompt } from "./skills.js";

export interface ModelParameterOption {
	value: string;
	displayName?: string;
}

export interface ModelParameterDescriptor {
	id: string;
	displayName?: string;
	values: ModelParameterOption[];
}

export interface ModelVariantDescriptor {
	modelId?: string;
	params: Array<{ id: string; value: string }>;
	isDefault?: boolean;
}

export interface CursorModelDescriptor {
	modelId: string;
	name: string;
	current?: boolean;
	parameters?: ModelParameterDescriptor[];
	variants?: ModelVariantDescriptor[];
}

export interface SlashSessionState {
	modelId?: string;
	modeId: SessionModeId;
}

export interface CustomSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
	template: string;
	sourcePath: string;
}

interface CommandRoot {
	root: string;
}

export interface SlashCommandContext {
	session: SlashSessionState;
	auth: CursorAuthClient;
	listModels: () => Promise<CursorModelDescriptor[]>;
	availableCommands?: AvailableCommand[];
	onModeChanged?: (modeId: SessionModeId) => Promise<void>;
	onModelChanged?: (modelId: string) => Promise<void>;
}

export interface SlashCommandResult {
	handled: boolean;
	responseText?: string;
}

const BUILTIN_SLASH_COMMANDS: AvailableCommand[] = [
	{ name: "help", description: "Show adapter slash commands", input: null },
	{
		name: "model",
		description: "Get or set active model",
		input: { hint: "<model-id>" },
	},
	{
		name: "mode",
		description: "Get or set active mode",
		input: { hint: "<mode-id>" },
	},
	{ name: "login", description: "Sign in to the Cursor SDK", input: null },
	{ name: "logout", description: "Sign out of the Cursor SDK", input: null },
	{ name: "status", description: "Show login status", input: null },
];

const NATIVE_PASSTHROUGH_SLASH_COMMANDS: AvailableCommand[] = [
	{
		name: "copy-request-id",
		description: "Copy the last request ID to clipboard",
		input: null,
	},
	{
		name: "simplify",
		description:
			"Find low-info comments, one-off helpers, perf issues, and reuse opportunities",
		input: null,
	},
	{
		name: "worktree",
		description: "Create a detached-head git worktree",
		input: { hint: "[branch=<name>]" },
	},
	{
		name: "apply-worktree",
		description: "Apply detached worktree changes back into the main worktree",
		input: null,
	},
	{
		name: "delete-worktree",
		description: "Delete a detached-head git worktree",
		input: null,
	},
	{
		name: "best-of-n",
		description: "Fan out one task across multiple models and compare results",
		input: { hint: "<models> <task>" },
	},
];

export function normalizeSlashCommandName(commandName: string): string {
	const trimmed = commandName.trim().replace(/^\/+/, "");
	const withoutMcpSuffix = trimmed.replace(/\s+\(MCP\)$/i, "");
	return withoutMcpSuffix.replace(/^mcp:/i, "");
}

export function availableSlashCommands(extraCommands: AvailableCommand[] = []): AvailableCommand[] {
	return mergeAvailableSlashCommands(extraCommands);
}

export function mergeAvailableSlashCommands(
	extraCommands: AvailableCommand[] = [],
	customCommands: CustomSlashCommand[] = [],
	skills: CustomSkill[] = [],
): AvailableCommand[] {
	const deduped = new Map<string, AvailableCommand>();
	for (const command of extraCommands) {
		deduped.set(normalizeSlashCommandName(command.name).toLowerCase(), command);
	}

	for (const command of customCommands) {
		const key = normalizeSlashCommandName(command.name).toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, {
				name: command.name,
				description: command.description,
				input: command.argumentHint ? { hint: command.argumentHint } : null,
			});
		}
	}

	for (const skill of skills) {
		const key = normalizeSlashCommandName(skill.name).toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, {
				name: skill.name,
				description: `${skill.description} (${skill.origin} skill)`,
				input: null,
			});
		}
	}

	for (const command of NATIVE_PASSTHROUGH_SLASH_COMMANDS) {
		const key = normalizeSlashCommandName(command.name).toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, command);
		}
	}

	for (const command of BUILTIN_SLASH_COMMANDS) {
		const key = normalizeSlashCommandName(command.name).toLowerCase();
		if (!deduped.has(key)) {
			deduped.set(key, command);
		}
	}

	return [...deduped.values()];
}

function formatSlashCommand(command: AvailableCommand): string {
	const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
	return command.input?.hint ? `${name} ${command.input.hint}` : name;
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: string }).code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));

	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectMarkdownFiles(fullPath)));
			continue;
		}

		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			files.push(fullPath);
		}
	}

	return files;
}

function parseFrontmatter(markdown: string): {
	metadata: Record<string, string>;
	body: string;
} {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { metadata: {}, body: markdown };
	}

	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i]?.trim() === "---") {
			end = i;
			break;
		}
	}

	if (end === -1) {
		return { metadata: {}, body: markdown };
	}

	const metadata: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const delimiter = line.indexOf(":");
		if (delimiter <= 0) {
			continue;
		}
		const key = line.slice(0, delimiter).trim().toLowerCase();
		const value = line.slice(delimiter + 1).trim();
		if (key && value) {
			metadata[key] = value;
		}
	}

	return {
		metadata,
		body: lines.slice(end + 1).join("\n"),
	};
}

function firstHeading(markdown: string): string | undefined {
	const match = markdown.match(/^\s*#\s+(.+)$/m);
	if (!match?.[1]) {
		return undefined;
	}
	const heading = match[1].trim();
	return heading.length > 0 ? heading : undefined;
}

function commandNameFromPath(filePath: string, root: string): string {
	const relative = path.relative(root, filePath);
	const parsed = path.parse(relative);
	const withoutExtension = path.join(parsed.dir, parsed.name);
	return withoutExtension
		.split(path.sep)
		.filter((part) => part.length > 0)
		.join("/");
}

async function readCustomCommand(
	filePath: string,
	root: string,
): Promise<CustomSlashCommand | null> {
	const name = commandNameFromPath(filePath, root).trim();
	if (!name) {
		return null;
	}

	const raw = await fs.readFile(filePath, "utf8");
	const { metadata, body } = parseFrontmatter(raw);
	const template = body.trim();
	if (!template) {
		return null;
	}

	const argumentHint = (
		metadata["argument-hint"] ??
		metadata["arguments"] ??
		metadata["input-hint"] ??
		metadata["argumenthint"]
	)?.trim();

	const description =
		metadata.description?.trim() ??
		firstHeading(template) ??
		`Custom command from ${path.basename(filePath)}`;

	return {
		name,
		description,
		argumentHint: argumentHint || undefined,
		template,
		sourcePath: filePath,
	};
}

export async function loadCustomSlashCommands(
	workspace: string,
	homeDirectory: string = os.homedir(),
): Promise<CustomSlashCommand[]> {
	const commandRoots: CommandRoot[] = [
		{ root: path.join(workspace, ".cursor", "commands") },
		{ root: path.join(workspace, ".agents", "commands") },
		{ root: path.join(homeDirectory, ".cursor", "commands") },
		{ root: path.join(homeDirectory, ".agents", "commands") },
	];

	const byName = new Map<string, CustomSlashCommand>();
	for (const { root } of commandRoots) {
		const files = await collectMarkdownFiles(root);
		for (const file of files) {
			let command: CustomSlashCommand | null;
			try {
				command = await readCustomCommand(file, root);
			} catch {
				continue;
			}
			if (!command) {
				continue;
			}
			const key = normalizeSlashCommandName(command.name).toLowerCase();
			if (!byName.has(key)) {
				byName.set(key, command);
			}
		}
	}

	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function splitSlashArgs(args: string): string[] {
	const tokens: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(args)) !== null) {
		tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
	}
	return tokens;
}

function applyCustomCommandArgs(template: string, args: string): string {
	const trimmedArgs = args.trim();
	const tokens = splitSlashArgs(trimmedArgs);
	const hasPlaceholders = /\$ARGUMENTS|\$[1-9]\b/.test(template);
	const escapedDollar = "__CURSOR_ACP_ESCAPED_DOLLAR__";

	let result = template.replace(/\$\$/g, escapedDollar);
	result = result.replace(/\$ARGUMENTS/g, trimmedArgs);
	tokens.forEach((token, index) => {
		result = result.replace(new RegExp(`\\$${index + 1}\\b`, "g"), token);
	});
	result = result.replace(/\$[1-9]\b/g, "");
	result = result.split(escapedDollar).join("$");

	if (trimmedArgs && !hasPlaceholders) {
		const prefix = result.trimEnd();
		result = prefix.length > 0 ? `${prefix}\n\n${trimmedArgs}` : trimmedArgs;
	}

	return result.trim();
}

export function resolveCustomSlashCommandPrompt(
	commandName: string,
	args: string,
	customCommands: CustomSlashCommand[],
): string | null {
	const normalized = normalizeSlashCommandName(commandName).toLowerCase();
	const command = customCommands.find(
		(item) => normalizeSlashCommandName(item.name).toLowerCase() === normalized,
	);
	if (!command) {
		return null;
	}
	return applyCustomCommandArgs(command.template, args);
}

export function resolveSkillSlashCommandPrompt(
	commandName: string,
	skills: CustomSkill[],
): string | null {
	return resolveSkillPrompt(commandName, skills);
}

export function builtInSlashCommandNames(): string[] {
	return BUILTIN_SLASH_COMMANDS.map(formatSlashCommand);
}

export function parseModelListOutput(output: string): CursorModelDescriptor[] {
	const models: CursorModelDescriptor[] = [];
	const lines = output.split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes(" - ")) {
			continue;
		}

		const [idPart, rest] = trimmed.split(/\s+-\s+/, 2);
		if (!idPart || !rest) {
			continue;
		}

		const current = /\(current\)/i.test(rest);
		const name = rest.replace(/\(current\)/gi, "").trim();

		models.push({
			modelId: idPart.trim(),
			name,
			current,
		});
	}

	return models;
}

export async function handleSlashCommand(
	command: string,
	args: string,
	context: SlashCommandContext,
): Promise<SlashCommandResult> {
	const normalized = normalizeSlashCommandName(command).toLowerCase();

	switch (normalized) {
		case "help":
			return {
				handled: true,
				responseText: `Supported commands: ${(context.availableCommands?.length
					? context.availableCommands
					: BUILTIN_SLASH_COMMANDS
				)
					.map(formatSlashCommand)
					.join(", ")}`,
			};

		case "status": {
			const status = await context.auth.status();
			if (status.loggedIn) {
				return {
					handled: true,
					responseText: `Logged in as ${status.account}`,
				};
			}
			return { handled: true, responseText: "Not logged in" };
		}

		case "login": {
			const statusBefore = await context.auth.status();
			if (statusBefore.loggedIn) {
				return {
					handled: true,
					responseText: `Already logged in as ${statusBefore.account}`,
				};
			}

			await context.auth.login();
			const statusAfter = await context.auth.status();
			if (statusAfter.loggedIn) {
				return {
					handled: true,
					responseText: `Logged in as ${statusAfter.account}`,
				};
			}
			return {
				handled: true,
				responseText: "Login did not complete successfully",
			};
		}

		case "logout": {
			await context.auth.logout();
			return { handled: true, responseText: "Logged out" };
		}

		case "model": {
			const target = args.trim();
			const models = await context.listModels();

			if (!target) {
				const current =
					context.session.modelId ?? models.find((m) => m.current)?.modelId ?? "auto";
				return {
					handled: true,
					responseText: `Current model: ${current}\nAvailable: ${models
						.map((m) => m.modelId)
						.join(", ")}`,
				};
			}

			const resolvedTarget = resolveModelId(target, models);
			const match = models.find((m) => m.modelId === resolvedTarget);
			if (!match) {
				return {
					handled: true,
					responseText: `Unknown model: ${target}. Available: ${models
						.map((m) => m.modelId)
						.join(", ")}`,
				};
			}

			context.session.modelId = match.modelId;
			if (context.onModelChanged) {
				await context.onModelChanged(match.modelId);
			}
			return { handled: true, responseText: `Model set to ${match.modelId}` };
		}

		case "mode": {
			const target = args.trim();
			const modeList = ADVERTISED_MODE_IDS.map(modeDisplayName).join(", ");
			if (!target) {
				return {
					handled: true,
					responseText: `Current mode: ${modeDisplayName(context.session.modeId)}\nAvailable: ${modeList}`,
				};
			}

			const nextMode = normalizeModeId(target);
			if (!nextMode) {
				return {
					handled: true,
					responseText: `Unknown mode: ${target}. Available: ${modeList}`,
				};
			}

			context.session.modeId = nextMode;
			if (context.onModeChanged) {
				await context.onModeChanged(nextMode);
			}
			return { handled: true, responseText: `Mode set to ${modeDisplayName(nextMode)}` };
		}

		default:
			return { handled: false };
	}
}
