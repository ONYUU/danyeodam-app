import type { AcquireInput } from "@/server/acquire/input";
import {
  distanceBand,
  distanceMeters,
  effectiveAcquisitionRadius,
} from "@/server/acquire/location";
import type {
  AcquireFailurePayload,
  AcquireRepository,
  CreatedResult,
  InternalAcquisition,
  InternalCard,
  PublicAcquireBody,
  ReplayResult,
} from "@/server/acquire/types";
import { ApiError, type PublicErrorCode } from "@/server/http/api-error";

type AcquireServiceDependencies = {
  repository: AcquireRepository;
};

export type AcquireServiceOutcome = {
  status: 200 | 201;
  body: PublicAcquireBody;
};

function projectSuccess(
  acquisition: InternalAcquisition,
  card: InternalCard,
): PublicAcquireBody {
  return {
    acquisition: {
      id: acquisition.id,
      spot_id: acquisition.spot_id,
      card_id: acquisition.card_id,
      type: "field",
      acquired_at: acquisition.acquired_at,
    },
    card: {
      id: card.id,
      title: card.title,
      image_url: `/api/card-assets/${card.id}`,
      color_hex: card.color_hex,
    },
    back: {
      date_kst: acquisition.acquired_on_kst,
    },
  };
}

function databaseErrorToApiError(
  code: PublicErrorCode | "SPOT_CONFIG_CHANGED",
  details?: Record<string, unknown>,
): ApiError {
  return code === "SPOT_CONFIG_CHANGED"
    ? new ApiError("INTERNAL")
    : new ApiError(code, details);
}

function shouldRecordFailure(code: string): code is AcquireFailurePayload["code"] {
  return [
    "OUT_OF_RANGE",
    "LOW_ACCURACY",
    "ALREADY_ACQUIRED_TODAY",
    "SPOT_NOT_OPEN",
    "GATE_CLOSED",
  ].includes(code);
}

function terminalFailurePayload(
  code: AcquireFailurePayload["code"],
  details?: Record<string, unknown>,
): AcquireFailurePayload {
  if (code === "LOW_ACCURACY") {
    if (details?.retry !== true || Object.keys(details).length !== 1) {
      throw new ApiError("INTERNAL");
    }
    return { code, details: { retry: true } };
  }
  if (code === "OUT_OF_RANGE") {
    const distanceBandValue = details?.distance_band;
    if (
      (distanceBandValue !== "near" && distanceBandValue !== "far")
      || Object.keys(details ?? {}).length !== 1
    ) {
      throw new ApiError("INTERNAL");
    }
    return { code, details: { distance_band: distanceBandValue } };
  }
  if (details !== undefined && Object.keys(details).length !== 0) {
    throw new ApiError("INTERNAL");
  }
  return { code, details: {} };
}

async function recordTerminalFailure(
  dependencies: AcquireServiceDependencies,
  input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    expectedUserId: string;
  } & AcquireFailurePayload,
): Promise<AcquireServiceOutcome> {
  let result: Awaited<ReturnType<AcquireRepository["recordFailure"]>>;
  try {
    result = await dependencies.repository.recordFailure(input);
  } catch {
    throw new ApiError("INTERNAL");
  }

  if (result.status === "replay") {
    return successOutcome(result);
  }
  if (result.status === "failed") {
    throw new ApiError(result.code, result.details);
  }
  throw databaseErrorToApiError(result.code, result.details);
}

function successOutcome(result: CreatedResult | ReplayResult): AcquireServiceOutcome {
  return {
    status: result.status === "created" ? 201 : 200,
    body: projectSuccess(result.acquisition, result.card),
  };
}

export async function acquireCard(
  input: AcquireInput,
  context: {
    authUserId: string;
    publicGateOpen: boolean;
  },
  dependencies: AcquireServiceDependencies,
): Promise<AcquireServiceOutcome> {
  let expectedUserId: string | undefined;
  for (let configurationAttempt = 0; configurationAttempt < 2; configurationAttempt += 1) {
    const acquisitionContext = await dependencies.repository.getContext({
      authUserId: context.authUserId,
      spotId: input.spot_id,
      idempotencyKey: input.idempotency_key,
      publicGateOpen: context.publicGateOpen,
      expectedUserId,
    });

    if (acquisitionContext.status === "replay") {
      return successOutcome(acquisitionContext);
    }

    if (acquisitionContext.status === "error") {
      if (shouldRecordFailure(acquisitionContext.code)) {
        if (acquisitionContext.expected_user_id === undefined) {
          throw new ApiError("INTERNAL");
        }
        return recordTerminalFailure(dependencies, {
          authUserId: context.authUserId,
          spotId: input.spot_id,
          idempotencyKey: input.idempotency_key,
          expectedUserId: acquisitionContext.expected_user_id,
          ...terminalFailurePayload(
            acquisitionContext.code,
            acquisitionContext.details,
          ),
        });
      }
      throw databaseErrorToApiError(
        acquisitionContext.code,
        acquisitionContext.details,
      );
    }

    expectedUserId = acquisitionContext.user_id;

    if (input.accuracy > acquisitionContext.spot.accuracy_threshold_m) {
      return recordTerminalFailure(dependencies, {
        authUserId: context.authUserId,
        spotId: input.spot_id,
        idempotencyKey: input.idempotency_key,
        expectedUserId,
        code: "LOW_ACCURACY",
        details: { retry: true },
      });
    }

    const measuredDistance = distanceMeters(
      { latitude: input.lat, longitude: input.lng },
      {
        latitude: acquisitionContext.spot.latitude,
        longitude: acquisitionContext.spot.longitude,
      },
    );
    const allowedRadius = effectiveAcquisitionRadius(
      acquisitionContext.spot.radius_m,
      input.accuracy,
      acquisitionContext.spot.accuracy_threshold_m,
    );

    if (measuredDistance > allowedRadius) {
      return recordTerminalFailure(dependencies, {
        authUserId: context.authUserId,
        spotId: input.spot_id,
        idempotencyKey: input.idempotency_key,
        expectedUserId,
        code: "OUT_OF_RANGE",
        details: {
          distance_band: distanceBand(measuredDistance, allowedRadius),
        },
      });
    }

    const commitResult = await dependencies.repository.commit({
      authUserId: context.authUserId,
      spotId: input.spot_id,
      idempotencyKey: input.idempotency_key,
      publicGateOpen: context.publicGateOpen,
      expectedSpotUpdatedAt: acquisitionContext.spot.updated_at,
      expectedUserId,
    });

    if (commitResult.status === "created" || commitResult.status === "replay") {
      return successOutcome(commitResult);
    }

    if (commitResult.code === "SPOT_CONFIG_CHANGED") {
      continue;
    }

    if (shouldRecordFailure(commitResult.code)) {
      return recordTerminalFailure(dependencies, {
        authUserId: context.authUserId,
        spotId: input.spot_id,
        idempotencyKey: input.idempotency_key,
        expectedUserId,
        ...terminalFailurePayload(commitResult.code, commitResult.details),
      });
    }
    throw databaseErrorToApiError(commitResult.code, commitResult.details);
  }

  throw new ApiError("INTERNAL");
}
