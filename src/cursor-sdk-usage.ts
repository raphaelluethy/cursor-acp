import type { SDKUsageMessage } from "@cursor/sdk";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getCursorAcpConfigDir } from "./session-storage.js";

export const USAGE_LEDGER_ENV = "CURSOR_ACP_USAGE_LEDGER";

/**
 * Resolve the opt-in usage ledger path from `CURSOR_ACP_USAGE_LEDGER`.
 * Unset, empty, `0` or `false` disables recording; `1` or `true` uses
 * `<config dir>/usage.jsonl`; any other value is a file path (`~/` expands).
 */
export function resolveUsageLedgerPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[USAGE_LEDGER_ENV]?.trim();
	if (!raw || /^(0|false|off|no)$/i.test(raw)) return undefined;
	if (/^(1|true|on|yes)$/i.test(raw)) return join(getCursorAcpConfigDir(), "usage.jsonl");
	if (raw === "~") return homedir();
	return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

/** Append one reported SDK turn to the JSONL usage ledger at `output`. */
export async function recordSdkUsage(
	message: SDKUsageMessage,
	turnIndex: number,
	model: string,
	workspace: string,
	output: string,
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
