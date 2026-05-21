export function shouldUseCursorSdk(): boolean {
	return getCursorApiKey().length > 0;
}

export function getCursorApiKey(): string {
	const fromEnv = process.env.CURSOR_API_KEY?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : "";
}
