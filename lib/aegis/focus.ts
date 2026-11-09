/** First in scope control that is still incomplete, in catalog order. */
export function firstIncompleteControlId(controls: ReadonlyArray<{ id: string; complete: boolean }>): string | null {
  return controls.find((control) => !control.complete)?.id ?? null;
}
