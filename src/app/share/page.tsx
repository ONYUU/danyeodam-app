import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";

import { selectPublicShareLocaleFromHeader } from "@/app/share/copy";
import { ShareClient } from "@/app/share/share-client";

export const metadata: Metadata = {
  title: "DANYEODAM",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    nosnippet: true,
  },
  referrer: "no-referrer",
};

export default async function SharePage() {
  await connection();
  const locale = selectPublicShareLocaleFromHeader((await headers()).get("accept-language"));
  return (
    <main lang={locale}>
      <ShareClient locale={locale} />
    </main>
  );
}
