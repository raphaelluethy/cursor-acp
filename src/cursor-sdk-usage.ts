import type { SDKUsageMessage } from "@cursor/sdk";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Persist reported per-turn counters in the BB Usage Cursor ledger format. */
export async function recordSdkUsage(
	message: SDKUsageMessage,
	turnIndex: number,
	model: string,
	workspace: string,
	output = join(homedir(), ".cursor", "usage.jsonl"),
): Promise<void> {
	const row = {
		version: 2,
		kind: "cursor-response",
		source: "cursor-sdk",
		eventId: createHash("sha256")
			.update(JSON.stringify(["cursor-sdk", message.agent_id, message.run_id, turnIndex]))
			.digest("hex"),
		timestamp: new Date().toISOString(),
		model,
		project: basename(workspace.replace(/\\/g, "/")).slice(0, 80) || "Unknown",
		// Local SDK input includes cache reads and writes; the ledger uses disjoint buckets.
		sdk_input_tokens: message.usage.inputTokens,
		input_tokens: Math.max(
			0,
			message.usage.inputTokens -
				message.usage.cacheReadTokens -
				message.usage.cacheWriteTokens,
		),
		output_tokens: message.usage.outputTokens,
		cache_read_tokens: message.usage.cacheReadTokens,
		cache_write_tokens: message.usage.cacheWriteTokens,
	};
	await mkdir(dirname(output), { recursive: true, mode: 0o700 });
	await appendFile(output, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
