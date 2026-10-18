import type { TlcBounds } from "./checks";

/** The val a bounded setup adds. TLC reads it as the state constraint. */
export const TLC_BOUND_VAL = "modelCheckingBound";

/** What TLC needs from the module that Apalache wrote for a setup. */
export type TypecheckedModule = {
  name: string;
  variables: string[];
  invariants: string[];
  init: string;
};

/** The TLC model module and its config. */
export type TlcModel = { module: string; config: string };

/** The name TLC knows the model module by. */
export const TLC_MODEL_MODULE = "MC";

/** A setup's source with a val that holds while every counter stays within its cap. */
export function boundedSetupSource(source: string, bounds: TlcBounds): string {
  const moduleEnd = source.lastIndexOf("}");
  const caps = Object.entries(bounds).map(([counter, cap]) => `    ${counter} <= ${cap},\n`);
  const bound = `  val ${TLC_BOUND_VAL}: bool = and {\n${caps.join("")}  }\n`;
  return `${source.slice(0, moduleEnd)}${bound}${source.slice(moduleEnd)}`;
}

function definitionBody(tla: string, name: string): string {
  const match = new RegExp(`^${name} ==\\n?([\\s\\S]*?)\\n\\n`, "m").exec(tla);
  if (!match?.[1]) throw new Error(`The typechecked module does not define ${name}.`);
  return match[1];
}

/** Reads the variables, the invariants, and the initial state of a typechecked module. */
export function readTypecheckedModule(tla: string): TypecheckedModule {
  const name = /^-+ MODULE (\w+) -+$/m.exec(tla)?.[1];
  if (!name) throw new Error("The typechecked module does not name itself.");
  const variables = [...tla.matchAll(/^VARIABLE\n(?:\s*\(\*[\s\S]*?\*\)\n)?\s*(\w+)\s*$/gm)].map(
    (match) => match[1] ?? "",
  );
  const invariants = definitionBody(tla, "q_inv")
    .split("/\\")
    .map((conjunct) => conjunct.trim());
  const init = variables.reduce(
    (body, variable) => body.replaceAll(`${variable}'`, variable),
    definitionBody(tla, definitionBody(tla, "q_init").trim()),
  );
  return { name, variables, invariants, init };
}

function tlaNameOf(names: string[], quintName: string): string {
  const match = names.find((name) => name === quintName || name.endsWith(`_${quintName}`));
  if (!match) throw new Error(`The typechecked module does not have ${quintName}.`);
  return match;
}

/**
 * The model that checks every invariant of a module within its bound, ignoring some variables.
 * Each ignored variable enters the view as a comparison with itself. The comparison is always
 * true, and it makes TLC normalize the variable's variants before it writes the state to disk.
 */
export function tlcModel(checked: TypecheckedModule, ignoredVariables: string[]): TlcModel {
  const bound = tlaNameOf(checked.invariants, TLC_BOUND_VAL);
  const ignored = ignoredVariables.map((variable) => tlaNameOf(checked.variables, variable));
  const viewed = checked.variables.filter((variable) => !ignored.includes(variable));
  const invariants = checked.invariants.filter((invariant) => invariant !== bound);
  const normalized = ignored.map((variable) => `${variable} = ${variable}`);
  const view =
    ignored.length > 0 ? [`View == <<${[...viewed, ...normalized].join(", ")}>>`, ""] : [];
  const module = [
    `---- MODULE ${TLC_MODEL_MODULE} ----`,
    `EXTENDS ${checked.name}`,
    "",
    `Init ==\n${checked.init}`,
    "",
    ...view,
    "====",
    "",
  ].join("\n");
  const config = [
    "INIT Init",
    "NEXT q_step",
    ...invariants.map((invariant) => `INVARIANT ${invariant}`),
    `CONSTRAINT ${bound}`,
    ...(ignored.length > 0 ? ["VIEW View"] : []),
    "",
  ].join("\n");
  return { module, config };
}
