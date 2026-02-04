import { AvailableCommand } from "@agentclientprotocol/sdk";
import { CursorAuthClient } from "./auth.js";
import { SessionModeId, SUPPORTED_MODE_IDS } from "./settings.js";

export interface CursorModelDescriptor {
  modelId: string;
  name: string;
  current?: boolean;
}

export interface SlashSessionState {
  modelId?: string;
  modeId: SessionModeId;
}

export interface SlashCommandContext {
  session: SlashSessionState;
  auth: CursorAuthClient;
  listModels: () => Promise<CursorModelDescriptor[]>;
  onModeChanged?: (modeId: SessionModeId) => Promise<void>;
}

export interface SlashCommandResult {
  handled: boolean;
  responseText?: string;
}

export function availableSlashCommands(): AvailableCommand[] {
  return [
    { name: "help", description: "Show adapter slash commands", input: null },
    {
      name: "model",
      description: "Get or set active model",
      input: { hint: "<model-id>" },
    },
    {
      name: "mode",
      description: "Get or set active mode",
      input: { hint: "<mode-id>" },
    },
    { name: "login", description: "Sign in via Cursor CLI", input: null },
    { name: "logout", description: "Sign out via Cursor CLI", input: null },
    { name: "status", description: "Show login status", input: null },
  ];
}

export function parseModelListOutput(output: string): CursorModelDescriptor[] {
  const models: CursorModelDescriptor[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(" - ")) {
      continue;
    }

    const [idPart, rest] = trimmed.split(/\s+-\s+/, 2);
    if (!idPart || !rest) {
      continue;
    }

    const current = /\(current\)/i.test(rest);
    const name = rest.replace(/\(current\)/gi, "").trim();

    models.push({
      modelId: idPart.trim(),
      name,
      current,
    });
  }

  return models;
}

function normalizeModeId(value: string): SessionModeId | null {
  if (SUPPORTED_MODE_IDS.includes(value as SessionModeId)) {
    return value as SessionModeId;
  }
  return null;
}

export async function handleSlashCommand(
  command: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const normalized = command.toLowerCase();

  switch (normalized) {
    case "help":
      return {
        handled: true,
        responseText:
          "Supported commands: /help, /model [id], /mode [id], /status, /login, /logout",
      };

    case "status": {
      const status = await context.auth.status();
      if (status.loggedIn) {
        return {
          handled: true,
          responseText: `Logged in as ${status.account}`,
        };
      }
      return { handled: true, responseText: "Not logged in" };
    }

    case "login": {
      const statusBefore = await context.auth.status();
      if (statusBefore.loggedIn) {
        return {
          handled: true,
          responseText: `Already logged in as ${statusBefore.account}`,
        };
      }

      await context.auth.login();
      const statusAfter = await context.auth.status();
      if (statusAfter.loggedIn) {
        return {
          handled: true,
          responseText: `Logged in as ${statusAfter.account}`,
        };
      }
      return {
        handled: true,
        responseText: "Login did not complete successfully",
      };
    }

    case "logout": {
      await context.auth.logout();
      return { handled: true, responseText: "Logged out" };
    }

    case "model": {
      const target = args.trim();
      const models = await context.listModels();

      if (!target) {
        const current =
          context.session.modelId ??
          models.find((m) => m.current)?.modelId ??
          "auto";
        return {
          handled: true,
          responseText: `Current model: ${current}\nAvailable: ${models
            .map((m) => m.modelId)
            .join(", ")}`,
        };
      }

      const match = models.find((m) => m.modelId === target);
      if (!match) {
        return {
          handled: true,
          responseText: `Unknown model: ${target}. Available: ${models
            .map((m) => m.modelId)
            .join(", ")}`,
        };
      }

      context.session.modelId = match.modelId;
      return { handled: true, responseText: `Model set to ${match.modelId}` };
    }

    case "mode": {
      const target = args.trim();
      if (!target) {
        return {
          handled: true,
          responseText: `Current mode: ${context.session.modeId}\nAvailable: ${SUPPORTED_MODE_IDS.join(", ")}`,
        };
      }

      const nextMode = normalizeModeId(target);
      if (!nextMode) {
        return {
          handled: true,
          responseText: `Unknown mode: ${target}. Available: ${SUPPORTED_MODE_IDS.join(", ")}`,
        };
      }

      context.session.modeId = nextMode;
      if (context.onModeChanged) {
        await context.onModeChanged(nextMode);
      }
      return { handled: true, responseText: `Mode set to ${nextMode}` };
    }

    default:
      return { handled: false };
  }
}
