import "server-only";

import {
  commitResultSchema,
  contextResultSchema,
  recordFailureResultSchema,
} from "@/server/acquire/db-contract";
import type {
  AcquireRepository,
  CommitResult,
  ContextResult,
} from "@/server/acquire/types";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

class AcquireRepositoryError extends Error {
  constructor() {
    super("Acquire repository operation failed");
    this.name = "AcquireRepositoryError";
  }
}

export class SupabaseAcquireRepository implements AcquireRepository {
  async getContext(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    publicGateOpen: boolean;
    expectedUserId?: string;
  }): Promise<ContextResult> {
    const parameters: Record<string, unknown> = {
      p_auth_user_id: input.authUserId,
      p_spot_id: input.spotId,
      p_idempotency_key: input.idempotencyKey,
      p_public_gate_open: input.publicGateOpen,
    };
    if (input.expectedUserId !== undefined) {
      parameters.p_expected_user_id = input.expectedUserId;
    }
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc(
        input.expectedUserId === undefined
          ? "acquire_context"
          : "acquire_context_continuation",
        parameters,
      );

    if (error !== null) {
      throw new AcquireRepositoryError();
    }
    throwIfAuthenticatedRateLimited(data);
    return contextResultSchema.parse(data);
  }

  async commit(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    publicGateOpen: boolean;
    expectedSpotUpdatedAt: string;
    expectedUserId: string;
  }): Promise<CommitResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("acquire_commit", {
        p_auth_user_id: input.authUserId,
        p_spot_id: input.spotId,
        p_idempotency_key: input.idempotencyKey,
        p_public_gate_open: input.publicGateOpen,
        p_expected_spot_updated_at: input.expectedSpotUpdatedAt,
        p_expected_user_id: input.expectedUserId,
      });

    if (error !== null) {
      throw new AcquireRepositoryError();
    }
    return commitResultSchema.parse(data);
  }

  async recordFailure(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    expectedUserId: string;
    code: "OUT_OF_RANGE" | "LOW_ACCURACY" | "ALREADY_ACQUIRED_TODAY" | "SPOT_NOT_OPEN" | "GATE_CLOSED";
    details: Record<string, unknown>;
  }) {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("record_acquire_failure", {
        p_auth_user_id: input.authUserId,
        p_spot_id: input.spotId,
        p_idempotency_key: input.idempotencyKey,
        p_code: input.code,
        p_details: input.details,
        p_expected_user_id: input.expectedUserId,
      });

    if (error !== null) {
      throw new AcquireRepositoryError();
    }
    return recordFailureResultSchema.parse(data);
  }
}
