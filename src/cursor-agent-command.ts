export const DEFAULT_CURSOR_AGENT_COMMAND = "cursor-agent";

export function getDefaultCursorAgentCommand(): string {
	const configured = process.env.CURSOR_ACP_AGENT_COMMAND ?? process.env.CURSOR_AGENT_COMMAND;
	return configured?.trim() || DEFAULT_CURSOR_AGENT_COMMAND;
}
