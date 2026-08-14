import { describe, expect, it } from "vitest";

import { parseContentReportInput } from "@/server/reports/input";

describe("content report input", () => {
  it("accepts the bounded report payload", () => {
    expect(parseContentReportInput({
      client_report_id: "11111111-1111-4111-8111-111111111111",
      target: "content",
      reason: "privacy",
      comment: "  얼굴이 노출되어 있습니다.  ",
    })).toMatchObject({ reason: "privacy", comment: "얼굴이 노출되어 있습니다." });
  });
});
