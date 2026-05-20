import { CursorCliRunner, type CursorCliRunnerLike } from "./cursor-cli-runner.js";
import { shouldUseCursorSdk } from "./cursor-sdk-config.js";
import { CursorSdkRunner } from "./cursor-sdk-runner.js";
import type { RunPromptOptions } from "./cursor-cli-runner.js";
import { Logger } from "./utils.js";

/**
 * Uses the Cursor SDK for prompt execution when an API key is configured, but
 * keeps the CLI runner for `ask` mode (not exposed on the SDK) and as a fallback
 * when {@link shouldUseCursorSdk} is false.
 */
export class CursorHybridRunner implements CursorCliRunnerLike {
	constructor(
		private readonly sdk: CursorCliRunnerLike,
		private readonly cli: CursorCliRunnerLike,
		private readonly logger: Logger = console,
	) {}

	async listModels() {
		try {
			return await this.sdk.listModels();
		} catch (error) {
			this.logger.warn?.("[cursor-acp] SDK listModels failed, falling back to CLI", error);
			return await this.cli.listModels();
		}
	}

	async createChat() {
		return await this.sdk.createChat();
	}

	startPrompt(options: RunPromptOptions) {
		if (options.modeId === "ask") {
			this.logger.log?.("[cursor-acp] ask mode uses CLI runner (SDK has no ask mode)");
			return this.cli.startPrompt(options);
		}
		return this.sdk.startPrompt(options);
	}
}

export function createCursorRunner(logger: Logger = console): CursorCliRunnerLike {
	if (shouldUseCursorSdk()) {
		try {
			const sdk = new CursorSdkRunner(undefined, logger);
			return new CursorHybridRunner(sdk, new CursorCliRunner(undefined, logger), logger);
		} catch (error) {
			logger.warn?.("[cursor-acp] SDK runner unavailable, using CLI", error);
		}
	}
	return new CursorCliRunner(undefined, logger);
}
