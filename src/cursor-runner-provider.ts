import type { CursorPromptRun, CursorRunner, RunPromptOptions } from "./cursor-runner.js";
import type { Logger } from "./utils.js";

export function createCursorRunner(logger: Logger = console): CursorRunner {
	return new LazySdkRunner(logger);
}

class LazySdkRunner implements CursorRunner {
	private delegate: CursorRunner | null = null;
	private readonly init: Promise<CursorRunner>;

	constructor(private readonly logger: Logger) {
		this.init = this.loadDelegate();
	}

	private async loadDelegate(): Promise<CursorRunner> {
		const { CursorSdkRunner } = await import("./cursor-sdk-runner.js");
		return new CursorSdkRunner(undefined, this.logger);
	}

	private async ready(): Promise<CursorRunner> {
		if (!this.delegate) {
			this.delegate = await this.init;
		}
		return this.delegate;
	}

	async listModels() {
		return (await this.ready()).listModels();
	}

	async createChat() {
		return (await this.ready()).createChat();
	}

	startPrompt(options: RunPromptOptions) {
		if (this.delegate) {
			return this.delegate.startPrompt(options);
		}
		let inner: CursorPromptRun | undefined;
		const completed = this.init.then((runner) => {
			this.delegate = runner;
			inner = runner.startPrompt(options);
			return inner.completed;
		});
		return {
			completed,
			cancel: () => inner?.cancel(),
		};
	}
}
