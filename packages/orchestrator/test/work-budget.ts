/** The most store statements one step of the workflow world may run. A settled step runs a few hundred at most. */
export const ACTION_WORK_BUDGET = 5_000;

/** Stop a step of the workflow world that ran past its work budget. */
export function exceededWorkBudget(action: string, work: number): never {
  throw new Error(
    `work budget: ${action} ran ${work} store statements, past the budget of ${ACTION_WORK_BUDGET}`,
  );
}
