import { randomUUID } from "node:crypto";

import {
  normalizeLandingReference,
  recordLandingView,
} from "@/server/events/public-events";
import { logSafeServerError } from "@/server/logging/safe-log";

export const dynamic = "force-dynamic";

type HomePageProps = {
  searchParams: Promise<{ ref?: string | string[] }>;
};

export default async function HomePage({ searchParams }: HomePageProps) {
  const reference = normalizeLandingReference((await searchParams).ref);
  try {
    await recordLandingView(reference);
  } catch {
    // Analytics must never make the public landing unavailable. The log is
    // deliberately limited to a generated request identifier and operation.
    logSafeServerError({
      requestId: randomUUID(),
      operation: "landing_view",
      category: "database",
    });
  }

  return (
    <main>
      <section className="shell">
        <h1>다녀담</h1>
        <p>다녀온 곳을 담다. Stage 0 서비스 기반을 준비하고 있습니다.</p>
      </section>
    </main>
  );
}
