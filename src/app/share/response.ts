import { discardPublicShareResponseBody } from "@/app/share/request";
import {
  parsePublicShareReportReceipt,
  parseResolvedPublicShare,
  type ResolvedPublicShare,
} from "@/app/share/transport";

export type PublicShareResolution =
  | { kind: "age" }
  | { kind: "unavailable" }
  | { kind: "resolved"; share: ResolvedPublicShare };

function isJson(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0] === "application/json";
}

export async function consumePublicShareResolveResponse(
  response: Response,
): Promise<PublicShareResolution> {
  if (response.status === 428) {
    await discardPublicShareResponseBody(response);
    return { kind: "age" };
  }
  if (response.status !== 200 || !isJson(response)) {
    await discardPublicShareResponseBody(response);
    return { kind: "unavailable" };
  }
  const resolved = parseResolvedPublicShare(await response.json());
  return resolved === null
    ? { kind: "unavailable" }
    : { kind: "resolved", share: resolved };
}

export async function consumePublicSharePhotoResponse(response: Response): Promise<Blob | null> {
  if (
    response.status !== 200
    || response.headers.get("content-type")?.split(";", 1)[0] !== "image/webp"
  ) {
    await discardPublicShareResponseBody(response);
    return null;
  }
  const body = await response.blob();
  return body.size > 0 && body.type === "image/webp" ? body : null;
}

export async function consumePublicShareReportResponse(response: Response): Promise<boolean> {
  if (response.status !== 202 || !isJson(response)) {
    await discardPublicShareResponseBody(response);
    return false;
  }
  return parsePublicShareReportReceipt(await response.json()) !== null;
}

export async function consumePublicShareAgeResponse(response: Response): Promise<boolean> {
  if (response.status !== 204) {
    await discardPublicShareResponseBody(response);
    return false;
  }
  return true;
}
