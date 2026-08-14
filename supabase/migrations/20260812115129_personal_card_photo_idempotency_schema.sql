-- Personal-card photo idempotency and deletion schema boundary.
--
-- The enum value is committed in this migration before the next migration
-- uses it in constraints and function bodies. PostgreSQL deliberately rejects
-- use of a newly-added enum value before the ALTER TYPE transaction commits.

begin;

lock table private.personal_card_temp_uploads in share row exclusive mode;
lock table private.data_erasure_jobs in share row exclusive mode;

alter type private.data_erasure_scope add value if not exists 'personal_card';

-- Old rows receive their already-random upload id as a non-colliding legacy
-- request key. The internal pre-idempotency issuer keeps a random default;
-- the public five-argument wrapper replaces it with the client key in the
-- same transaction before returning.
alter table private.personal_card_temp_uploads
  drop constraint personal_card_temp_uploads_exact_signed_url_expiry,
  add column client_request_id uuid default gen_random_uuid(),
  add column signed_url_last_issued_at timestamptz default now(),
  add column signed_url_reissue_count smallint not null default 0;

update private.personal_card_temp_uploads
set client_request_id = id,
    signed_url_last_issued_at = issued_at;

-- The wrapped legacy issuer deliberately uses clock_timestamp() for its
-- upload-window values. A column default uses transaction_timestamp(), which
-- can differ by microseconds and would fail the exact CHECK below before the
-- outer idempotency wrapper can bind its client key. Derive the new timestamp
-- from the authoritative signed expiry on every insert instead.
create or replace function private.prepare_personal_card_signed_url_issue_time()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.signed_url_last_issued_at :=
    new.signed_url_expires_at - interval '2 hours';
  return new;
end;
$$;

revoke all on function private.prepare_personal_card_signed_url_issue_time()
  from public, anon, authenticated, service_role;

create trigger personal_card_temp_uploads_prepare_signed_url_issue_time
before insert on private.personal_card_temp_uploads
for each row execute function private.prepare_personal_card_signed_url_issue_time();

alter table private.personal_card_temp_uploads
  alter column client_request_id set not null,
  alter column signed_url_last_issued_at set not null,
  add constraint personal_card_temp_uploads_signed_url_window check (
    signed_url_last_issued_at >= issued_at
    and signed_url_last_issued_at <= promotion_expires_at
    and signed_url_expires_at = signed_url_last_issued_at + interval '2 hours'
  ),
  add constraint personal_card_temp_uploads_signed_url_reissues_bounded check (
    signed_url_reissue_count between 0 and 20
  );

create unique index personal_card_temp_uploads_owner_request_idx
  on private.personal_card_temp_uploads(user_id, client_request_id);

comment on column private.personal_card_temp_uploads.client_request_id is
  'Owner-scoped logical upload request key; retained with the bounded temp-upload record.';
comment on column private.personal_card_temp_uploads.signed_url_last_issued_at is
  'Last token issuance time; retries are allowed only inside the original ten-minute promotion window.';

alter table private.data_erasure_jobs
  add column personal_card_id uuid;

commit;
