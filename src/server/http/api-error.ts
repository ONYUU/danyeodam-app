export const publicErrorCodes = [
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "GATE_CLOSED",
  "FORBIDDEN",
  "ACCOUNT_SUSPENDED",
  "POLICY_ACCEPTANCE_REQUIRED",
  "AGE_ATTESTATION_REQUIRED",
  "MINIMUM_AGE_ATTESTATION_REQUIRED",
  "LOCATION_CONSENT_REQUIRED",
  "LOCATION_USE_PAUSED",
  "LOCATION_WITHDRAWAL_PENDING",
  "LOCATION_CORRECTION_PENDING",
  "NOT_FOUND",
  "ALREADY_ACQUIRED_TODAY",
  "IDEMPOTENCY_CONFLICT",
  "MODERATION_CONFLICT",
  "RECOVERY_CONFLICT",
  "EMAIL_ALREADY_IN_USE",
  "QUOTA_EXCEEDED",
  "OUT_OF_RANGE",
  "LOW_ACCURACY",
  "SPOT_NOT_OPEN",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export type PublicErrorCode = (typeof publicErrorCodes)[number];

const statusByCode: Record<PublicErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  GATE_CLOSED: 403,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  POLICY_ACCEPTANCE_REQUIRED: 428,
  AGE_ATTESTATION_REQUIRED: 428,
  MINIMUM_AGE_ATTESTATION_REQUIRED: 428,
  LOCATION_CONSENT_REQUIRED: 428,
  LOCATION_USE_PAUSED: 403,
  LOCATION_WITHDRAWAL_PENDING: 409,
  LOCATION_CORRECTION_PENDING: 409,
  NOT_FOUND: 404,
  ALREADY_ACQUIRED_TODAY: 409,
  IDEMPOTENCY_CONFLICT: 409,
  MODERATION_CONFLICT: 409,
  RECOVERY_CONFLICT: 409,
  EMAIL_ALREADY_IN_USE: 409,
  QUOTA_EXCEEDED: 409,
  OUT_OF_RANGE: 422,
  LOW_ACCURACY: 422,
  SPOT_NOT_OPEN: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

const messageByCode: Record<PublicErrorCode, string> = {
  VALIDATION_FAILED: "요청 형식이 올바르지 않습니다.",
  UNAUTHORIZED: "인증이 필요합니다.",
  GATE_CLOSED: "현재는 초대된 참여자만 이용할 수 있습니다.",
  FORBIDDEN: "요청한 작업을 수행할 권한이 없습니다.",
  ACCOUNT_SUSPENDED: "공유 기능이 일시 중지된 계정입니다.",
  POLICY_ACCEPTANCE_REQUIRED: "현재 이용약관과 커뮤니티 가이드라인 동의가 필요합니다.",
  AGE_ATTESTATION_REQUIRED: "공유 콘텐츠를 보기 전에 연령 확인이 필요합니다.",
  MINIMUM_AGE_ATTESTATION_REQUIRED: "최소 연령 확인이 필요합니다.",
  LOCATION_CONSENT_REQUIRED: "현재 위치 이용 안내 동의가 필요합니다.",
  LOCATION_USE_PAUSED: "위치 이용이 일시 중지되어 있습니다.",
  LOCATION_WITHDRAWAL_PENDING: "위치정보 철회 처리가 진행 중입니다.",
  LOCATION_CORRECTION_PENDING: "위치정보 정정 처리가 진행 중입니다.",
  NOT_FOUND: "요청한 대상을 찾을 수 없습니다.",
  ALREADY_ACQUIRED_TODAY: "오늘 이 장소의 카드를 이미 획득했습니다.",
  IDEMPOTENCY_CONFLICT: "같은 요청 키가 이전 요청과 일치하지 않습니다.",
  MODERATION_CONFLICT: "현재 검수 상태에서는 요청한 작업을 수행할 수 없습니다.",
  RECOVERY_CONFLICT: "현재 계정에는 복구할 수 없는 기존 기록이 있습니다.",
  EMAIL_ALREADY_IN_USE: "이미 다른 계정에 연결된 이메일입니다.",
  QUOTA_EXCEEDED: "저장 한도를 초과했습니다.",
  OUT_OF_RANGE: "카드 스팟에 조금 더 가까이 이동해 주세요.",
  LOW_ACCURACY: "현재 위치 정확도가 낮습니다. 잠시 후 다시 시도해 주세요.",
  SPOT_NOT_OPEN: "현재 획득할 수 없는 카드 스팟입니다.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  INTERNAL: "처리 중 오류가 발생했습니다.",
};

export class ApiError extends Error {
  readonly code: PublicErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: PublicErrorCode, details?: Record<string, unknown>) {
    super(messageByCode[code]);
    this.name = "ApiError";
    this.code = code;
    this.status = statusByCode[code];
    this.details = details;
  }
}

export function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError("INTERNAL");
}
