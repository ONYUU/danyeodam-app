import { ApiError } from "@/server/http/api-error";

const jsonContentType = "application/json";

export async function readLimitedJson(
  request: Request,
  maximumBytes = 4_096,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== jsonContentType) {
    throw new ApiError("VALIDATION_FAILED");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new ApiError("VALIDATION_FAILED");
    }
  }

  if (request.body === null) {
    throw new ApiError("VALIDATION_FAILED");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteCount = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteCount += value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel();
        throw new ApiError("VALIDATION_FAILED");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("VALIDATION_FAILED");
  } finally {
    reader.releaseLock();
  }
}
