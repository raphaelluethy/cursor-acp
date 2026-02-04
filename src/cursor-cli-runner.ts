import { ChildProcessByStdio, spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  CursorModelDescriptor,
  parseModelListOutput,
} from "./slash-commands.js";
import { Logger, stripAnsi } from "./utils.js";

type Environment = Record<string, string | undefined>;

export interface CursorStreamEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface RunPromptOptions {
  workspace: string;
  prompt: string;
  backendSessionId?: string;
  modelId?: string;
  modeId?: "plan" | "ask";
  force?: boolean;
  streamPartialOutput?: boolean;
  env?: Environment;
  onEvent?: (event: CursorStreamEvent) => Promise<void> | void;
}

export interface RunPromptResult {
  events: CursorStreamEvent[];
  resultEvent?: CursorStreamEvent;
  stderr: string;
  exitCode: number;
}

export interface CursorPromptRun {
  completed: Promise<RunPromptResult>;
  cancel: () => void;
}

async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Environment },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export class CursorCliRunner {
  constructor(
    private readonly command: string = "agent",
    private readonly logger: Logger = console,
  ) {}

  async listModels(): Promise<CursorModelDescriptor[]> {
    const result = await runCommand(this.command, ["--list-models"]);
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0) {
      throw new Error(`Failed to list models: ${output.trim()}`);
    }
    return parseModelListOutput(output);
  }

  async createChat(): Promise<string> {
    const result = await runCommand(this.command, ["create-chat"]);
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0) {
      throw new Error(`Failed to create chat: ${output.trim()}`);
    }

    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const id = lines[lines.length - 1];
    if (!id) {
      throw new Error("Cursor create-chat returned empty session id");
    }
    return id;
  }

  startPrompt(options: RunPromptOptions): CursorPromptRun {
    const args = ["--print", "--output-format", "stream-json"];

    if (options.backendSessionId) {
      args.push("--resume", options.backendSessionId);
    }
    args.push("--workspace", options.workspace);

    if (options.modelId) {
      args.push("--model", options.modelId);
    }

    if (options.modeId) {
      args.push("--mode", options.modeId);
    }

    if (options.force) {
      args.push("--force");
    }

    if (options.streamPartialOutput) {
      args.push("--stream-partial-output");
    }

    args.push(options.prompt);

    this.logger.log("[cursor-acp] spawning:", this.command, args.join(" "));

    const child = spawn(this.command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const completed = this.readPromptStream(child, options.onEvent);

    return {
      completed,
      cancel: () => {
        child.kill("SIGTERM");
      },
    };
  }

  private async readPromptStream(
    child: ChildProcessByStdio<null, Readable, Readable>,
    onEvent?: (event: CursorStreamEvent) => Promise<void> | void,
  ): Promise<RunPromptResult> {
    let stdoutBuffer = "";
    let stderr = "";
    const events: CursorStreamEvent[] = [];
    let resultEvent: CursorStreamEvent | undefined;
    let settled = false;
    let processing: Promise<void> = Promise.resolve();

    let resolveDone: ((result: RunPromptResult) => void) | null = null;
    let rejectDone: ((err: Error) => void) | null = null;

    const donePromise = new Promise<RunPromptResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const processLine = async (line: string): Promise<void> => {
      if (!line.trim()) {
        return;
      }

      let parsed: CursorStreamEvent;
      try {
        parsed = JSON.parse(line) as CursorStreamEvent;
      } catch (error) {
        throw new Error(
          `Failed to parse Cursor NDJSON line: ${line}. ${String(error)}`,
        );
      }

      events.push(parsed);
      if (parsed.type === "result") {
        resultEvent = parsed;
      }

      if (onEvent) {
        await onEvent(parsed);
      }
    };

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        if (rejectDone) {
          rejectDone(error);
        }
      }
    };

    const succeed = (result: RunPromptResult): void => {
      if (!settled) {
        settled = true;
        if (resolveDone) {
          resolveDone(result);
        }
      }
    };

    const enqueueLine = (line: string): void => {
      processing = processing.then(() => processLine(line));
      processing.catch((error) => {
        child.kill("SIGKILL");
        fail(error as Error);
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        enqueueLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      fail(error);
    });

    child.on("close", (code) => {
      void (async () => {
        await processing;
        if (stdoutBuffer.trim().length > 0) {
          await processLine(stdoutBuffer);
        }

        if (!resultEvent) {
          const cleaned = stripAnsi(stderr).trim();
          throw new Error(
            `Cursor CLI exited without result event (exit=${code ?? 1}). ${cleaned}`.trim(),
          );
        }

        succeed({
          events,
          resultEvent,
          stderr,
          exitCode: code ?? 1,
        });
      })().catch((error) => {
        fail(error as Error);
      });
    });

    return await donePromise;
  }
}
