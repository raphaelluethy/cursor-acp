import type { LocalAgentOptions, SettingSource } from "@cursor/sdk";

export const LOCAL_SETTING_SOURCES: readonly SettingSource[] = ["user", "project"];

export function buildLocalAgentOptions(
	cwd: string,
	autoReview: boolean,
	sandbox: boolean,
): LocalAgentOptions {
	return {
		cwd,
		autoReview,
		// Leave sandboxOptions unset otherwise so the user's sandbox.json still applies.
		...(sandbox ? { sandboxOptions: { enabled: true } } : {}),
		settingSources: [...LOCAL_SETTING_SOURCES],
	};
}
