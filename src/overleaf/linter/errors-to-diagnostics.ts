// Tipo compartido con latex-linter.worker.ts (de Overleaf, AGPL-3.0).
export type LintError = {
  startPos: number;
  endPos: number;
  pos: number;
  suppressIfEditing?: boolean;
  type: "info" | "warning" | "error";
  text: string;
};
