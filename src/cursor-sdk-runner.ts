import type { McpServer } from "@agentclientprotocol/sdk";
import {
	Agent,
	Cursor,
	type AgentOptions,
	type McpServerConfig,
	type SDKAgent,
	type SDKMessage,
} from "@cursor/sdk";
import { randomUUID } from "node:crypto";
import {
	sdkMessageToCursorStreamEvent,
	sdkRunResultToCursorResultEvent,
} from "./cursor-sdk-event-adapter.js";
import { getCursorApiKey } from "./cursor-sdk-config.js";
import { buildLocalAgentOptions } from "./cursor-sdk-local-options.js";
import type {
	CursorPromptRun,
	CursorRunner,
	CursorStreamEvent,
	RunPromptOptions,
	RunPromptResult,
} from "./cursor-runner.js";
import { buildSdkModelSelection, ensureAutoModel } from "./model-id.js";
import type { CursorModelDescriptor } from "./slash-commands.js";
import type { Logger } from "./utils.js";

const PENDING_AGENT_PREFIX = "pending-";

interface ManagedAgent {
	agent: SDKAgent;
	configKey: string;
	cwd: string;
}

function isPendingAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.startsWith(PENDING_AGENT_PREFIX);
}

function isResumableAgentId(agentId: string | undefined): agentId is string {
	return typeof agentId === "string" && agentId.length > 0 && !isPendingAgentId(agentId);
}

