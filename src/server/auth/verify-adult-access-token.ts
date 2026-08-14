import "server-only";

import { requireAdultActiveIdentity } from "@/server/auth/adult-active";
import {
  verifyAccessToken,
  verifyAccessTokenUser,
  type VerifiedAuthUser,
} from "@/server/auth/verify-access-token";

export async function verifyAdultAccessToken(token: string): Promise<string> {
  const authUserId = await verifyAccessToken(token);
  await requireAdultActiveIdentity(authUserId);
  return authUserId;
}

export async function verifyAdultAccessTokenUser(token: string): Promise<VerifiedAuthUser> {
  const user = await verifyAccessTokenUser(token);
  await requireAdultActiveIdentity(user.id);
  return user;
}
