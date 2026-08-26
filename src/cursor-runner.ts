import type { McpServer } from "@agentclientprotocol/sdk";
import type { SDKImage } from "@cursor/sdk";
import type { CursorModelDescriptor } from "./slash-commands.js";

type Environment = Record<string, string | undefined>;

export type CursorPromptImage = Extract<SDKImage, { data: string }>;

export interface CursorStreamEvent {
	type: string;
	subtype?: string;
	[key: string]: unknown;
}

export interface RunPromptOptions {
	workspace: string;
	prompt: string;
	images?: CursorPromptImage[];
	backendSessionId?: string;
	modelId?: string;
	modeId?: "plan" | "ask";
	reviewPolicy?: "auto-review" | "run-everything";
	streamPartialOutput?: boolean;
	env?: Environment;
	modelCatalog?: CursorModelDescriptor[];
	thinkingLevel?: string;
	fastValue?: string;
	mcpServers?: McpServer[];
	onEvent?: (event: CursorStreamEvent) => Promise<void> | void;
}

export interface RunPromptResult {
	events: CursorStreamEvent[];
	resultEvent?: CursorStreamEvent;
	stderr: string;
	exitCode: number;
}

export interface CursorPromptRun {
	completed: Promise<RunPromptResult>;
	cancel: () => void;
}

export interface CursorRunner {
	listModels(): Promise<CursorModelDescriptor[]>;
	createChat(): Promise<string>;
	startPrompt(options: RunPromptOptions): CursorPromptRun;
}
