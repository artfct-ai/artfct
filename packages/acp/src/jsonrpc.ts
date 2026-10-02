/** JSON-RPC 2.0 message builders and guards for ACP, over the SDK's wire types. */
import type {
  AnyMessage,
  AnyNotification,
  AnyRequest,
  AnyResponse,
  ErrorResponse,
  JsonRpcId as SdkJsonRpcId,
} from "@agentclientprotocol/sdk";

export type JsonRpcId = SdkJsonRpcId;
export type JsonRpcRequest = AnyRequest;
export type JsonRpcNotification = AnyNotification;
export type JsonRpcError = ErrorResponse;
export type JsonRpcResponse = AnyResponse;
export type JsonRpcMessage = AnyMessage;

export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !("id" in message) && "method" in message;
}

/** Parse one line of JSON. Returns null for anything that is not a JSON-RPC 2.0 message. */
export function parseMessage(text: string): JsonRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isJsonRpcEnvelope(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") return false;
  const hasMethod = typeof record.method === "string";
  const hasId = "id" in record;
  if (hasMethod) return true;
  return hasId && ("result" in record || "error" in record);
}

export function jsonRpcRequest(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

export function jsonRpcNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function jsonRpcResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The result of a response, or undefined when it carries an error. */
export function resultOf(message: JsonRpcResponse): unknown {
  return "result" in message ? message.result : undefined;
}

/** The error of a response, or undefined when it carries a result. */
export function errorOf(message: JsonRpcResponse): JsonRpcError | undefined {
  return "error" in message ? message.error : undefined;
}
