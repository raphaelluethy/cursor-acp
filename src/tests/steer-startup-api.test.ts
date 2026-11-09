import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { CursorAcpClient } from "../cursor-acp-client.js";
import { steerSessionDir } from "../steer-attachments.js";
import { initRequest } from "./test-support.js";

it("adapter startup removes attachment directories older than 24 hours", async () => {
	const sessionId = `expired-${randomUUID()}`;
	const directory = steerSessionDir(sessionId);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(`${directory}/attachment.png`, "old attachment", { mode: 0o600 });
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await utimes(directory, old, old);

		vi.resetModules();
		const { CursorAcpAgent } = await import("../cursor-acp-agent.js");
		const agent = new CursorAcpAgent({} as CursorAcpClient);
		await agent.initialize(initRequest());

		await vi.waitFor(() => expect(existsSync(directory)).toBe(false));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
