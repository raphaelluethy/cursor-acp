import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { CursorAcpAgent } from "./cursor-acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import type { PermissionModeSetting } from "./settings.js";

export function runAcp(permissionMode?: PermissionModeSetting): void {
	const input = nodeToWebWritable(process.stdout);
	const output = nodeToWebReadable(process.stdin);
	const stream = ndJsonStream(input, output);
	new AgentSideConnection((client) => new CursorAcpAgent(client, { permissionMode }), stream);
}
