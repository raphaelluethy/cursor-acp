import { getCursorApiKey } from "./cursor-sdk-config.js";

export type ParsedAuthStatus =
	| { loggedIn: true; account: string; raw: string }
	| { loggedIn: false; raw: string };

export interface CursorAuthClient {
	status(): Promise<ParsedAuthStatus>;
	ensureLoggedIn(): Promise<ParsedAuthStatus>;
}

export class CursorSdkAuth implements CursorAuthClient {
	constructor(private readonly apiKey: string = getCursorApiKey()) {}

	async status(): Promise<ParsedAuthStatus> {
		try {
			const { Cursor } = await import("@cursor/sdk");
			const user = await Cursor.me({ apiKey: this.apiKey });
			const account =
				user.userEmail?.trim() ||
				[user.userFirstName, user.userLastName].filter(Boolean).join(" ").trim() ||
				user.apiKeyName;
			return {
				loggedIn: true,
				account,
				raw: JSON.stringify(user),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				loggedIn: false,
				raw: message,
			};
		}
	}

	async ensureLoggedIn(): Promise<ParsedAuthStatus> {
		const current = await this.status();
		if (current.loggedIn) {
			return current;
		}
		throw new Error(
			"CURSOR_API_KEY is missing or invalid. Create a key at https://cursor.com/dashboard/integrations",
		);
	}
}

export function createCursorAuth(): CursorAuthClient {
	return new CursorSdkAuth();
}
