import { generateText } from "ai";
import { beforeEach, describe, expect, it } from "bun:test";
import { EchoModel, SilentModel } from "../../../test/fake-model";
import { withRequestTimeout } from "./request-timeout";

describe("withRequestTimeout", () => {
  describe("a request under a short timeout", () => {
    let echo: EchoModel;

    beforeEach(async () => {
      echo = new EchoModel("hi");
      await generateText({ model: withRequestTimeout(echo, 10), prompt: "hello" });
    });

    it("leaves the signal open while the request runs", () => {
      expect(echo.signals[0]?.aborted).toBe(false);
    });

    describe("once the timeout passes after the request answered", () => {
      beforeEach(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      it("leaves the settled request alone", () => {
        expect(echo.signals[0]?.aborted).toBe(false);
      });
    });
  });

  describe("a caller that brought its own signal", () => {
    let echo: EchoModel;
    let controller: AbortController;

    beforeEach(async () => {
      echo = new EchoModel("hi");
      controller = new AbortController();
      await generateText({
        model: withRequestTimeout(echo, 10_000),
        prompt: "hello",
        abortSignal: controller.signal,
      });
    });

    it("leaves the signal open while the request runs", () => {
      expect(echo.signals[0]?.aborted).toBe(false);
    });

    describe("once the caller aborts", () => {
      beforeEach(() => {
        controller.abort(new Error("turn over"));
      });

      it("aborts the request too", () => {
        expect(echo.signals[0]?.aborted).toBe(true);
      });
    });
  });

  describe("a model that never answers", () => {
    let failure: unknown;

    beforeEach(async () => {
      failure = await generateText({
        model: withRequestTimeout(new SilentModel(), 10),
        prompt: "hello",
        maxRetries: 0,
      }).catch((error: unknown) => error);
    });

    it("gives up on the request", () => {
      expect(failure).toBeInstanceOf(Error);
    });
  });
});
