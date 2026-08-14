const locales = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"];

export async function createLocalizedSpotCardFixture(database, input) {
  const {
    approvalAuthUserId,
    cardCode,
    cardId,
    cardTitle = "E2E Card",
    colorHex = "#123456",
    latitude = 37.5,
    longitude = 127.0,
    regionCode,
    regionName = "E2E Region",
    sketchPath = "e2e/card.webp",
    spotId,
    spotName = "E2E Spot",
    spotSlug,
  } = input;

  await database.query("begin");
  try {
    await database.query(
      `insert into public.regions (code, country_code, sort_order)
       values ($1, 'KR', 0)`,
      [regionCode],
    );
    await database.query(
      `insert into public.region_translations (
         region_code, locale, name, status, approved_at, approved_by
       )
       select $1, locale_value::public.content_locale,
              $2 || ' ' || locale_value, 'approved', now(), $3
       from unnest($4::text[]) as locale_value`,
      [regionCode, regionName, approvalAuthUserId, locales],
    );

    const spot = await database.query(
      `insert into public.spots (
         id, slug, region, name_ko, name_en, status,
         latitude, longitude, radius_m, accuracy_threshold_m
       ) values (
         coalesce($1, gen_random_uuid()), $2, $3, $4, $4, 'draft',
         $5, $6, 200, 500
       )
       returning id`,
      [spotId ?? null, spotSlug, regionCode, spotName, latitude, longitude],
    );
    const resolvedSpotId = spot.rows[0].id;
    await database.query(
      `insert into public.spot_translations (
         spot_id, locale, name, status, approved_at, approved_by
       )
       select $1, locale_value::public.content_locale,
              $2 || ' ' || locale_value, 'approved', now(), $3
       from unnest($4::text[]) as locale_value`,
      [resolvedSpotId, spotName, approvalAuthUserId, locales],
    );

    const card = await database.query(
      `insert into public.cards (
         id, spot_id, code, title_ko, title_en, sketch_path,
         color_hex, is_published, published_at
       ) values (
         coalesce($1, gen_random_uuid()), $2, $3, $4, $4, $5,
         $6, false, null
       )
       returning id`,
      [cardId ?? null, resolvedSpotId, cardCode, cardTitle, sketchPath, colorHex],
    );
    const resolvedCardId = card.rows[0].id;
    await database.query(
      `insert into public.card_translations (
         card_id, locale, title, status, approved_at, approved_by
       )
       select $1, locale_value::public.content_locale,
              $2 || ' ' || locale_value, 'approved', now(), $3
       from unnest($4::text[]) as locale_value`,
      [resolvedCardId, cardTitle, approvalAuthUserId, locales],
    );
    await database.query(
      `update public.cards
       set is_published = true, published_at = now()
       where id = $1`,
      [resolvedCardId],
    );
    await database.query(
      `update public.spots set status = 'open' where id = $1`,
      [resolvedSpotId],
    );
    await database.query("commit");
    return { spotId: resolvedSpotId, cardId: resolvedCardId };
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
}

export async function retireLocalizedSpotCardFixture(database, input) {
  const region = await database.query(
    "select region from public.spots where id = $1",
    [input.spotId],
  );
  const regionCode = region.rows[0]?.region;
  await database.query("begin");
  try {
    await database.query(
      "update public.spots set status = 'draft' where id = $1",
      [input.spotId],
    );
    await database.query(
      `update public.cards
       set is_published = false, published_at = null
       where id = $1`,
      [input.cardId],
    );
    await database.query("delete from public.cards where id = $1", [input.cardId]);
    await database.query("delete from public.spots where id = $1", [input.spotId]);
    if (regionCode !== undefined) {
      await database.query(
        `delete from public.regions as region_row
         where region_row.code = $1
           and not exists (
             select 1 from public.spots as spot_row where spot_row.region = region_row.code
           )`,
        [regionCode],
      );
    }
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
}
