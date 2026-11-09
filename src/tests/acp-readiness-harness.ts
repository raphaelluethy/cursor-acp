/**
 * ACP readiness harness.
 *
 * Wires a real ACP client connection (the same JSON-RPC/ndjson framing an editor
 * such as Zed uses) to CursorAcpAgent over in-memory streams, with a scripted fake
 * Cursor backend. Every interaction a UI performs goes through the protocol layer,
 * so the readiness suite checks what a client actually receives on the wire:
 * capabilities, session setup, streaming updates, tool calls, permissions, mode
 * and config changes, cancellation, steering and session lifecycle.
 *
 * No network, Cursor login or model calls are involved.
 */
import {
	AgentSideConnection,
	ClientSideConnection,
	ndJsonStream,
	type Client,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorAcpAgent } from "../cursor-acp-agent.js";
import type { CursorAuthClient } from "../auth.js";
import type {
	CursorPromptRun,
	CursorRunner,
	CursorStreamEvent,
	RunPromptOptions,
	RunPromptResult,
} from "../cursor-runner.js";
import type { CursorModelDescriptor } from "../slash-commands.js";
import { noopLogger } from "./test-support.js";

export const READINESS_MODELS: CursorModelDescriptor[] = [
	{ modelId: "auto", name: "Auto", current: true },
	{
		modelId: "composer-2.5",
		name: "Composer 2.5",
		parameters: [
			{
				id: "fast",
				values: [
					{ value: "true", displayName: "On" },
					{ value: "false", displayName: "Off" },
				],
			},
		],
	},
	{
		modelId: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		parameters: [
			{
				id: "thinking",
				values: [{ value: "low" }, { value: "medium" }, { value: "high" }],
			},
		],
	},
];

/** One scripted backend turn. Events are streamed through onEvent in order. */
export interface FakeTurn {
	events?: CursorStreamEvent[];
	/** Hold the turn open until `release()` is called on the harness. */
	hold?: boolean;
	result?: Partial<RunPromptResult>;
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Scripted stand-in for the Cursor SDK runner. */
export class FakeCursorBackend implements CursorRunner {
	readonly supportsMidTurnSteering = true;
	readonly prompts: RunPromptOptions[] = [];
	readonly steers: string[] = [];
	readonly cancels: number[] = [];
	steerOutcome: "complete_delivered" | "revert_to_followup" = "complete_delivered";
	private readonly script: FakeTurn[] = [];
	private held?: Deferred;
	private chats = 0;

	constructor(private readonly models: CursorModelDescriptor[] = READINESS_MODELS) {}

	/** Queue scripted turns; unscripted turns answer with a single "ok" message. */
	enqueue(...turns: FakeTurn[]): void {
		this.script.push(...turns);
	}

	/** Let a held turn finish streaming. */
	release(): void {
		this.held?.resolve();
	}

	async listModels(): Promise<CursorModelDescriptor[]> {
		return this.models;
	}

	async createChat(): Promise<string> {
		this.chats += 1;
		return `fake-agent-${this.chats}`;
	}

	startPrompt(options: RunPromptOptions): CursorPromptRun {
		const index = this.prompts.push(options) - 1;
		const turn = this.script.shift() ?? { events: [assistantText("ok")] };
		const gate = turn.hold ? deferred() : undefined;
		if (gate) this.held = gate;
		let cancelled = false;
		const cancelGate = deferred();
		const completed = (async (): Promise<RunPromptResult> => {
			if (gate) await Promise.race([gate.promise, cancelGate.promise]);
			const events = turn.events ?? [];
			if (!cancelled) {
				for (const event of events) await options.onEvent?.(event);
			}
			return {
				events,
				resultEvent: cancelled
					? { type: "result", subtype: "cancelled", is_error: false }
					: { type: "result", subtype: "success", is_error: false },
				stderr: "",
				exitCode: 0,
				...turn.result,
			};
		})();
		return {
			completed,
			cancel: () => {
				cancelled = true;
				this.cancels.push(index);
				cancelGate.resolve();
			},
			steer: async (text: string) => {
				this.steers.push(text);
				return this.steerOutcome;
			},
		};
	}
}

/** Auth stub; flip `loggedIn` to exercise the auth-required path. */
export class FakeAuth implements CursorAuthClient {
	loggedIn = true;
	async status() {
		return { loggedIn: this.loggedIn, account: "readiness@example.test", raw: "" };
	}
	async ensureLoggedIn() {
		return this.status();
	}
	async login() {
		this.loggedIn = true;
		return { code: 0, stdout: "", stderr: "" };
	}
	async logout() {
		this.loggedIn = false;
		return { code: 0, stdout: "", stderr: "" };
	}
}

/** Records everything the agent sends to the "UI". */
export class RecordingClient implements Client {
	readonly updates: SessionNotification[] = [];
	readonly permissionRequests: RequestPermissionRequest[] = [];
	permissionOptionKind: "allow_once" | "reject_once" | "cancelled" = "allow_once";

