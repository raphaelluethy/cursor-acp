import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";

export interface Logger {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
}

export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				nodeStream.write(Buffer.from(chunk), (err) => {
					if (err) {
						reject(err);
					} else {
						resolve();
					}
				});
			});
		},
	});
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			nodeStream.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			nodeStream.on("end", () => controller.close());
			nodeStream.on("error", (err) => controller.error(err));
		},
	});
}

export function unreachable(value: never, logger: Logger = console): never {
	let valueAsString: string;
	try {
		valueAsString = JSON.stringify(value);
	} catch {
		valueAsString = String(value);
	}
	logger.error(`Unexpected case: ${valueAsString}`);
	throw new Error(`Unexpected case: ${valueAsString}`);
}

export function stripAnsi(text: string): string {
	let output = "";
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		if (char === "\u001b") {
			const next = text[i + 1];

			// CSI sequence (ESC [ ... letter)
			if (next === "[") {
				i += 2;
				while (i < text.length) {
					const code = text.charCodeAt(i);
					if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
						i += 1;
						break;
					}
					i += 1;
				}
				continue;
			}

			// OSC sequence (ESC ] ... BEL or ESC \)
			if (next === "]") {
				i += 2;
				while (i < text.length) {
					const current = text[i];
					const following = text[i + 1];
					if (current === "\u0007") {
						i += 1;
						break;
					}
					if (current === "\u001b" && following === "\\") {
						i += 2;
						break;
					}
					i += 1;
				}
				continue;
			}

			// Unknown escape sequence, skip ESC itself.
			i += 1;
			continue;
		}

		output += char;
		i += 1;
	}

	return output;
}

export function sanitizeToolCallId(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return "tool-call";
	}
	return trimmed.replace(/\s+/g, "_");
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
