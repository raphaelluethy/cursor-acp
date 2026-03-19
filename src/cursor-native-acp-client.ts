import {
	AuthenticateRequest,
	Client,
	ClientCapabilities,
	ClientSideConnection,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	SetSessionModeRequest,
	SetSessionModeResponse,
	WriteTextFileRequest,
	WriteTextFileResponse,
	ndJsonStream,
} from "@agentclientprotocol/sdk";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { nodeToWebReadable, nodeToWebWritable, Logger, stripAnsi } from "./utils.js";

export type NativeModeId = "agent" | "ask" | "plan";

export interface NativeSessionCallbacks {
	onSessionUpdate: (notification: SessionNotification) => Promise<void> | void;
	onRequestPermission: (
		request: RequestPermissionRequest,
	) => Promise<RequestPermissionResponse> | RequestPermissionResponse;
	onReadTextFile?: (request: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
	onWriteTextFile?: (request: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
	/** Forward Cursor ACP extension requests (e.g. `cursor/ask_question`) to the outer client. */
	onExtMethod?: (
		method: string,
		params: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
	/** Forward Cursor ACP extension notifications (e.g. `cursor/update_todos`) to the outer client. */
	onExtNotification?: (method: string, params: Record<string, unknown>) => Promise<void>;
	onUnexpectedClose?: (error: Error) => void;
}

export interface CreateNativeSessionOptions {
	clientCapabilities?: ClientCapabilities;
	command?: string;
	cwd: string;
	logger?: Logger;
	mcpServers?: NewSessionRequest["mcpServers"];
	modelId?: string;
}

export interface NativeSessionBackend {
	readonly nativeSessionId: string | undefined;
	readonly alive: boolean;
	cancel(): Promise<void>;
	close(): Promise<void>;
	createSessionBackend(): Promise<NewSessionResponse>;
	prompt(promptText: string): Promise<PromptResponse>;
	restartBackend(): Promise<NewSessionResponse>;
	setNativeMode(modeId: NativeModeId): Promise<SetSessionModeResponse | void>;
}

class NativeClientHandler implements Client {
	constructor(
		private readonly callbacks: NativeSessionCallbacks,
		private readonly logger: Logger,
	) {}

	async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return await this.callbacks.onRequestPermission(params);
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		await this.callbacks.onSessionUpdate(params);
	}

	async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
		if (!this.callbacks.onReadTextFile) {
			throw new Error("readTextFile is not available");
		}

		return await this.callbacks.onReadTextFile(params);
	}

	async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
		if (!this.callbacks.onWriteTextFile) {
			throw new Error("writeTextFile is not available");
		}

		return await this.callbacks.onWriteTextFile(params);
	}

	async extMethod(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (this.callbacks.onExtMethod) {
			return await this.callbacks.onExtMethod(method, params);
		}

		this.logger.warn?.("[cursor-acp] ignoring native ACP extension method", method, params);
		return {};
	}

	async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
		if (this.callbacks.onExtNotification) {
			await this.callbacks.onExtNotification(method, params);
			return;
		}

		this.logger.warn?.(
			"[cursor-acp] ignoring native ACP extension notification",
			method,
			params,
		);
	}
}

export class CursorNativeAcpClient implements NativeSessionBackend {
	private child: ChildProcessWithoutNullStreams | null = null;
	private closing = false;
	private connection: ClientSideConnection | null = null;
	private initPromise: Promise<void> | null = null;
	private currentPrompt: Promise<PromptResponse> | null = null;

	nativeSessionId: string | undefined;

	constructor(
		private readonly options: CreateNativeSessionOptions,
		private readonly callbacks: NativeSessionCallbacks,
	) {}

	get alive(): boolean {
		return this.child !== null && this.connection !== null && !this.connection.signal.aborted;
	}

	async createSessionBackend(): Promise<NewSessionResponse> {
		await this.ensureStarted();
		const connection = this.requireConnection();

		const response = await connection.newSession({
			cwd: this.options.cwd,
			mcpServers: this.options.mcpServers ?? [],
		});
		this.nativeSessionId = response.sessionId;
		return response;
	}

