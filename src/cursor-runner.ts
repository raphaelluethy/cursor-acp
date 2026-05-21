import type { CursorModelDescriptor } from "./slash-commands.js";

type Environment = Record<string, string | undefined>;

export interface CursorStreamEvent {
	type: string;
	subtype?: string;
	[key: string]: unknown;
}

export interface RunPromptOptions {
	workspace: string;
	prompt: string;
	backendSessionId?: string;
	modelId?: string;
	modeId?: "plan";
	force?: boolean;
	streamPartialOutput?: boolean;
	env?: Environment;
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