	async sessionUpdate(notification: SessionNotification): Promise<void> {
		this.updates.push(notification);
	}

	async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		this.permissionRequests.push(request);
		if (this.permissionOptionKind === "cancelled") {
			return { outcome: { outcome: "cancelled" } };
		}
		const option = request.options.find((o) => o.kind === this.permissionOptionKind);
		if (!option) throw new Error(`No ${this.permissionOptionKind} option offered`);
		return { outcome: { outcome: "selected", optionId: option.optionId } };
	}

	async readTextFile() {
		return { content: "" };
	}

	async writeTextFile() {
		return {};
	}

	/** Session updates of one kind for one session, in arrival order. */
	updatesOf(sessionId: string, kind: string) {
		return this.updates
			.filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === kind)
			.map((n) => n.update);
	}

	/** Concatenated text of agent message chunks for a session. */
	agentText(sessionId: string): string {
		return this.updatesOf(sessionId, "agent_message_chunk")
			.map((u) => {
				const content = "content" in u ? u.content : undefined;
				return content && !Array.isArray(content) && content.type === "text"
					? content.text
					: "";
			})
			.join("");
	}

	clear(): void {
		this.updates.length = 0;
		this.permissionRequests.length = 0;
	}
}

export interface ReadinessHarness {
	/** The editor side of the ACP connection. */
	client: ClientSideConnection;
	ui: RecordingClient;
	backend: FakeCursorBackend;
	auth: FakeAuth;
	workspace: string;
	/** Wait until all queued notifications have been delivered to the UI. */
	settle(): Promise<void>;
	/** Start a second agent process over the same persisted state (restart / reload). */
	restart(): ReadinessHarness;
	dispose(): Promise<void>;
}

function connect(
	workspace: string,
	backend: FakeCursorBackend,
	auth: FakeAuth,
	cleanup: () => Promise<void>,
): ReadinessHarness {
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	new AgentSideConnection(
		(conn) => new CursorAcpAgent(conn, { runner: backend, auth, logger: noopLogger }),
		ndJsonStream(toClient.writable, toAgent.readable),
	);
	const ui = new RecordingClient();
	const client = new ClientSideConnection(
		() => ui,
		ndJsonStream(toAgent.writable, toClient.readable),
	);
	const settle = async () => {
		for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return {
		client,
		ui,
		backend,
		auth,
		workspace,
		settle,
		restart: () => connect(workspace, new FakeCursorBackend(), new FakeAuth(), async () => {}),
		dispose: cleanup,
	};
}

/** Create an isolated harness with its own workspace and session store. */
export async function createReadinessHarness(): Promise<ReadinessHarness> {
	const root = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-readiness-"));
	const workspace = path.join(root, "workspace");
	const previousConfigDir = process.env.CURSOR_ACP_CONFIG_DIR;
	process.env.CURSOR_ACP_CONFIG_DIR = path.join(root, "config");
	return connect(workspace, new FakeCursorBackend(), new FakeAuth(), async () => {
		if (previousConfigDir === undefined) delete process.env.CURSOR_ACP_CONFIG_DIR;
		else process.env.CURSOR_ACP_CONFIG_DIR = previousConfigDir;
		await rm(root, { recursive: true, force: true });
	});
}

// ---- Event builders for scripted turns ----

export function assistantText(text: string): CursorStreamEvent {
	return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

export function thinking(text: string): CursorStreamEvent {
	return { type: "thinking", subtype: "delta", text };
}

export function shellCall(
	callId: string,
	command: string,
	result: Record<string, unknown>,
): CursorStreamEvent[] {
	return [
		{
			type: "tool_call",
			subtype: "started",
			call_id: callId,
			tool_call: { shellToolCall: { args: { command } } },
		},
		{
			type: "tool_call",
			subtype: "completed",
			call_id: callId,
			tool_call: { shellToolCall: { args: { command }, result } },
		},
	];
}

export function editCall(callId: string, filePath: string, newText: string): CursorStreamEvent[] {
	const args = { path: filePath, streamContent: newText };
	return [
		{
			type: "tool_call",
			subtype: "started",
			call_id: callId,
			tool_call: { editToolCall: { args } },
		},
		{
			type: "tool_call",
			subtype: "completed",
			call_id: callId,
			tool_call: { editToolCall: { args, result: { success: { path: filePath } } } },
		},
	];
}
