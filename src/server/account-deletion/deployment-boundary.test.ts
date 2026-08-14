import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type CronConfiguration = {
  crons?: Array<{ path?: unknown; schedule?: unknown }>;
};

describe("account deletion deployment boundary", () => {
  it("runs account deletion every minute while other privacy workers remain five-minute jobs", () => {
    const configuration = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as CronConfiguration;

    expect(configuration.crons).toEqual([
      {
        path: "/api/internal/maintenance/temp-uploads",
        schedule: "*/5 * * * *",
      },
      {
        path: "/api/internal/maintenance/location-compliance",
        schedule: "*/5 * * * *",
      },
      {
        path: "/api/internal/maintenance/account-deletions",
        schedule: "* * * * *",
      },
    ]);
  });
});
