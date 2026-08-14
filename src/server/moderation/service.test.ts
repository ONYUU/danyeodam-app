import { describe, expect, it, vi } from "vitest";

import {
  applyShareModerationAction,
  type ModerationServiceDependencies,
} from "@/server/moderation/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const personalCardId = "22222222-2222-4222-8222-222222222222";
const action = {
  client_action_id: "33333333-3333-4333-8333-333333333333",
  action: "approve" as const,
  reason_code: "MANUAL_REVIEW",
  note: "reviewed",
};

function dependencies(
  applyShareAction: ModerationServiceDependencies["applyShareAction"],
): ModerationServiceDependencies {
  return {
    listShares: vi.fn(async () => ({ status: "forbidden" as const })),
    findPhoto: vi.fn(async () => ({ status: "forbidden" as const })),
    applyShareAction,
    listReports: vi.fn(async () => ({ status: "forbidden" as const })),
    applyReportAction: vi.fn(async () => ({ status: "forbidden" as const })),
    listSuspensions: vi.fn(async () => ({ status: "forbidden" as const })),
    applySuspensionAction: vi.fn(async () => ({ status: "forbidden" as const })),
    downloadPhoto: vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>(),
      contentType: "image/webp" as const,
      contentLength: 0,
    })),
  };
}

describe("share moderation service", () => {
  it("maps a closed publication boundary to the dedicated gate", async () => {
    const applyShareAction = vi.fn(async () => ({
      status: "publication_gate_closed" as const,
    }));
    await expect(applyShareModerationAction({
      authUserId,
      personalCardId,
      action,
      publicSharePublicationOpen: false,
    }, dependencies(applyShareAction))).rejects.toMatchObject({
      code: "GATE_CLOSED",
      status: 403,
      details: { gate: "share_publication" },
    });
    expect(applyShareAction).toHaveBeenCalledWith({
      authUserId,
      personalCardId,
      action,
      publicSharePublicationOpen: false,
    });
  });
});
