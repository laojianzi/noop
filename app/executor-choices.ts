export type Executor = "claude" | "codex";

export const EXECUTOR_CHOICES: Executor[][] = [["claude"], ["codex", "claude"], ["claude", "codex"], ["codex"]];
export const INTERNAL_SELECTION_ERROR = "clis.internal must be one of the four executor selections";

export function invalidInternalSelection(clis: { internal?: unknown } | undefined): boolean {
  const value = clis?.internal;
  return value !== undefined && (!Array.isArray(value) ||
    !EXECUTOR_CHOICES.some(choice => choice.length === value.length && choice.every((cli, index) => cli === value[index])));
}
