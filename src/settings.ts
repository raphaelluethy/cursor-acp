export const ADAPTER_NAME = "cursor-acp";

export const SUPPORTED_MODE_IDS = [
  "default",
  "acceptEdits",
  "plan",
  "ask",
  "bypassPermissions",
] as const;

export type SessionModeId = (typeof SUPPORTED_MODE_IDS)[number];

export const DEFAULT_MODE_ID: SessionModeId = "default";

export function parseDefaultMode(): SessionModeId {
  const value = process.env.CURSOR_ACP_DEFAULT_MODE;
  if (!value) {
    return DEFAULT_MODE_ID;
  }
  if (SUPPORTED_MODE_IDS.includes(value as SessionModeId)) {
    return value as SessionModeId;
  }
  return DEFAULT_MODE_ID;
}

export function parseDefaultModel(): string | undefined {
  const value = process.env.CURSOR_ACP_DEFAULT_MODEL;
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function availableModes(currentModeId: SessionModeId) {
  return {
    currentModeId,
    availableModes: [
      {
        id: "default",
        name: "Default",
        description:
          "Standard behavior with adapter-mediated permission retries",
      },
      {
        id: "acceptEdits",
        name: "Accept Edits",
        description: "Like default, but intended for edit-friendly workflows",
      },
      {
        id: "plan",
        name: "Plan",
        description: "Run Cursor CLI in plan mode",
      },
      {
        id: "ask",
        name: "Ask",
        description: "Run Cursor CLI in ask mode",
      },
      {
        id: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Always run with --force",
      },
    ],
  };
}
