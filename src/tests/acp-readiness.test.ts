/**
 * ACP readiness suite: drives CursorAcpAgent through a real ACP client connection
 * with a scripted fake backend and checks what an editor UI receives.
 * Run on its own with `nub run test:acp`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadinessHarness } from "./acp-readiness-harness.js";
import {
	assistantText,
	createReadinessHarness,
	editCall,
	shellCall,
	thinking,
} from "./acp-readiness-harness.js";

let h: ReadinessHarness;

beforeEach(async () => {
	h = await createReadinessHarness();
});

afterEach(async () => {
	await h.dispose();
});

async function initialize(harness: ReadinessHarness = h) {
	return await harness.client.initialize({
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
	});
}

async function openSession(harness: ReadinessHarness = h) {
	await initialize(harness);
	return await harness.client.newSession({ cwd: harness.workspace, mcpServers: [] });
}

function lastPrompt() {
	return h.backend.prompts[h.backend.prompts.length - 1];
}

function text(value: string) {
	return [{ type: "text" as const, text: value }];
}

describe("ACP readiness: handshake", () => {
	it("negotiates protocol v1 and advertises the capabilities a UI relies on", async () => {
		const init = await initialize();
		expect(init.protocolVersion).toBe(1);
		expect(init.agentInfo?.name).toBeTruthy();
		expect(init.agentCapabilities).toMatchObject({
			loadSession: true,
			promptCapabilities: { image: true, embeddedContext: true },
			mcpCapabilities: { http: true, sse: true },
		});
		expect(init.agentCapabilities?.sessionCapabilities).toMatchObject({
			resume: {},
			list: {},
			close: {},
		});
		expect(init.authMethods?.map((method) => method.id)).toContain("cursor_login");
	});
});

describe("ACP readiness: session setup", () => {
	it("returns modes, models and config options for the session pickers", async () => {
		const session = await openSession();
		expect(session.sessionId).toMatch(/\S/);

		const modeIds = session.modes?.availableModes.map((mode) => mode.id) ?? [];
		expect(modeIds).toEqual(expect.arrayContaining(["auto-review", "yolo", "ask", "plan"]));
		expect(modeIds).toContain(session.modes?.currentModeId);

		const configIds = session.configOptions?.map((option) => option.id) ?? [];
		expect(configIds).toEqual(expect.arrayContaining(["mode", "model"]));
		const model = session.configOptions?.find((option) => option.id === "model");
		expect(model && "options" in model ? JSON.stringify(model.options) : "").toContain(
			"composer-2.5",
		);
	});

	it("publishes slash commands to the UI after the session opens", async () => {
		const { sessionId } = await openSession();
		await vi.waitFor(() =>
			expect(h.ui.updatesOf(sessionId, "available_commands_update")).not.toHaveLength(0),
		);
		const [latest] = h.ui.updatesOf(sessionId, "available_commands_update").slice(-1);
		const names =
			latest && "availableCommands" in latest
				? latest.availableCommands.map((command) => command.name)
				: [];
		expect(names).toEqual(expect.arrayContaining(["model", "mode"]));
	});
});

describe("ACP readiness: prompt turn", () => {
	it("streams thoughts, message chunks and tool calls, then ends the turn", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({
			events: [
				thinking("Checking the repo"),
				assistantText("Running a command. "),
				...shellCall("call_1", "ls", { success: { stdout: "README.md\n", exitCode: 0 } }),
				...editCall("call_2", `${h.workspace}/notes.md`, "hello"),
				assistantText("Done."),
			],
		});

		const response = await h.client.prompt({ sessionId, prompt: text("list files") });
		await h.settle();

		expect(response.stopReason).toBe("end_turn");
		expect(lastPrompt()?.prompt).toBe("list files");
		expect(h.ui.updatesOf(sessionId, "agent_thought_chunk")).toHaveLength(1);
		expect(h.ui.agentText(sessionId)).toBe("Running a command. Done.");

		const starts = h.ui.updatesOf(sessionId, "tool_call");
		expect(starts.map((u) => ("toolCallId" in u ? u.toolCallId : ""))).toEqual([
			"call_1",
			"call_2",
		]);
		const finals = h.ui
			.updatesOf(sessionId, "tool_call_update")
			.filter((u) => "status" in u && u.status);
		expect(finals.map((u) => ("status" in u ? u.status : ""))).toEqual([
			"completed",
			"completed",
		]);
	});

	it("forwards image prompt blocks to the backend", async () => {
		const { sessionId } = await openSession();
		await h.client.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "what is this?" },
				{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
			],
		});
		expect(lastPrompt()?.images).toEqual([
			expect.objectContaining({ data: "iVBORw0KGgo=", mimeType: "image/png" }),
		]);
	});

	it("reports a failed tool call as failed", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({
			events: shellCall("call_err", "false", { error: { message: "exit 1" } }),
		});
		await h.client.prompt({ sessionId, prompt: text("run it") });
		await h.settle();
		const statuses = h.ui
			.updatesOf(sessionId, "tool_call_update")
			.map((u) => ("status" in u ? u.status : undefined))
			.filter(Boolean);
		expect(statuses).toEqual(["failed"]);
	});
});

describe("ACP readiness: permissions", () => {
	const rejected = shellCall("call_r", "rm -rf build", {
		rejected: { message: "auto-approval boundary" },
	});

	it("asks the UI for permission and retries the turn when allowed", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({ events: rejected }, { events: [assistantText("retried")] });
		h.ui.permissionOptionKind = "allow_once";

		const response = await h.client.prompt({ sessionId, prompt: text("clean") });

		expect(response.stopReason).toBe("end_turn");
		expect(h.ui.permissionRequests).toHaveLength(1);
		expect(h.ui.permissionRequests[0]?.options.map((o) => o.kind)).toEqual(
			expect.arrayContaining(["allow_once", "reject_once"]),
		);
		expect(h.backend.prompts.map((p) => p.reviewPolicy)).toEqual([
			"auto-review",
			"run-everything",
		]);
	});

	it("does not retry when the UI rejects", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({ events: rejected });
		h.ui.permissionOptionKind = "reject_once";

		await h.client.prompt({ sessionId, prompt: text("clean") });

		expect(h.ui.permissionRequests).toHaveLength(1);
		expect(h.backend.prompts).toHaveLength(1);
	});
});

describe("ACP readiness: mode and config controls", () => {
	it("switches mode from the picker and uses it for the next turn", async () => {
		const { sessionId } = await openSession();
		await h.client.setSessionMode({ sessionId, modeId: "plan" });
		await h.client.prompt({ sessionId, prompt: text("plan it") });
		expect(lastPrompt()?.modeId).toBe("plan");

		await h.client.setSessionMode({ sessionId, modeId: "yolo" });
		await h.client.prompt({ sessionId, prompt: text("do it") });
		expect(lastPrompt()).toMatchObject({ reviewPolicy: "run-everything" });
		expect(lastPrompt()?.modeId).toBeUndefined();
	});

	it("rejects an unknown mode", async () => {
		const { sessionId } = await openSession();
		await expect(h.client.setSessionMode({ sessionId, modeId: "nope" })).rejects.toBeTruthy();
	});

	it("changes model and fast through config options", async () => {
		const { sessionId } = await openSession();
		const afterModel = await h.client.setSessionConfigOption({
			sessionId,
			configId: "model",
			value: "composer-2.5",
		});
		expect(afterModel.configOptions.map((option) => option.id)).toContain("fast");

		await h.client.setSessionConfigOption({ sessionId, configId: "fast", value: "true" });
		await h.client.prompt({ sessionId, prompt: text("go") });
		expect(lastPrompt()).toMatchObject({
			modelId: "composer-2.5",
			fastValue: "true",
		});
	});

	it("handles /mode as a local slash command without calling the model", async () => {
		const { sessionId } = await openSession();
		const response = await h.client.prompt({ sessionId, prompt: text("/mode ask") });
		await h.settle();
		expect(response.stopReason).toBe("end_turn");
		expect(h.backend.prompts).toHaveLength(0);
		expect(h.ui.agentText(sessionId)).not.toBe("");

		await h.client.prompt({ sessionId, prompt: text("question") });
		expect(lastPrompt()?.modeId).toBe("ask");
	});
});

describe("ACP readiness: cancellation and steering", () => {
	it("cancels a running turn with stopReason cancelled", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({ hold: true, events: [assistantText("late")] });

		const running = h.client.prompt({ sessionId, prompt: text("long task") });
		await vi.waitFor(() => expect(h.backend.prompts).toHaveLength(1));
		await h.client.cancel({ sessionId });

		expect((await running).stopReason).toBe("cancelled");
		expect(h.backend.cancels).toEqual([0]);

		const next = await h.client.prompt({ sessionId, prompt: text("after cancel") });
		expect(next.stopReason).toBe("end_turn");
	});

	it("steers a prompt sent while a turn is running into that turn", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({ hold: true, events: [assistantText("done")] });

		const first = h.client.prompt({ sessionId, prompt: text("first") });
		await vi.waitFor(() => expect(h.backend.prompts).toHaveLength(1));
		const steer = h.client.prompt({ sessionId, prompt: text("also check tests") });
		await vi.waitFor(() => expect(h.backend.steers).toEqual(["also check tests"]));
		h.backend.release();

		expect((await first).stopReason).toBe("end_turn");
		expect((await steer).stopReason).toBe("end_turn");
		expect(h.backend.prompts).toHaveLength(1);
	});

	it("queues a steer the backend reverts as a follow-up turn", async () => {
		const { sessionId } = await openSession();
		h.backend.steerOutcome = "revert_to_followup";
		h.backend.enqueue({ hold: true, events: [assistantText("first done")] });

		const first = h.client.prompt({ sessionId, prompt: text("first") });
		await vi.waitFor(() => expect(h.backend.prompts).toHaveLength(1));
		const followUp = h.client.prompt({ sessionId, prompt: text("follow up") });
		await vi.waitFor(() => expect(h.backend.steers).toHaveLength(1));
		h.backend.release();

		await first;
		expect((await followUp).stopReason).toBe("end_turn");
		expect(h.backend.prompts.map((p) => p.prompt)).toEqual(["first", "follow up"]);
	});
});

describe("ACP readiness: session lifecycle", () => {
	it("lists, reloads with history replay, and resumes sessions after a restart", async () => {
		const { sessionId } = await openSession();
		h.backend.enqueue({ events: [assistantText("hello back")] });
		await h.client.prompt({ sessionId, prompt: text("hello") });
		await h.settle();

		const restarted = h.restart();
		await initialize(restarted);

		const listed = await restarted.client.listSessions({ cwd: h.workspace });
		expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);

		await restarted.client.loadSession({ sessionId, cwd: h.workspace, mcpServers: [] });
		await restarted.settle();
		const replayedUser = restarted.ui.updatesOf(sessionId, "user_message_chunk");
		expect(JSON.stringify(replayedUser)).toContain("hello");
		expect(restarted.ui.agentText(sessionId)).toContain("hello back");

		const third = h.restart();
		await initialize(third);
		const resumed = await third.client.resumeSession({
			sessionId,
			cwd: h.workspace,
			mcpServers: [],
		});
		expect(resumed.modes?.currentModeId).toBeTruthy();
		// Known deviation: ACP's session/resume is meant to restore a session without
		// replaying messages, but cursor-acp also replays stored history on resume.
		await third.settle();
		expect(JSON.stringify(third.ui.updatesOf(sessionId, "user_message_chunk"))).toContain(
			"hello",
		);

		third.backend.enqueue({ events: [assistantText("still here")] });
		const next = await third.client.prompt({ sessionId, prompt: text("again") });
		expect(next.stopReason).toBe("end_turn");
	});

	it("closes a session so later prompts are rejected", async () => {
		const { sessionId } = await openSession();
		await h.client.closeSession({ sessionId });
		await expect(h.client.prompt({ sessionId, prompt: text("hi") })).rejects.toBeTruthy();
	});
});

describe("ACP readiness: errors", () => {
	it("returns a JSON-RPC error for an unknown session", async () => {
		await initialize();
		await expect(
			h.client.prompt({ sessionId: "does-not-exist", prompt: text("hi") }),
		).rejects.toBeTruthy();
	});

	it("asks the UI to authenticate when Cursor is logged out", async () => {
		const { sessionId } = await openSession();
		h.auth.loggedIn = false;
		await expect(h.client.prompt({ sessionId, prompt: text("hi") })).rejects.toMatchObject({
			code: -32000,
		});
		expect(h.backend.prompts).toHaveLength(0);
	});
});
