import { headers } from "next/headers";

import { AccountDeletionClient } from "@/app/account/delete/delete-client";
import { resolveDeletionLocale } from "@/app/account/delete/copy";
import { getServerEnvironment } from "@/server/env";

export const dynamic = "force-dynamic";

export default async function AccountDeletePage() {
  const environment = getServerEnvironment();
  const language = (await headers()).get("accept-language")?.split(",", 1)[0];
  const locale = resolveDeletionLocale(language);
  return (
    <AccountDeletionClient
      developerName={environment.ACCOUNT_DELETION_DEVELOPER_NAME ?? null}
      locale={locale}
      publicAppUrl={environment.PUBLIC_APP_URL ?? null}
      supabaseAnonKey={environment.NEXT_PUBLIC_SUPABASE_ANON_KEY}
      supabaseUrl={environment.NEXT_PUBLIC_SUPABASE_URL}
      supportUrl={environment.ACCOUNT_DELETION_SUPPORT_URL ?? null}
    />
  );
}
