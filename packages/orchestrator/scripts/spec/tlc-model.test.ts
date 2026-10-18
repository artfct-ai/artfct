import { describe, expect, it } from "bun:test";
import { boundedSetupSource, readTypecheckedModule, tlcModel } from "./tlc-model";

const TYPECHECKED = `------------------------------- MODULE counter_tc -------------------------------

EXTENDS Integers, Sequences, FiniteSets, TLC, Apalache, Variants

VARIABLE
  (*
    @type: Int;
  *)
  counter_spec_count

VARIABLE
  (*
    @type: { reached: Bool };
  *)
  counter_spec_lastStepReached

(*
  @type: (() => Bool);
*)
q_inv ==
  counter_spec_countStaysSmall
    /\\ counter_spec_modelCheckingBound

(*
  @type: (() => Bool);
*)
counter_spec_init ==
  counter_spec_count' := 0
    /\\ counter_spec_lastStepReached' := [reached |-> FALSE]

(*
  @type: (() => Bool);
*)
q_init == counter_spec_init

(*
  @type: (() => Bool);
*)
q_step == counter_spec_step

================================================================================
`;

describe("boundedSetupSource", () => {
  it("adds the bound val inside the setup module", () => {
    const source = 'module counter {\n  import spec.* from "./spec"\n}\n';
    expect(boundedSetupSource(source, { count: 3, steps: 4 })).toBe(
      'module counter {\n  import spec.* from "./spec"\n  val modelCheckingBound: bool = and {\n    count <= 3,\n    steps <= 4,\n  }\n}\n',
    );
  });
});

describe("readTypecheckedModule", () => {
  it("reads the variables, the invariants, and an initial state without primes", () => {
    expect(readTypecheckedModule(TYPECHECKED)).toEqual({
      name: "counter_tc",
      variables: ["counter_spec_count", "counter_spec_lastStepReached"],
      invariants: ["counter_spec_countStaysSmall", "counter_spec_modelCheckingBound"],
      init: "  counter_spec_count := 0\n    /\\ counter_spec_lastStepReached := [reached |-> FALSE]",
    });
  });

  it("names a definition the module lacks", () => {
    expect(() => readTypecheckedModule(TYPECHECKED.replace("q_inv ==", "q_other =="))).toThrow(
      "The typechecked module does not define q_inv.",
    );
  });
});

describe("tlcModel", () => {
  it("checks each invariant within the bound and leaves ignored variables out of the view", () => {
    const model = tlcModel(readTypecheckedModule(TYPECHECKED), ["lastStepReached"]);
    expect(model.module).toBe(
      "---- MODULE MC ----\nEXTENDS counter_tc\n\nInit ==\n  counter_spec_count := 0\n    /\\ counter_spec_lastStepReached := [reached |-> FALSE]\n\nView == <<counter_spec_count, counter_spec_lastStepReached = counter_spec_lastStepReached>>\n\n====\n",
    );
    expect(model.config).toBe(
      "INIT Init\nNEXT q_step\nINVARIANT counter_spec_countStaysSmall\nCONSTRAINT counter_spec_modelCheckingBound\nVIEW View\n",
    );
  });

  it("leaves out the view when every variable counts", () => {
    const model = tlcModel(readTypecheckedModule(TYPECHECKED), []);
    expect(model.module).not.toContain("View");
    expect(model.config).not.toContain("VIEW");
  });

  it("names an ignored variable the module lacks", () => {
    expect(() => tlcModel(readTypecheckedModule(TYPECHECKED), ["history"])).toThrow(
      "The typechecked module does not have history.",
    );
  });
});
