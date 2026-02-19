import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { CursorAcpAgent } from "./cursor-acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";

export function runAcp(): void {
	const input = nodeToWebWritable(process.stdout);
	const output = nodeToWebReadable(process.stdin);
	const stream = ndJsonStream(input, output);
	new AgentSideConnection((client) => new CursorAcpAgent(client), stream);
}
