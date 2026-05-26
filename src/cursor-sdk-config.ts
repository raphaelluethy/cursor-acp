export function getCursorApiKey(): string | undefined {
	const apiKey = process.env.CURSOR_API_KEY?.trim();
	return apiKey || undefined;
}
