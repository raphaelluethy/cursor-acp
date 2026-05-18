import type {
	ReadTextFileRequest,
	ReadTextFileResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
	WriteTextFileRequest,
	WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

/** Client surface used by {@link CursorAcpAgent}. */
export type CursorAcpClient = {
	sessionUpdate(params: SessionNotification): Promise<void>;
	requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
	readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
	writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
	extNotification(method: string, params: Record<string, unknown>): Promise<void>;
};
