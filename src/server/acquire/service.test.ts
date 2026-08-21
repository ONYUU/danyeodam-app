import { describe, expect, it, vi } from "vitest";

import type { AcquireInput } from "@/server/acquire/input";
import { acquireCard } from "@/server/acquire/service";
import type {
  AcquireRepository,
  ContextResult,
  CommitResult,
  InternalAcquisition,
  InternalCard,
  RecordFailureResult,
} from "@/server/acquire/types";

const authUserId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const spotId = "00000000-0000-4000-8000-000000000101";
const cardId = "00000000-0000-4000-8000-000000000102";
const acquisitionId = "00000000-0000-4000-8000-000000000103";
const idempotencyKey = "00000000-0000-4000-8000-000000000201";
const bonusPackId = "00000000-0000-4000-8000-000000000301";

const input: AcquireInput = {
  spot_id: spotId,
  lat: 37.5665,
  lng: 126.978,
  accuracy: 20,
  idempotency_key: idempotencyKey,
};

const card: InternalCard = {
  id: cardId,
  title: {
    ko: "서울 카드",
    en: "Seoul Card",
    ja: "ソウルカード",
    "zh-Hans": "首尔卡",
    "zh-Hant": "首爾卡",
    vi: "Thẻ Seoul",
  },
  sketch_path: "cards/seoul.webp",
  color_hex: "#102030",
};

const acquisition: InternalAcquisition = {
  id: acquisitionId,
  spot_id: spotId,
  card_id: cardId,
  acquisition_type: "field",
  acquired_at: "2026-08-08T01:00:00.000Z",
  acquired_on_kst: "2026-08-08",
};

function readyContext(overrides: Partial<ContextResult & { status: "ready" }> = {}): ContextResult {
  return {
    status: "ready",
    user_id: userId,
    spot: {
      id: spotId,
      latitude: 37.5665,
      longitude: 126.978,
      radius_m: 150,
      accuracy_threshold_m: 200,
      updated_at: "2026-08-08T00:00:00.000Z",
    },
    card,
    ...overrides,
  };
}

function repository(
  contextResult: ContextResult,
  commitResult: CommitResult = { status: "created", acquisition, card },
): AcquireRepository & {
  getContext: ReturnType<typeof vi.fn<AcquireRepository["getContext"]>>;
  commit: ReturnType<typeof vi.fn<AcquireRepository["commit"]>>;
  recordFailure: ReturnType<typeof vi.fn<AcquireRepository["recordFailure"]>>;
} {
  return {
    getContext: vi.fn(async () => contextResult),
    commit: vi.fn(async () => commitResult),
    recordFailure: vi.fn(async (failureInput): Promise<RecordFailureResult> => ({
      status: "failed",
      code: failureInput.code,
      details: failureInput.details,
    } as RecordFailureResult)),
  };
}

