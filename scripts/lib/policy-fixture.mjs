import { randomUUID } from "node:crypto";

export async function createPolicyFixture(database, { authUserIds }) {
  const version = `e2e-${randomUUID()}`;
  const documents = [
    { id: randomUUID(), type: "terms_of_use" },
    { id: randomUUID(), type: "privacy_policy" },
    { id: randomUUID(), type: "community_guidelines" },
    { id: randomUUID(), type: "location_terms" },
  ];
  const previousCurrent = await database.query(
    `select id
     from private.policy_documents
     where is_current
     order by id`,
  );
  const previousDocumentIds = previousCurrent.rows.map((row) => row.id);

  await database.query("begin");
  try {
    for (const document of documents) {
      await database.query(
        `insert into private.policy_documents (
           id, policy_type, version, effective_at, published_at, is_current
         ) values ($1, $2, $3, now() - interval '1 minute', now(), false)`,
        [document.id, document.type, version],
      );
      await database.query(
        `insert into private.policy_document_locales (
           policy_document_id, locale, document_url, sha256
         )
         select
           $1::uuid,
           locale_row.locale,
           'https://policies.test/' || $1::uuid::text || '/' || locale_row.locale::text,
           extensions.digest($1::uuid::text || ':' || locale_row.locale::text, 'sha256')
         from unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
        [document.id],
      );
    }
    const switched = await database.query(
      "select api_private.set_current_policy_documents($1::uuid[]) as result",
      [documents.map((document) => document.id)],
    );
    if (switched.rows[0]?.result?.status !== "switched") {
      throw new Error("policy publication fixture failed");
    }
    for (const authUserId of authUserIds) {
      const acceptance = await database.query(
        `select api_private.accept_current_policies(
           $1,
           jsonb_build_array(
             jsonb_build_object(
               'type', 'terms_of_use', 'version', $2::text, 'locale', 'ko'
             ),
             jsonb_build_object(
               'type', 'community_guidelines', 'version', $2::text, 'locale', 'ko'
             )
           )
         ) as result`,
        [authUserId, version],
      );
      if (acceptance.rows[0]?.result?.status !== "accepted") {
        throw new Error("policy acceptance fixture failed");
      }
      const age = await database.query(
        `select api_private.record_minimum_age_attestation(
           $1,
           '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
         ) as result`,
        [authUserId],
      );
      if (age.rows[0]?.result?.status !== "attested") {
        throw new Error("minimum-age attestation fixture failed");
      }
      const location = await database.query(
        `select api_private.accept_location_consent(
           $1,
           jsonb_build_object('version', $2::text, 'locale', 'ko')
         ) as result`,
        [authUserId, version],
      );
      if (location.rows[0]?.result?.status !== "active") {
        throw new Error("location consent fixture failed");
      }
    }
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }

  return {
    documentIds: documents.map((document) => document.id),
    documents,
    previousDocumentIds,
    version,
  };
}

export async function retirePolicyFixture(database, fixture) {
  if (fixture.previousDocumentIds.length === 4) {
    const restored = await database.query(
      "select api_private.set_current_policy_documents($1::uuid[]) as result",
      [fixture.previousDocumentIds],
    );
    if (restored.rows[0]?.result?.status !== "switched") {
      throw new Error("previous policy publication fixture restore failed");
    }
  }
}
