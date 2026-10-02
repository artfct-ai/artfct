import { describe, expect, it } from "bun:test";
import { bridgeTokenHeaders, bridgeTokenOf } from "./bridge-token";

describe("bridgeTokenOf", () => {
  it("reads the token the dial headers carry", () => {
    expect(bridgeTokenOf(new Headers(bridgeTokenHeaders("secret")))).toBe("secret");
  });

  it("is null for a dial without the header", () => {
    expect(bridgeTokenOf(new Headers())).toBeNull();
  });

  it("is null for a header of another scheme", () => {
    expect(bridgeTokenOf(new Headers({ authorization: "Basic secret" }))).toBeNull();
  });
});
