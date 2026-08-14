import { ApiError } from "@/server/http/api-error";

const bearerPattern = /^Bearer ([A-Za-z0-9._~-]+)$/;

export function requireBearerToken(request: Request): string {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(bearerPattern);
  if (match === undefined || match === null) {
    throw new ApiError("UNAUTHORIZED");
  }
  return match[1];
}