	async restartBackend(): Promise<NewSessionResponse> {
		await this.close();
		return await this.createSessionBackend();
	}

	async prompt(promptText: string): Promise<PromptResponse> {
		await this.ensureStarted();
		const connection = this.requireConnection();
		const sessionId = this.requireNativeSessionId();

		const request: PromptRequest = {
			sessionId,
			prompt: [{ type: "text", text: promptText }],
		};

		this.currentPrompt = connection.prompt(request);
		try {
			return await this.currentPrompt;
		} finally {
			this.currentPrompt = null;
		}
	}

	async setNativeMode(modeId: NativeModeId): Promise<SetSessionModeResponse | void> {
		await this.ensureStarted();
		const connection = this.requireConnection();

		const request: SetSessionModeRequest = {
			sessionId: this.requireNativeSessionId(),
			modeId,
		};
		return await connection.setSessionMode(request);
	}

	async cancel(): Promise<void> {
		if (!this.alive || !this.nativeSessionId) {
			return;
		}

		await this.requireConnection().cancel({ sessionId: this.nativeSessionId });
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}

		this.closing = true;
		this.initPromise = null;
		this.nativeSessionId = undefined;

		await new Promise<void>((resolve) => {
			const onClose = () => {
				child.removeAllListeners();
				resolve();
			};

			child.once("close", onClose);
			child.stdin.end();
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 1000).unref?.();
		});

		this.child = null;
		this.connection = null;
		this.closing = false;
	}

	private async ensureStarted(): Promise<void> {
		if (this.initPromise) {
			return await this.initPromise;
		}

		this.initPromise = this.start();

		try {
			await this.initPromise;
		} catch (error) {
			this.initPromise = null;
			this.child = null;
			this.connection = null;
			throw error;
		}
	}

	private async start(): Promise<void> {
		const args: string[] = [];
		if (this.options.modelId) {
			args.push("--model", this.options.modelId);
		}
		args.push("acp");

		this.options.logger?.log?.(
			"[cursor-acp] spawning native ACP:",
			this.options.command ?? "agent",
			args.join(" "),
		);

		const child = spawn(this.options.command ?? "agent", args, {
			cwd: this.options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		child.stderr.on("data", (chunk: Buffer) => {
			const text = stripAnsi(chunk.toString("utf8")).trim();
			if (text.length > 0) {
				this.options.logger?.error?.("[cursor-acp] native ACP stderr:", text);
			}
		});

		const stream = ndJsonStream(
			nodeToWebWritable(child.stdin),
			nodeToWebReadable(child.stdout),
		);
		const connection = new ClientSideConnection(
			() => new NativeClientHandler(this.callbacks, this.options.logger ?? console),
			stream,
		);
		this.connection = connection;

		child.once("error", (error) => {
			if (!this.closing) {
				this.callbacks.onUnexpectedClose?.(error);
			}
		});
		child.once("close", (code, signal) => {
			this.child = null;
			this.connection = null;
			this.nativeSessionId = undefined;
			this.initPromise = null;

			if (this.closing) {
				return;
			}

			this.callbacks.onUnexpectedClose?.(
				new Error(
					`Native ACP process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
				),
			);
		});

		await connection.initialize({
			protocolVersion: 1,
			// Native `agent acp` currently fails `session/new` when initialized with
			// richer client capabilities such as Zed's fs/terminal support.
			// Keep the wrapper's full capabilities at the outer ACP boundary and use
			// a conservative inner capability set for the native backend.
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: {
				name: "cursor-acp",
				version: "native-proxy",
			},
		});

		const authRequest: AuthenticateRequest = { methodId: "cursor_login" };
		await connection.authenticate(authRequest);
	}

	private requireConnection(): ClientSideConnection {
		if (!this.connection) {
			throw new Error("Native ACP connection is not initialized");
		}

		return this.connection;
	}

	private requireNativeSessionId(): string {
		if (!this.nativeSessionId) {
			throw new Error("Native ACP session is not initialized");
		}

		return this.nativeSessionId;
	}
}
