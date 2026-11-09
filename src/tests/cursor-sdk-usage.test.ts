import type { SDKUsageMessage } from "@cursor/sdk";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordSdkUsage, resolveUsageLedgerPath } from "../cursor-sdk-usage.js";

const directories: string[] = [];

it("only enables the usage ledger when CURSOR_ACP_USAGE_LEDGER opts in", () => {
	expect(resolveUsageLedgerPath({})).toBeUndefined();
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "" })).toBeUndefined();
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "false" })).toBeUndefined();
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "0" })).toBeUndefined();
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "1" })).toMatch(/usage\.jsonl$/);
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "/var/tmp/u.jsonl" })).toBe(
		"/var/tmp/u.jsonl",
	);
	expect(resolveUsageLedgerPath({ CURSOR_ACP_USAGE_LEDGER: "~/.cursor/usage.jsonl" })).toBe(
		join(homedir(), ".cursor", "usage.jsonl"),
	);
});
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

it("writes separate token buckets without retaining paths, identifiers, or reasoning twice", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cursor-sdk-usage-"));
	directories.push(dir);
	const output = join(dir, "ledger", "usage.jsonl");
	const message: SDKUsageMessage = {
		type: "usage",
		agent_id: "private-agent",
		run_id: "private-run",
		usage: {
			inputTokens: 49,
			outputTokens: 3,
			cacheReadTokens: 31,
			cacheWriteTokens: 11,
			totalTokens: 94,
			reasoningTokens: 2,
		},
	};
	await recordSdkUsage(message, 0, "model-a", "/private/work/project", output);
	await recordSdkUsage(message, 1, "model-a", "/private/work/project", output);
	await recordSdkUsage(message, 0, "model-a", "/private/work/project", output);
	await recordSdkUsage(
		{ ...message, run_id: "another-run" },
		0,
		"model-a",
		"/private/work/project",
		output,
	);
	const content = await readFile(output, "utf8");
	expect(content).not.toMatch(/private|reasoning|totalTokens|another-run/);
	const rows = content
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(rows[0]).toEqual({
		version: 2,
		kind: "cursor-response",
		source: "cursor-sdk",
		eventId: expect.stringMatching(/^[a-f0-9]{64}$/),
		timestamp: expect.any(String),
		model: "model-a",
		project: "project",
		sdk_input_tokens: 49,
		input_tokens: 7,
		output_tokens: 3,
		cache_read_tokens: 31,
		cache_write_tokens: 11,
	});
	expect(Number.isFinite(Date.parse(rows[0].timestamp))).toBe(true);
	expect(rows[0].eventId).not.toBe(rows[1].eventId);
	expect(rows[0].eventId).toBe(rows[2].eventId);
	expect(rows[0].eventId).not.toBe(rows[3].eventId);
	expect((await stat(output)).mode & 0o777).toBe(0o600);
});
