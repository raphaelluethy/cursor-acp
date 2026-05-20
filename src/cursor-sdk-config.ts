/**
 * Resolve whether the adapter should use {@link @cursor/sdk} instead of spawning
 * `cursor-agent` for prompt execution and catalog reads.
 */
export function shouldUseCursorSdk(): boolean {
	if (process.env.CURSOR_ACP_USE_CLI === "1") {
		return false;
	}
	if (process.env.CURSOR_ACP_USE_SDK === "0") {
		return false;
	}
	return getCursorApiKey().length > 0;
}

export function getCursorApiKey(): string {
	const fromEnv = process.env.CURSOR_API_KEY?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : "";
}