function sdkMcpServers(
	servers: McpServer[] | undefined,
): Record<string, McpServerConfig> | undefined {
	if (!servers?.length) {
		return undefined;
	}

	const result: Record<string, McpServerConfig> = {};
	for (const server of servers) {
		if ("serverId" in server) {
			continue;
		}
		if ("url" in server) {
			result[server.name] = {
				type: server.type,
				url: server.url,
				headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
			};
			continue;
		}
		result[server.name] = {
			type: "stdio",
			command: server.command,
			args: server.args,
			env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
		};
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export class CursorSdkRunner implements CursorRunner {
	private readonly agents = new Map<string, ManagedAgent>();

	constructor(
		private readonly apiKey: string | undefined = getCursorApiKey(),
		private readonly logger: Logger = console,
	) {}

	async listModels(): Promise<CursorModelDescriptor[]> {
		const models = await Cursor.models.list(this.apiKey ? { apiKey: this.apiKey } : undefined);
		return ensureAutoModel(
			models.map((model) => ({
				modelId: model.id,
				name: model.displayName?.trim() || model.id,
				...(model.parameters?.length
					? {
							parameters: model.parameters.map((parameter) => ({
								id: parameter.id,
								displayName: parameter.displayName,
								values: parameter.values.map((value) => ({
									value: value.value,
									displayName: value.displayName,
								})),
							})),
						}
					: {}),
				...(model.variants?.length
					? {
							variants: model.variants.map((variant) => ({
								params: variant.params,
								isDefault: variant.isDefault,
							})),
						}
					: {}),
			})),
		);
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
		hooks: { isCancelled: () => boolean; setCancelRun: (cancel: () => void) => void },
	): Promise<RunPromptResult> {
		const events: CursorStreamEvent[] = [];
		let resultEvent: CursorStreamEvent | undefined;
		let stderr = "";
		const unfinishedToolCalls = new Map<string, Extract<SDKMessage, { type: "tool_call" }>>();
		const emit = async (event: CursorStreamEvent) => {
			events.push(event);
			if (event.type === "result") {
				resultEvent = event;
			}
			await options.onEvent?.(event);
		};

		try {
			const agent = await this.resolveAgent(options);
			await emit({ type: "system", subtype: "init", session_id: agent.agentId });

			const sendOptions: Parameters<SDKAgent["send"]>[1] = {
				model: buildSdkModelSelection(
					options.modelId ?? "auto",
					options.modelCatalog,
					options.thinkingLevel,
					options.fastValue,
				),
				...(options.modeId === "plan" ? { mode: "plan" as const } : {}),
				...(sdkMcpServers(options.mcpServers)
					? { mcpServers: sdkMcpServers(options.mcpServers) }
					: {}),
			};

			this.logger.log?.(
				"[cursor-acp] SDK prompt:",
				agent.agentId,
				options.workspace,
				options.modelId ?? "auto",
				options.reviewPolicy === "run-everything"
					? "approval-retry"
					: options.reviewPolicy === "auto-review"
						? "auto-review"
						: "run-everything",
			);

			const message = options.images?.length
				? { text: options.prompt, images: options.images }
				: options.prompt;
			const run = await agent.send(message, sendOptions);
			hooks.setCancelRun(() => void run.cancel());
			for await (const message of run.stream()) {
				if (hooks.isCancelled()) {
					await run.cancel().catch(() => undefined);
					break;
				}
				let duplicateRunningToolCall = false;
				if (message.type === "tool_call") {
					if (message.status === "running") {
						duplicateRunningToolCall = unfinishedToolCalls.has(message.call_id);
						unfinishedToolCalls.set(message.call_id, message);
					} else {
						unfinishedToolCalls.delete(message.call_id);
					}
				}
				if (duplicateRunningToolCall) {
					continue;
				}
				for (const adapted of sdkMessageToCursorStreamEvent(message)) {
					await emit(adapted);
				}
			}

			if (hooks.isCancelled()) {
				resultEvent = sdkRunResultToCursorResultEvent({ status: "cancelled" });
			} else {
				const finished = await run.wait();
				if (finished.status === "finished") {
					for (const toolCall of unfinishedToolCalls.values()) {
						for (const adapted of sdkMessageToCursorStreamEvent({
							...toolCall,
							status: "error",
							result: {
								message:
									"Cursor Auto Review stopped this tool at the auto-approval boundary",
							},
						})) {
							await emit(adapted);
						}
					}
				}
				resultEvent = sdkRunResultToCursorResultEvent({
					status: finished.status,
					resultText: finished.result,
					errorText: finished.error?.message ?? finished.result,
				});
				stderr =
					finished.status === "error"
						? (finished.error?.message ?? finished.result ?? "")
						: "";
			}
			await emit(resultEvent);
			return {
				events,
				resultEvent,
				stderr,
				exitCode: resultEvent.is_error === true ? 1 : 0,
			};
		} catch (error) {
			stderr = error instanceof Error ? error.message : String(error);
			resultEvent = sdkRunResultToCursorResultEvent({ status: "error", errorText: stderr });
			await emit(resultEvent);
			return { events, resultEvent, stderr, exitCode: 1 };
		}
	}

	private agentConfig(options: RunPromptOptions) {
		// The SDK has no approval callback. Smart Auto fails closed; an ACP-approved retry
		// deliberately resumes with Auto-review disabled for that one whole-turn retry.
		const autoReview = options.reviewPolicy !== "run-everything";
		const ask = options.modeId === "ask";
		return {
			autoReview,
			ask,
			key: JSON.stringify({ autoReview, ask }),
		};
	}

	private agentOptions(options: RunPromptOptions): AgentOptions {
		const config = this.agentConfig(options);
		return {
			...(this.apiKey ? { apiKey: this.apiKey } : {}),
			model: buildSdkModelSelection(
				options.modelId ?? "auto",
				options.modelCatalog,
				options.thinkingLevel,
				options.fastValue,
			),
			local: buildLocalAgentOptions(options.workspace, config.autoReview),
			...(config.ask ? { tools: [] } : {}),
			...(sdkMcpServers(options.mcpServers)
				? { mcpServers: sdkMcpServers(options.mcpServers) }
				: {}),
		};
	}

	private async resolveAgent(options: RunPromptOptions): Promise<SDKAgent> {
		const backendSessionId = options.backendSessionId;
		const configKey = this.agentConfig(options).key;
		if (backendSessionId) {
			const cached = this.agents.get(backendSessionId);
			if (cached && cached.cwd === options.workspace && cached.configKey === configKey) {
				return cached.agent;
			}
			if (cached) {
				cached.agent.close();
				this.agents.delete(backendSessionId);
			}

			if (isResumableAgentId(backendSessionId)) {
				const agent = await Agent.resume(backendSessionId, this.agentOptions(options));
				this.agents.set(backendSessionId, {
					agent,
					cwd: options.workspace,
					configKey,
				});
				return agent;
			}
		}

		const agent = await Agent.create(this.agentOptions(options));
		if (backendSessionId) {
			this.agents.delete(backendSessionId);
		}
		this.agents.set(agent.agentId, { agent, cwd: options.workspace, configKey });
		return agent;
	}
}
