/** The most store statements one action may run. A settled action runs a few hundred at most. */
export const ACTION_WORK_BUDGET = 5_000;

/** Stop an action that ran past its work budget, as a violation of the budget invariant. */
export function exceededWorkBudget(action: string, work: number): never {
  throw new Error(
    `everyActionSettlesWithinItsWorkBudget: ${action} ran ${work} store statements, past the budget of ${ACTION_WORK_BUDGET}`,
  );
}
