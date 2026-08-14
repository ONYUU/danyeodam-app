import { requireBearerToken } from "@/server/auth/bearer-token";
import { verifyAccessToken } from "@/server/auth/verify-access-token";

export async function verifyOptionalAccessToken(request: Request): Promise<string | null> {
  if (request.headers.get("authorization") === null) {
    return null;
  }
  return verifyAccessToken(requireBearerToken(request));
}
