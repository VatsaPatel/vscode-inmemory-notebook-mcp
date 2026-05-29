import { BridgeRequest, BridgeResponse } from "../common/types.js";
import { serializeError } from "../common/errors.js";
import { BackendParams, handleNotebookRequest } from "./notebookBackend.js";

export async function handleBridgeRequest(request: BridgeRequest): Promise<BridgeResponse> {
  try {
    const result = await handleNotebookRequest(request.method, request.params as BackendParams);
    return {
      id: request.id,
      ok: true,
      result
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: serializeError(error)
    };
  }
}
