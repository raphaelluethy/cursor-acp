import type { LocalAgentOptions, SettingSource } from "@cursor/sdk";

export const LOCAL_SETTING_SOURCES: readonly SettingSource[] = ["user"];

export function buildLocalAgentOptions(cwd: string): LocalAgentOptions {
	return {
		cwd,
		settingSources: [...LOCAL_SETTING_SOURCES],
	};
}
