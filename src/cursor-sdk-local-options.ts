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
		sandboxOptions: { enabled: sandbox },
		settingSources: [...LOCAL_SETTING_SOURCES],
	};
}
