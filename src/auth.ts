import { spawn } from "node:child_process";
import { stripAnsi } from "./utils.js";

type Environment = Record<string, string | undefined>;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(
    args: string[],
    options?: { cwd?: string; env?: Environment },
  ): Promise<CommandResult>;
}

export class AgentCommandRunner implements CommandRunner {
  constructor(private readonly command: string = "agent") {}

  async run(
    args: string[],
    options?: { cwd?: string; env?: Environment },
  ): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.command, args, {
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
}

export type ParsedAuthStatus =
  | { loggedIn: true; account: string; raw: string }
  | { loggedIn: false; raw: string };

export function parseAuthStatus(output: string): ParsedAuthStatus {
  const clean = stripAnsi(output);
  const normalized = clean.replace(/\r/g, "\n");
  const loggedInMatch = normalized.match(/Logged in as\s+([^\n]+)/i);
  if (loggedInMatch) {
    return {
      loggedIn: true,
      account: loggedInMatch[1].trim(),
      raw: clean,
    };
  }

  if (/Not logged in/i.test(normalized)) {
    return {
      loggedIn: false,
      raw: clean,
    };
  }

  // Conservative fallback: treat unknown status as not logged in.
  return {
    loggedIn: false,
    raw: clean,
  };
}

export interface CursorAuthClient {
  status(): Promise<ParsedAuthStatus>;
  login(): Promise<CommandResult>;
  logout(): Promise<CommandResult>;
  ensureLoggedIn(): Promise<ParsedAuthStatus>;
}

export class CursorAuth implements CursorAuthClient {
  constructor(
    private readonly runner: CommandRunner = new AgentCommandRunner(),
  ) {}

  async status(): Promise<ParsedAuthStatus> {
    const result = await this.runner.run(["status"]);
    return parseAuthStatus(`${result.stdout}\n${result.stderr}`);
  }

  async login(): Promise<CommandResult> {
    return await this.runner.run(["login"]);
  }

  async logout(): Promise<CommandResult> {
    return await this.runner.run(["logout"]);
  }

  async ensureLoggedIn(): Promise<ParsedAuthStatus> {
    const current = await this.status();
    if (current.loggedIn) {
      return current;
    }

    await this.login();
    return await this.status();
  }
}
