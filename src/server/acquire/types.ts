import type { PublicErrorCode } from "@/server/http/api-error";
import type { LocalizedText } from "@/server/localization/schema";

export type InternalCard = {
  id: string;
  title: LocalizedText;
  sketch_path: string;
  color_hex: string;
};

export type InternalAcquisition = {
  id: string;
  spot_id: string;
  card_id: string;
  acquisition_type: "field";
  acquired_at: string;
  acquired_on_kst: string;
};

export type ReadyContext = {
  status: "ready";
  user_id: string;
  spot: {
    id: string;
    latitude: number;
    longitude: number;
    radius_m: number;
    accuracy_threshold_m: number;
    updated_at: string;
  };
  card: InternalCard;
};

export type ReplayResult = {
  status: "replay";
  acquisition: InternalAcquisition;
  card: InternalCard;
};

export type CreatedResult = {
  status: "created";
  acquisition: InternalAcquisition;
  card: InternalCard;
};

export type DatabaseErrorCode = Extract<
  PublicErrorCode,
  | "UNAUTHORIZED"
  | "GATE_CLOSED"
  | "NOT_FOUND"
  | "SPOT_NOT_OPEN"
  | "IDEMPOTENCY_CONFLICT"
  | "ALREADY_ACQUIRED_TODAY"
  | "MINIMUM_AGE_ATTESTATION_REQUIRED"
  | "LOCATION_CONSENT_REQUIRED"
  | "LOCATION_USE_PAUSED"
  | "LOCATION_WITHDRAWAL_PENDING"
  | "LOCATION_CORRECTION_PENDING"
  | "OUT_OF_RANGE"
  | "LOW_ACCURACY"
> | "SPOT_CONFIG_CHANGED";

export type DatabaseErrorResult = {
  status: "error";
  code: DatabaseErrorCode;
  details?: Record<string, unknown>;
  expected_user_id?: string;
};

export type ContextResult = ReadyContext | ReplayResult | DatabaseErrorResult;
export type CommitResult = CreatedResult | ReplayResult | DatabaseErrorResult;

export type AcquireFailureCode =
  | "OUT_OF_RANGE"
  | "LOW_ACCURACY"
  | "ALREADY_ACQUIRED_TODAY"
  | "SPOT_NOT_OPEN"
  | "GATE_CLOSED";

export type AcquireFailurePayload =
  | { code: "LOW_ACCURACY"; details: { retry: true } }
  | { code: "OUT_OF_RANGE"; details: { distance_band: "near" | "far" } }
  | {
    code: "ALREADY_ACQUIRED_TODAY" | "SPOT_NOT_OPEN" | "GATE_CLOSED";
    details: Record<string, never>;
  };

export type StoredFailureResult = AcquireFailurePayload & {
  status: "failed";
};

export type RecordFailureResult =
  | StoredFailureResult
  | ReplayResult
  | DatabaseErrorResult;

export type AcquireRepository = {
  getContext(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    publicGateOpen: boolean;
    expectedUserId?: string;
  }): Promise<ContextResult>;
  commit(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    publicGateOpen: boolean;
    expectedSpotUpdatedAt: string;
    expectedUserId: string;
  }): Promise<CommitResult>;
  recordFailure(input: {
    authUserId: string;
    spotId: string;
    idempotencyKey: string;
    expectedUserId: string;
  } & AcquireFailurePayload): Promise<RecordFailureResult>;
};

export type PublicAcquireBody = {
  acquisition: {
    id: string;
    spot_id: string;
    card_id: string;
    type: "field";
    acquired_at: string;
  };
  card: {
    id: string;
    title: LocalizedText;
    image_url: string;
    color_hex: string;
  };
  back: {
    date_kst: string;
  };
};
