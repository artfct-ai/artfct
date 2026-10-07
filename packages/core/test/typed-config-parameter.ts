import type { registerConfig } from "@artfct-ai/core/orchestrator";

type IsAny<Type> = 0 extends 1 & Type ? true : false;

export const configParameterIsAny: IsAny<Parameters<typeof registerConfig>[0]> = false;
