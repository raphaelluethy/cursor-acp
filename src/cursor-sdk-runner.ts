import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import type {
	CursorCliRunnerLike,
	CursorPromptRun,
	CursorStreamEvent,
	RunPromptOptions,
	RunPromptResult,
} from "./cursor-cli-runner.js";
import {
	sdkMessageToCursorStreamEvent,
	sdkRunResultToCursorResultEvent,
} from "./cursor-sdk-event-adapter.js";
import { getCursorApiKey } from "./cursor-sdk-config.js";
import { normalizeModelId } from "./model-id.js";
import { CursorModelDescriptor } from "./slash-commands.js";
import { Logger } from "./utils.js";

const PENDING_AGENT_PREFIX = "pending-";
const RESULT_EVENT_GRACE_MS = 500;

interface ManagedAgent {
	agent: SDKAgent;
	cwd: string;
}

function isPendingAgentId(agentId: string | undefined): boolean {
	return typeof agentId === "string" && agentId.startsWith(PENDING_AGENT_PREFIX);
}

function isResumableAgentId(agentId: string | undefined): boolean {
	return typeof agentId === "string" && agentId.length > 0 && !isPendingAgentId(agentId);
}

export class CursorSdkRunner implements CursorCliRunnerLike {
	private readonly agents = new Map<string, ManagedAgent>();
	private readonly apiKey: string;

	constructor(
		apiKey: string = getCursorApiKey(),
		private readonly logger: Logger = console,
	) {
		if (!apiKey) {
			throw new Error("CursorSdkRunner requires CURSOR_API_KEY");
		}
		this.apiKey = apiKey;
	}

	async listModels(): Promise<CursorModelDescriptor[]> {
		const models = await Cursor.models.list({ apiKey: this.apiKey });
		return models.map((model) => ({
			modelId: model.id,
			name: model.displayName?.trim() || model.id,
			...(model.variants?.find((variant) => variant.isDefault) ? { current: true } : {}),
		}));
	}

	async createChat(): Promise<string> {
		return `${PENDING_AGENT_PREFIX}${randomUUID()}`;
	}

	startPrompt(options: RunPromptOptions): CursorPromptRun {
		let cancelled = false;
		let cancelRun: (() => void) | undefined;

		const completed = this.executePrompt(options, {
			isCancelled: () => cancelled,
			setCancelRun: (cancel) => {
				cancelRun = cancel;
			},
		});

		return {
			completed,
			cancel: () => {
				cancelled = true;
				cancelRun?.();
			},
		};
	}

	private async executePrompt(
		options: RunPromptOptions,
		hooks: {
			isCancelled: () => boolean;
			setCancelRun: (cancel: () => void) => void;
		},
	): Promise<RunPromptResult> {
		const events: CursorStreamEvent[] = [];
		let resultEvent: CursorStreamEvent | undefined;
		let stderr = "";

		const emit = async (event: CursorStreamEvent): Promise<void> => {
			events.push(event);
			if (event.type === "result") {
				resultEvent = event;
			}
			if (options.onEvent) {
				await options.onEvent(event);
			}
		};

		try {
			const agent = await this.resolveAgent(options);
			const sendOptions: Parameters<SDKAgent["send"]>[1] & { mode?: "agent" | "plan" } = {};
			if (options.modelId) {
				sendOptions.model = { id: normalizeModelId(options.modelId) };
			}
			if (options.modeId === "plan") {
				sendOptions.mode = "plan";
			}
			if (options.force) {
				sendOptions.local = { force: true };
			}

			this.logger.log?.(
				"[cursor-acp] SDK prompt:",
				agent.agentId,
				options.workspace,
				options.modelId ?? "default-model",
			);

			const run = await agent.send(options.prompt, sendOptions);
			hooks.setCancelRun(() => {
				void run.cancel();
			});

			for await (const message of run.stream()) {
				if (hooks.isCancelled()) {
					await run.cancel().catch(() => undefined);
					break;
				}

				for (const adapted of sdkMessageToCursorStreamEvent(message)) {
					await emit(adapted);
				}
			}

			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
			} else {
				const finished = await run.wait();
				if (finished.status === "cancelled") {
					resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
				} else if (finished.status === "error") {
					resultEvent = sdkRunResultToCursorResultEvent({
						status: "error",
						errorText: finished.result ?? "Cursor SDK run failed",
					});
					stderr = finished.result ?? "";
				} else {
					resultEvent = sdkRunResultToCursorResultEvent({
						status: "finished",
						resultText: finished.result,
					});
				}
			}

			await emit(resultEvent);
			await new Promise((resolve) => setTimeout(resolve, RESULT_EVENT_GRACE_MS));

			return {
				events,
				resultEvent,
				stderr,
				exitCode: resultEvent.is_error === true ? 1 : 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stderr = message;
			resultEvent = sdkRunResultToCursorResultEvent({
				status: "error",
				errorText: message,
			});
			await emit(resultEvent);
			return {
				events,
				resultEvent,
				stderr,
				exitCode: 1,
			};
		}
	}

	private async resolveAgent(options: RunPromptOptions): Promise<SDKAgent> {
		const backendSessionId = options.backendSessionId;
		if (backendSessionId) {
			const cached = this.agents.get(backendSessionId);
			if (cached && cached.cwd === options.workspace) {
				return cached.agent;
			}

			if (isResumableAgentId(backendSessionId)) {
				const agent = await Agent.resume(backendSessionId, {
					apiKey: this.apiKey,
					local: { cwd: options.workspace },
					...(options.modelId
						? { model: { id: normalizeModelId(options.modelId) } }
						: {}),
				});
				this.agents.set(backendSessionId, { agent, cwd: options.workspace });
				return agent;
			}
		}

		const agent = await Agent.create({
			apiKey: this.apiKey,
			model: { id: normalizeModelId(options.modelId ?? "auto") },
			local: { cwd: options.workspace },
		});

		const key = isResumableAgentId(backendSessionId) ? backendSessionId! : agent.agentId;
		this.agents.set(key, { agent, cwd: options.workspace });
		if (backendSessionId && isPendingAgentId(backendSessionId)) {
			this.agents.delete(backendSessionId);
			this.agents.set(agent.agentId, { agent, cwd: options.workspace });
		}

		return agent;
	}
}
