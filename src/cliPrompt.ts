// ANSI cursor movement must account for the prompt title plus every choice row.
// Keeping this pure makes the interactive renderer geometry regression-testable.
export function arrowSelectCursorRows(choiceCount: number): number {
  return Math.max(1, choiceCount + 1);
}
