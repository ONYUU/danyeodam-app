import "server-only";

import { z } from "zod";

import type { MinimumAgeAttestationInput } from "@/server/minimum-age/input";
import { getServiceClient } from "@/server/supabase/service";

const writeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("attested") }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

const readResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({
    status: z.literal("attested"),
    minimum_age_passed: z.literal(true),
    version: z.literal("18plus-v1"),
    attested_at: z.iso.datetime({ offset: true }),
  }).strict(),
]);

export type MinimumAgeWriteResult = z.infer<typeof writeResultSchema>;
export type MinimumAgeReadResult = z.infer<typeof readResultSchema>;

export class MinimumAgeRepositoryError extends Error {
  constructor() {
    super("Minimum-age repository operation failed");
    this.name = "MinimumAgeRepositoryError";
  }
}

async function rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient().schema("api_private").rpc(name, parameters);
  if (error !== null) throw new MinimumAgeRepositoryError();
  return data;
}

export async function recordMinimumAgeAttestation(input: {
  authUserId: string;
  attestation: MinimumAgeAttestationInput;
}): Promise<MinimumAgeWriteResult> {
  return writeResultSchema.parse(await rpc("record_minimum_age_attestation", {
    p_auth_user_id: input.authUserId,
    p_attestation: input.attestation,
  }));
}

export async function getMinimumAgeAttestation(
  authUserId: string,
): Promise<MinimumAgeReadResult> {
  return readResultSchema.parse(await rpc("get_minimum_age_attestation", {
    p_auth_user_id: authUserId,
  }));
}
