/** The display name of a workflow a trigger fired, from its definition's name: `dependency-upgrades` is "Dependency upgrades". */
export function triggeredWorkflowName(definition: string): string {
  const words = definition.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The chat message a firing posts in its channel. Its thread is where the workflow replies. */
export function startLineText(definition: string): string {
  return `Starting ${triggeredWorkflowName(definition).toLowerCase()}.`;
}

/** The reply a firing posts in its thread once its last attempt failed. */
export function failureLineText(definition: string): string {
  return `${triggeredWorkflowName(definition)} could not start. The error is in the orchestrator's logs.`;
}
