import { createAgentPlatform } from "@cursor/sdk";
import { loadCursorCliConfig, type LoadedCursorCliConfig } from "./cursor-cli-config.js";
import { getCursorApiKey } from "./cursor-sdk-config.js";
import { LOCAL_SETTING_SOURCES } from "./cursor-sdk-local-options.js";
import type { Logger } from "./utils.js";

let cachedConfig: LoadedCursorCliConfig | undefined;

export function getLoadedCursorCliConfig(): LoadedCursorCliConfig | undefined {
	return cachedConfig;
}

/**
 * Load Cursor CLI config files on startup and warm the SDK local executor cache
 * so `settingSources` layers are resolved before the first ACP prompt.
 */
export async function preloadCursorCliSettings(
	cwd: string = process.cwd(),
	logger: Logger = console,
): Promise<LoadedCursorCliConfig> {
	const config = loadCursorCliConfig(cwd);
	cachedConfig = config;

	const apiKey = getCursorApiKey();
	if (apiKey) {
		const platform = await createAgentPlatform({ workspaceRef: cwd });
		const lease = await platform.acquireLocalExecutor({
			workingDirectory: cwd,
			apiKey,
			settingSources: [...LOCAL_SETTING_SOURCES],
		});
		try {
			await lease.handle.reload?.();
		} finally {
			await lease.release();
		}
	}

	if (process.env.CURSOR_ACP_DEBUG_LOG === "1") {
		logger.log?.(
			"[cursor-acp] Preloaded CLI settings:",
			config.userConfigPath,
			"attribution=",
			JSON.stringify(config.attribution),
			config.projectConfigPaths.length > 0
				? `project=${config.projectConfigPaths.join(",")}`
				: "",
		);
	}

	return config;
}