describe("acquireCard", () => {
  it("creates a safe response without sending raw coordinates to the repository", async () => {
    const data = repository(readyContext());

    const outcome = await acquireCard(
      input,
      { authUserId, publicGateOpen: false },
      { repository: data },
    );

    expect(outcome.status).toBe(201);
    expect(outcome.body).toEqual({
      acquisition: {
        id: acquisitionId,
        spot_id: spotId,
        card_id: cardId,
        type: "field",
        acquired_at: "2026-08-08T01:00:00.000Z",
      },
      card: {
        id: cardId,
        title: card.title,
        image_url: `/api/card-assets/${cardId}`,
        color_hex: "#102030",
      },
      back: { date_kst: "2026-08-08" },
    });
    expect(data.getContext).toHaveBeenCalledWith({
      authUserId,
      spotId,
      idempotencyKey,
      publicGateOpen: false,
    });
    expect(data.commit).toHaveBeenCalledWith({
      authUserId,
      spotId,
      idempotencyKey,
      publicGateOpen: false,
      expectedSpotUpdatedAt: "2026-08-08T00:00:00.000Z",
      expectedUserId: userId,
      bonusPackIssuanceScope: "off",
    });
    expect(JSON.stringify(data.getContext.mock.calls)).not.toContain("37.5665");
    expect(JSON.stringify(data.commit.mock.calls)).not.toContain("37.5665");
    expect(JSON.stringify(outcome.body)).not.toContain("field_sequence");
    expect(JSON.stringify(outcome.body)).not.toContain("sketch_path");
    expect(JSON.stringify(outcome.body)).not.toContain("accuracy_threshold_m");
  });

  it("replays the original acquisition before a new location decision", async () => {
    const data = repository({ status: "replay", acquisition, card });
    const outcome = await acquireCard(
      { ...input, lat: -90, lng: -180, accuracy: 50_000 },
      { authUserId, publicGateOpen: true },
      { repository: data },
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body.acquisition.id).toBe(acquisitionId);
    expect(data.commit).not.toHaveBeenCalled();
    expect(data.recordFailure).not.toHaveBeenCalled();
  });

  it("adds only the sealed daily bonus envelope and forwards the issuance scope", async () => {
    const bonusPack = {
      id: bonusPackId,
      status: "sealed" as const,
      issued_at: "2026-08-08T01:00:00.000Z",
      date_kst: "2026-08-08",
    };
    const data = repository(readyContext(), {
      status: "created",
      acquisition,
      card,
      bonus_pack: bonusPack,
    });

    const outcome = await acquireCard(
      input,
      { authUserId, publicGateOpen: true, bonusPackIssuanceScope: "participants" },
      { repository: data },
    );

    expect(outcome.body.bonus_pack).toEqual(bonusPack);
    expect(JSON.stringify(outcome.body.bonus_pack)).not.toMatch(
      /rarity|card|result|guarantee/u,
    );
    expect(data.commit).toHaveBeenCalledWith(expect.objectContaining({
      bonusPackIssuanceScope: "participants",
    }));
  });

  it("rejects low accuracy before distance and records only the allowed code", async () => {
    const data = repository(readyContext());

    await expect(acquireCard(
      { ...input, accuracy: 201 },
      { authUserId, publicGateOpen: false },
      { repository: data },
    )).rejects.toMatchObject({
      code: "LOW_ACCURACY",
      details: { retry: true },
    });

    expect(data.commit).not.toHaveBeenCalled();
    expect(data.recordFailure).toHaveBeenCalledWith({
      authUserId,
      spotId,
      idempotencyKey: input.idempotency_key,
      expectedUserId: userId,
      code: "LOW_ACCURACY",
      details: { retry: true },
    });
  });

  it("returns only a coarse distance band for an out-of-range request", async () => {
    const data = repository(readyContext());

    await expect(acquireCard(
      { ...input, lat: 37.5765 },
      { authUserId, publicGateOpen: false },
      { repository: data },
    )).rejects.toMatchObject({
      code: "OUT_OF_RANGE",
      details: { distance_band: "far" },
    });

    expect(data.recordFailure).toHaveBeenCalledWith({
      authUserId,
      spotId,
      idempotencyKey: input.idempotency_key,
      expectedUserId: userId,
      code: "OUT_OF_RANGE",
      details: { distance_band: "far" },
    });
  });

  it("records a closed gate but does not record an idempotency conflict", async () => {
    const gateRepository = repository({
      status: "error",
      code: "GATE_CLOSED",
      expected_user_id: userId,
    });
    await expect(acquireCard(
      input,
      { authUserId, publicGateOpen: false },
      { repository: gateRepository },
    )).rejects.toMatchObject({ code: "GATE_CLOSED" });
    expect(gateRepository.recordFailure).toHaveBeenCalledOnce();

    const conflictRepository = repository({ status: "error", code: "IDEMPOTENCY_CONFLICT" });
    await expect(acquireCard(
      input,
      { authUserId, publicGateOpen: false },
      { repository: conflictRepository },
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(conflictRepository.recordFailure).not.toHaveBeenCalled();
  });

  it("re-evaluates location once when the spot configuration changes", async () => {
    const data = repository(readyContext(), { status: "error", code: "SPOT_CONFIG_CHANGED" });
    data.getContext
      .mockResolvedValueOnce(readyContext())
      .mockResolvedValueOnce(readyContext({
        spot: {
          id: spotId,
          latitude: 37.5665,
          longitude: 126.978,
          radius_m: 175,
          accuracy_threshold_m: 225,
          updated_at: "2026-08-08T00:01:00.000Z",
        },
      }));
    data.commit
      .mockResolvedValueOnce({ status: "error", code: "SPOT_CONFIG_CHANGED" })
      .mockResolvedValueOnce({ status: "created", acquisition, card });

    const outcome = await acquireCard(
      input,
      { authUserId, publicGateOpen: false },
      { repository: data },
    );

    expect(outcome.status).toBe(201);
    expect(data.getContext).toHaveBeenCalledTimes(2);
    expect(data.getContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedUserId: userId,
    }));
    expect(data.commit).toHaveBeenCalledTimes(2);
    expect(data.commit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedUserId: userId,
    }));
  });

  it("fails closed when the terminal failure transition is unavailable", async () => {
    const data = repository(readyContext());
    data.recordFailure.mockRejectedValueOnce(new Error("unavailable"));

    await expect(acquireCard(
      { ...input, accuracy: 201 },
      { authUserId, publicGateOpen: false },
      { repository: data },
    )).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("returns the winning success when commit beats a concurrent failure", async () => {
    const data = repository(readyContext());
    data.recordFailure.mockResolvedValueOnce({ status: "replay", acquisition, card });

    const outcome = await acquireCard(
      { ...input, accuracy: 201 },
      { authUserId, publicGateOpen: false },
      { repository: data },
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body.acquisition.id).toBe(acquisitionId);
  });

  it("replays the exact stored terminal failure details", async () => {
    const data = repository({
      status: "error",
      code: "OUT_OF_RANGE",
      details: { distance_band: "near" },
      expected_user_id: userId,
    });

    await expect(acquireCard(
      input,
      { authUserId, publicGateOpen: false },
      { repository: data },
    )).rejects.toMatchObject({
      code: "OUT_OF_RANGE",
      details: { distance_band: "near" },
    });
    expect(data.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "OUT_OF_RANGE",
      details: { distance_band: "near" },
    }));
  });
});
