# DB SCHEMA

> 현재 저장소 기준: API-CONTRACT v0.3의 6개 언어 콘텐츠·읽기 API,
> v0.3.1 reviewer 접근 projection, v0.3.2 UGC 정책·수동 사전 검수·신고·운영자
> 조치 모델, v0.3.3 정책/차단 경합 직렬화와 block cursor pagination,
> v0.3.4 제출·발행 kill switch 분리와 legacy secret 회전, v0.3.5 정책 소비
> lock·자정 독립 신고 제한·정지/신고 직렬화, v0.3.6 reviewer 복구·이메일
> 잠금과 철회 primitive, v0.3.7 reviewer 지정/claim과 exact Auth
> user·identity·provider/MFA·passkey credential/cutover 직렬화, v0.3.8
> fragment·fixed POST 공개 전송과 web 연령 gate, v0.3.9 신원 기반 최소연령·
> 위치 준수 원장/권리행사/삭제·field object ledger, v0.4.0 전체 계정삭제
> state machine·공개 status·관리자 운영·개인카드 upload/storage quota·upload
> 멱등 reservation·개별 카드 2-pass 삭제와 reviewer fixture lifecycle을 누적
> 전진 마이그레이션으로 정의한다. 이 문서는 저장소 구현 계약이며
> 원격 DB 적용·production 운영 완료를 뜻하지 않는다. 기준은 이 문서와 마이그레이션이다.

## 1. 범위와 원칙

Stage 0의 데이터 무결성·권한 경계와 현장 획득의 서버 전용 DB
경계를 정의한다. API Route Handler는 인증된 `auth_user_id`와 위치 판정
결과만 DB RPC에 전달하며, 기기 원시 좌표는 DB로 전달하지 않는다.

- 기기에서 받은 원시 `lat`·`lng`·`accuracy`는 판정 후 폐기하며 저장하지 않는다.
- `spots.latitude`·`spots.longitude`는 공개 POI 기준좌표로, 사용자 위치가 아니다.
- 시간은 `timestamptz`로 저장하고 현장 획득의 일자만 `Asia/Seoul`로 계산한다.
- 실물은 결제·제작 대상이 아니라 이용자별 수요 신호만 중복 없이 저장한다.
- 브라우저에는 업무 테이블의 직접 쓰기 권한을 부여하지 않는다.
- 모든 앱 테이블은 RLS를 활성화하고 `FORCE ROW LEVEL SECURITY`를 적용한다.

## 2. 사용자와 복구 모델

`auth.users.id`를 서비스 데이터의 소유자 키로 직접 사용하지 않는다. 익명 이용자가
기기를 바꾸거나 복구코드를 사용하면 인증 UID가 달라질 수 있기 때문이다.

```text
auth.users
    │ 1
    ▼
private.user_identities ── N:1 ── public.app_users
                                      │
                                      ├── acquisitions
                                      ├── personal_cards
                                      └── physical_requests
```

- `public.app_users`: 바뀌지 않는 가명 서비스 사용자 ID.
- `private.user_identities`: 인증 UID와 서비스 사용자 ID의 활성 바인딩.
- 신규 `auth.users` 행은 트리거로 `app_users`와 최초 바인딩을 원자적으로 만든다.
- 인증 UID와 서비스 사용자 모두 활성 바인딩을 하나만 가질 수 있다. 이메일로
  로그인한 여러 기기는 동일한 인증 UID의 여러 세션으로 처리한다.
- 복구 claim은 현재 인증 UID가 익명이고 현재 논리 사용자의 획득이 0건일
  때만 허용한다. 참여 자격과 클라이언트 이벤트만 있는 사용자는 계약상
  “빈 사용자”로 본다.
- claim 성공 트랜잭션은 대상 사용자의 모든 활성 서비스 바인딩을 철회하고,
  현재 UID를 대상 사용자에 재바인딩하며, 코드를 소모한다. 구 UID의 JWT가
  유효해도 보호 RPC의 활성 바인딩 재검사로 즉시 차단된다.
- 제출 코드의 대상이 이미 현재 논리 사용자와 같으면 코드는 원자 소모하지만
  identity나 사용자 데이터를 self-merge하지 않는 안전한 `restored` no-op으로 처리한다.
- zero-acquisition source의 위치 fact·consent는 복구 중 target에 병합하지 않고 삭제한다.
  이미 정정·철회 완료로 fact가 사라진 anti-replay marker는 owner digest만 target으로
  바꾸어 원시 idempotency key 없이 6개월 차단을 이어간다.
- 현재 사용자의 유효한 참여 자격과 실물 수요·분석 이벤트는 복구 대상으로
  병합한다. 승격 대기 임시 업로드처럼 안전하게 이전할 수 없는 메타데이터가
  남으면 정리 완료 전까지 기존 `app_user` 행을 보존한다.
- claim 이력의 인증 UID는 감사 목적으로 유지하되 해당 인증 사용자가 삭제되면
  UID를 지우고 `claimant_redacted_at`만 남겨 계정 삭제와 상태 무결성을 함께 보장한다.
- reviewer로 한 번이라도 표시된 논리 사용자는 일반 복구·이메일
  연결 대상이 아니다. `reviewer_user_history`의 UUID tombstone으로 reviewer
  membership 행을 삭제해도 논리 사용자가 존재하는 동안 재사용을 금지한다.
  전체 계정 삭제로 `app_users`가 삭제되면 이 이력도 cascade 삭제한다.
- reviewer 지정 전의 미사용 코드는 지정 트리거가 철회하고,
  이력 사용자에 대한 새 활성 코드 insert·재활성화를 DB가 거부한다.
  reviewer 이력이 있는 Auth identity가 일반 사용자 코드를 claim하는
  역방향도 code claim trigger가 전체 이전 트랜잭션을 롤백한다.
- reviewer 지정 trigger는 recovery target advisory를 먼저 획득한 뒤
  활성 `user_identities` 행, `auth.users` 행, 그 사용자의 전체 `auth.identities`
  행을 순서대로 `FOR UPDATE`한다. `auth.users`는 활성·미삭제·non-anonymous·
  non-SSO confirmed email/nonempty password여야 하고 phone·pending email/phone/
  recovery/reauth 상태가 없어야 한다. `raw_app_meta_data`는 email provider 1종,
  `auth.identities`는 Auth UID와 `provider_id`·`identity_data.sub`·email이 정확히
  일치하는 email identity 1개여야 한다. 이메일 확인의 authority는
  `auth.users.email_confirmed_at`이며, Admin `createUser({email_confirm:true})`가 유지하는
  provider 소유 `identity_data.email_verified=false`는 확인 판정에 사용하지 않는다.
  `raw_app_meta_data`는 email provider 두 키만, `raw_user_meta_data`는 GoTrue가 만드는
  `email_verified=true` 외 사용자 정의 값이 없어야 한다.
  따라서 phone-only·magic-link-only·`email_confirmed_at`이 없는 계정·다중 provider·
  SSO·pending 계정은 reviewer가 될 수 없다. `auth.mfa_factors`와 설치된 별도
  WebAuthn credential/challenge도 0건이어야 한다. `reviewer_accounts.user_id`도
  변경할 수 없다.
- `auth.users` BEFORE UPDATE trigger는 credential 열의 변경일 때 활성 identity의
  recovery target advisory를 try-lock한다. Auth 행이 이미 잠긴 상태에서 blocking lock을
  잡으면 지정의 advisory → identity → Auth 순서와 deadlock이 나므로 try-lock 실패는
  fail-closed 23514로 종료한다. 이후 모든 identity 이력을 reviewer tombstone과
  대조해 현재·과거 reviewer의 email·password·phone·pending token·anonymous/SSO·
  provider/user metadata 변경을 거부한다. 별도 `auth.identities` trigger도 INSERT/DELETE와
  `user_id/provider/provider_id/identity_data` 변경을 같은 advisory로 직렬화·거부한다.
  MFA factor와 설치된 별도 WebAuthn credential/challenge도 같은 경계로 막는다.
  sign-in/refresh volatile 열과 GoTrue soft/hard delete redaction/cascade는 허용한다.
- 새 Auth trigger 설치 전 활성 reviewer 전 행을 동일한 exact identity invariant로
  검사한다. 위반 시 식별자·건수를 노출하지 않는 23514로 마이그레이션 전체를
  실패시킨다.
- password DB-encryption rewrap과 사용자 password 변경은 모두
  `encrypted_password` update이므로 reviewer에는 fail-closed다. Auth encryption
  변경은 기존 reviewer 철회 후 staging rehearsal과 새 Auth/app user/fixture provision,
  canary sign-in/refresh를 배포 선행조건으로 둔다.
- 철회 membership의 재활성화나 삭제 후 재삽입은 거부한다. 재발급은 새
  Auth 계정·새 `app_user_id`·새 `fixture_version`을 요구한다.

## 3. 테이블

### 공개 스키마

| 테이블 | 목적 | 주요 통제 |
|---|---|---|
| `app_users` | 안정적인 가명 소유자 | 본인 행만 조회 |
| `regions` | 대한민국 지역 코드·정렬 순서 | 공개 API 정렬의 부모 엔터티 |
| `region_translations` | 지역명 6개 언어 승인본 | 언어별 `draft/approved`와 승인 감사 |
| `spots` | POI 기준좌표·판정 파라미터·상태 | `teaser/open`만 공개 조회 |
| `spot_translations` | 스팟명 6개 언어 승인본 | 공개 상태에서 승인본 제거·강등 금지 |
| `cards` | 스팟 카드 메타데이터 | 공개된 카드 중 `open` 스팟만 공개 조회 |
| `card_translations` | 카드명 6개 언어 승인본 | 게시·획득 후 불변성 통제 |
| `acquisitions` | `field/retro/gift` 획득 원장 | 본인 조회, 직접 쓰기 금지 |
| `personal_cards` | 본인 사진 파생물·캡션·공유 상태 | 본인 조회, 소유자 폴더 경로 강제 |
| `physical_requests` | 실물 제작 요청·알림 수요 | `(user_id, kind)`당 한 번 |

### 비공개 스키마

| 테이블 | 목적 |
|---|---|
| `private.user_identities` | 인증 UID와 가명 사용자 연결 |
| `private.admin_members` | 서버 통제 관리자 명부 |
| `private.participant_access` | 공개 게이트가 닫힌 동안 내부 참여 자격 |
| `private.reviewer_accounts` | Store별 심사 계정 membership과 현재 fixture 버전 |
| `private.reviewer_user_history` | reviewer였던 논리 사용자 UUID의 membership 삭제 내성 tombstone(계정 삭제 시 cascade) |
| `private.reviewer_fixture_templates` | 서울 6개 결정적 retro template의 slug·순서·sample 표식 |
| `private.reviewer_fixture_items` | reviewer별 retro 6개·개인카드 1개·활성 공유 1개의 활성/철회 inventory와 content hash |
| `private.reviewer_access_actions` | raw 계정 ID·credential·share secret 없이 관리/대상 fingerprint와 멱등 결과만 남기는 append-only lifecycle 감사 원장 |
| `private.participant_invite_codes` | 128-bit 1회용 초대코드의 SHA-256 digest와 소모 이력 |
| `private.participant_redeem_limits` | 인증 UID별 초대코드 15분 창·5회 실패 잠금 |
| `private.card_counters` | 카드별 현장 획득 순번 카운터 |
| `private.retro_grants` | 수동 소급 지급 감사 원장 |
| `private.recovery_codes` | 복구코드 SHA-256 digest와 상태 |
| `private.recovery_claim_limits` | 현재 인증 세션별 실패 횟수·잠금 |
| `private.personal_card_temp_uploads` | 소유자별 UUID request key, 최초 10분 승격 창, 마지막 토큰 발급시각을 가진 임시 업로드 메타데이터 |
| `private.personal_card_deletion_requests` | 카드 삭제 응답 유실용 30일 멱등 영수증과 최종 Storage pass 전 exact byte charge |
| `private.content_versions` | 공개 스팟 응답의 단조 증가 콘텐츠 버전 |
| `private.policy_documents` | 버전·시행시각·현재 여부가 있는 이용약관·개인정보처리방침·커뮤니티 지침 |
| `private.policy_document_locales` | 정책별 6개 locale의 HTTPS URL과 SHA-256 |
| `private.policy_acceptances` | 사용자·정책 버전·선택 locale·당시 SHA-256 snapshot과 `user|reviewer_fixture` 출처 |
| `private.user_blocks` / `private.user_block_actions` | blocker→소유자 차단과 raw secret 없는 멱등·rate 원장 |
| `private.share_owner_suspensions` | opaque ID로 카드와 독립 관리하는 소유자 정지와 해제 이력 |
| `private.content_reports` | raw secret/IP 없이 해석된 카드·소유자와 신고 사유를 보관하는 원장 |
| `private.public_report_rate_limits` | 단기 HMAC reporter key hash 기반 공개 신고 남용 제한 |
| `private.rate_limit_windows` | 활성 논리 사용자·고정 API purpose별 rolling 60초 attempt timestamp(최대 60개) |
| `private.moderation_actions` | 관리자·멱등 키·전후 상태·사유를 보존하는 append-only 감사 원장 |
| `analytics.events` | 허용된 이벤트의 분리 원장 |

### 6개 언어 콘텐츠 승인 경계

- 고정 언어는 `ko`·`en`·`ja`·`zh-Hans`·`zh-Hant`·`vi`이다.
- 번역은 `draft` 또는 `approved`이며, 승인본은 `approved_at`과
  `approved_by`를 모두 가져야 한다. 승인 문구를 바꾸면 더 최신 승인시각과
  승인자를 함께 기록하여 감사 흔적을 갱신해야 한다.
- 기존 `name_ko/name_en`, `title_ko/title_en`은 호환용 읽기 전용 열이다.
  v0.3 읽기 RPC는 번역 테이블의 승인본만 사용한다.
- 지역·스팟·카드의 6개 승인본이 모두 있어야 공개할 수 있다. `open` 스팟은
  완전한 게시 region 카드가 필요하고, `teaser` 응답은 카드를 노출하지 않는다.
- 공개 콘텐츠 변경은 `private.content_versions(scope='public_spots')`를 증가시킨다.
- 스팟은 `region.sort_order → spot.sort_order → id` 순서로 안정 정렬한다.
- 한 스팟에는 게시된 region 카드가 최대 한 개다. 카드 버전 교체는 같은
  트랜잭션에서 기존 게시 카드와 신규 비게시 카드를 순서대로 `FOR UPDATE`한 뒤
  스팟을 잠그고 `draft`로 전환한다. 이어 기존 카드를 비게시하고 완전한 신규
  카드를 게시한 뒤 마지막에 스팟을 `open`으로 복구한다. 이 카드 → 스팟 순서는
  획득 RPC와 일치하므로 acquire와의 역순 교착을 피한다. 공개 상태에서 카드를
  직접 삭제·비게시하는 경로는 차단한다.

### 정책 문서·동의 경계

- 정책 type은 `terms_of_use`·`privacy_policy`·`community_guidelines`·
  `location_terms`이고,
  각 현재 시행본은 고정 6개 locale을 모두 가져야 한다.
- 각 locale 행은 공개 HTTPS URL과 실제 문서 바이트의 32-byte SHA-256을 함께
  저장한다. API는 이를 `documents[locale] = {url, sha256}`으로 projection한다.
- 발행된 문서의 content 필드와 locale URL/SHA는 수정·삭제하지 않으며 새 version을
  발행한다. 현재 acceptance 판정은 snapshot hash와 선택 locale의 현재 행까지 비교한다.
- UGC 동의 RPC에서 사용자는 현재 이용약관과 커뮤니티 지침 2종의
  `version`·`locale`만 제출한다.
  서버는 해당 locale 행의 hash를 동의 시점 snapshot으로 복사한다.
- 개인정보처리방침은 고지 대상이며 UGC 동의 RPC의 입력 대상이 아니다.
  위치약관은 별도 위치 동의 API가 locale/hash snapshot을 기록한다.
- 현재 시행 정책이 4종 또는 locale별 metadata가 불완전하면 정책 조회와 신규
  공유를 fail closed한다. 실제 production URL·hash seed와 운영 승인은 별도 배포
  블로커이며 이 스키마가 그 값을 자동 생성하지 않는다.

### 서버 전용 Data API 스키마

`api_private`는 PostgREST에 노출하되 스키마 `USAGE`와 함수 `EXECUTE`를
`service_role`에만 부여한다. `PUBLIC`·`anon`·`authenticated`는 스키마
사용과 함수 실행이 모두 금지된다.

| 함수 | 목적 |
|---|---|
| `list_public_spots` | 완전한 6개 언어 지역·스팟·카드와 콘텐츠 버전을 안정 정렬해 반환 |
| `get_user_collection` | 활성 identity를 잠그고 커서 페이지·통계·개인카드 공유상태를 반환 |
| `get_owned_personal_card_photo` | 활성 소유자의 개인카드 사진 경로만 서버에 반환 |
| `acquire_context` | 활성 바인딩·게이트·멱등성·스팟·카드 확인 후 POI 판정 문맥 반환 |
| `acquire_commit` | 판정 문맥 재확인, KST 일일 제한, 순번·획득·성공 이벤트 원자 저장 |
| `record_acquire_failure` | 좌표 없이 제한된 5개 실패 코드만 서버 이벤트로 저장 |
| `get_published_card_asset` | 공개 중인 open 스팟 카드의 Storage 경로를 서버에만 반환 |
| `issue_participant_invites` | 현재 `admin_members` 자격으로 해시만 있는 1회용 초대코드 발급 |
| `redeem_participant_invite` | 초대코드 원자 소모와 참여 자격 부여, 5회/15분 잠금 |
| `issue_recovery_code` | 획득 1건 이상 비-reviewer 사용자의 이전 활성 digest 철회 후 신규 digest 발급 |
| `claim_recovery_code` | 익명·획득 0건 사용자의 원자적 바인딩 이전·코드 소모·자격 병합 |
| `ingest_client_events` | 최대 20건의 2종 클라이언트 이벤트를 엄격 검증·중복 제거 후 저장 |
| `create_physical_request` | `(user_id, kind)` 멱등 수요 저장과 최초 1회 `physical_interest` 생성 |
| `has_active_identity` | 다른 제품 RPC를 거치지 않는 보호 API의 현재 활성 바인딩 재검사 |
| `get_access_projection` | 활성 바인딩·참여 자격·reviewer DB membership을 재검사해 안전한 접근 유형만 반환 |
| `get_email_link_eligibility` | Auth 변경 전 활성 바인딩과 reviewer 영구 이력을 fail-closed로 재검사 |
| `revoke_reviewer_access` | 영구 reviewer 이력을 대상으로 membership 삭제 후 잔여 상태까지 reviewer·participant·활성 identity·복구코드 철회와 공유 `private` 전환을 하나의 service-role 트랜잭션으로 수행 |
| `provision_reviewer_access` | 관리자·Auth invariant·content/policy를 잠근 뒤 fixture version과 샘플 사진 hash에 결속된 provision을 prepare |
| `reset_reviewer_access` | 활성 reviewer의 같은 결정적 core fixture를 유지하면서 개인카드 사진 객체·share secret 회전을 prepare |
| `complete_reviewer_access_fixture` | Storage 객체 설치 후 participant membership·6 retro·개인카드·승인 공유·inventory·감사를 한 트랜잭션으로 확정 |
| `revoke_reviewer_access(admin,user,action)` | 관리자 멱등 원장과 함께 reviewer·participant·identity·복구·공유를 원자 철회하고, 모든 완료/미완료 사진 exact path의 digest tombstone을 먼저 남긴 뒤 Storage 정리 대상을 서버에 반환 |
| `issue_personal_card_temp_upload` | 활성 바인딩·게이트·현재 UGC 정책 동의·MIME·크기 확인 후 서버 소유 임시 경로 발급 |
| `begin_personal_card_promotion` | 현재 UGC 정책 동의를 재검사하고 10분 안의 소유 경로·획득에 5분 처리 lease를 획득 |
| `complete_personal_card_promotion` | lease 재검증 후 개인화 카드와 `personal_card_created` 이벤트를 원자 저장 |
| `release_personal_card_promotion` | 외부 Storage/변환 실패 시 처리 lease를 안전하게 해제 |
| `mark_personal_card_temp_deleted` | 즉시 임시 객체 삭제 성공 시 메타데이터에 표시 |
| `list_personal_card_temp_cleanup` | 서명 URL 만료 10분 후 `SKIP LOCKED`로 최종 정리 대상을 lease 처리 |
| `complete_personal_card_temp_cleanup` | Storage 재삭제 성공 후 삭제·최종 정리 시각을 함께 확정 |
| `list_personal_card_expiry_cleanup` | 10분 승격 창이 닫힌 미승격 원본을 처음 삭제하도록 lease |
| `create_personal_card_share` / `revoke_personal_card_share` | 참여·공유 생성 게이트를 분리하고 생성은 `pending`만 허용하며, 철회는 즉시 비공개 처리 |
| `get_personal_card_share_status` | 현재 소유자에게만 상태·secret·사유·검수시각을 반환 |
| `get_public_share` | `active`이고 viewer가 소유자를 차단하지 않은 공유만 안전 projection 반환 |
| `create_user_block` / `list_user_blocks` / `revoke_user_block` | active secret에서 소유자를 내부 해석하고 blocker 단위 제한·opaque keyset 차단 목록·해제를 제공 |
| `get_current_policies` | 현재 시행 중이며 6개 locale metadata가 완전한 정책 4종 반환 |
| `accept_current_policies` | 현재 이용약관·커뮤니티 지침의 locale/hash 동의 snapshot 원자 저장 |
| `create_content_report` | active secret을 내부 해석하고 공개 신고 멱등성·HMAC hash rate limit 적용 |
| `list_share_moderation_queue` | 현재 관리자에게만 slug·소유자 ID·Storage 경로 없는 검수 projection 반환 |
| `get_moderation_share_photo` | 현재 관리자에게만 검수 대상 private 사진 경로 반환 |
| `moderate_personal_card_share` | 승인·거절·게시중단·재제출·소유자 정지와 감사 원장 원자 저장 |
| `list_content_reports` | 현재 관리자에게 최소 신고 projection 반환 |
| `moderate_content_report` | 신고 기각·게시중단·소유자 정지와 감사 원장 원자 저장 |
| `list_share_owner_suspensions` / `moderate_share_owner_suspension` | logical user ID 없는 정지 목록과 카드 독립 해제 |
| `record_landing_view` | `sns`·`share`·`direct` 3종만 비인증 서버 이벤트로 저장 |
| `grant_retro_acquisition` | 현재 DB 관리자만 소급 획득·감사 원장·이벤트를 원자적 생성 |
| 인증 rate-aware domain wrappers | collection·acquire·events·참여 쓰기·관리자 mutation의 고정 60초 용량 소비와 실제 도메인 처리를 동일 트랜잭션에서 수행 |

`participant_access`의 일반 초대·복구 upsert는 활성 권한을 낮출 수 없다. 활성
`reviewer_accounts`가 있으면 `store_reviewer`를 유지하고, 활성 `public_beta`는
`internal_tester`로 내려가지 않는다. reviewer를 명시적으로 철회할 때는 먼저
`reviewer_accounts.revoked_at`을 기록한 뒤 참여 권한을 철회하거나 재발급한다.

`private`와 `analytics`는 Data API 노출 스키마가 아니며 `anon`과
`authenticated`에 테이블 권한을 부여하지 않는다.

`api_private` 함수는 모두 `SECURITY DEFINER` + 빈 `search_path`를 사용하고
`PUBLIC`·`anon`·`authenticated`의 실행권한을 회수한 후 `service_role`에만
부여한다. 모든 보호 쓰기 RPC는 활성 `user_identities` 행을 `FOR SHARE`로
잠그고, claim은 동일 행을 `FOR UPDATE`로 잠금으로써 폐기될 사용자에
쓰기가 커밋되는 경쟁을 차단한다. 복구 발급과 claim은 같은 대상 사용자
advisory lock을 먼저 사용해 식별자→코드/코드→식별자 교차 잠금을 없앤다.

### 서버 RPC JSON 결과

- `issue_participant_invites`: `created` + `count` / `unauthorized` / `forbidden`
- `redeem_participant_invite`: `redeemed` / `not_found` / `unauthorized` /
  `rate_limited` + `locked_minutes`
- `issue_recovery_code`: `issued` / `unauthorized` / `no_acquisition` / `reviewer_forbidden`
- `claim_recovery_code`: `restored` / `unauthorized` / `not_found` / `not_empty` /
  `not_anonymous` / `rate_limited` + `locked_minutes`
- `ingest_client_events`: `accepted` + `accepted`·`duplicates` / `unauthorized` /
  `gate_closed` / `invalid`
- `create_physical_request`: `created` / `duplicate` / `unauthorized` / `gate_closed`
- `has_active_identity`: `active` / `inactive`
- 인증 rate-aware domain wrapper는 원래 도메인 결과 또는 `rate_limited` + 1~60 재시도 초를 반환한다. 호출자는 limit을 전달할 수 없고 wrapper가 `collection_read=60`, `acquire=10`, `event_batch=12`, `participant_write=30`, `admin_mutation=30` 중 정확한 목적을 고정한다. `private.consume_authenticated_api_rate_limit`는 Data API 실행권한이 없는 내부 helper이며 독립 service RPC로 호출할 수 없다.
- `get_access_projection`: `ready` + `participant`·`access_type`·`field_acquisition_requires_location=true`·`fixture_version` / `unauthorized`
- `get_email_link_eligibility`: `eligible` / `reviewer_forbidden` / `unauthorized`
- `revoke_reviewer_access`: `revoked` + 철회·비공개 처리 행 수 / `not_found`
- 개인화 카드 RPC: `issued`·`ready`·`created`·`already_created` 등
  단계별 상태만 반환하며, Storage 경로는 DB가 생성한 해당 사용자 폴더 값만 반환한다.
- `list_public_spots`: `{content_version, spots:[...]}`. 각 이름·제목은 6개 언어
  객체이고 `teaser.card`는 `null`이다.
- `get_user_collection`: `ready` / `unauthorized` / `invalid`. `ready`는 최대
  `limit`개 `items`, `has_more`, 다음 `(acquired_at,id)` 앵커, `total_acquisitions`·
  `spots_visited`·`personal_cards` 통계를 반환한다. `spots_visited`는 `gift`를 제외한다.
- `get_owned_personal_card_photo`: `found` + `photo_path` / `unauthorized` / `not_found`.
- `get_current_policies`: `ready` + 정책 배열 / `not_ready`.
- `accept_current_policies`: `accepted` / `policy_required` + 현재 두 필수 정책 /
  `invalid` / `unauthorized`.
- `create_personal_card_share`: `pending` / `existing` + `share_state` /
  `participant_gate_closed` / `share_creation_gate_closed` / `policy_required` /
  `account_suspended` / `slug_conflict` / `unauthorized` / `not_found`.
- `get_personal_card_share_status`: `found` + 상태·secret·사유·제출/검수 시각 /
  `unauthorized` / `not_found`.
- `get_public_share`: `found` / `not_found` / `unauthorized`. 선택적 viewer 인증값을
  제공했는데 활성 identity가 아니면 `unauthorized`이고, 미제공 공개 조회는 허용한다.
- `create_content_report`: `received` / `rate_limited` + 재시도 초 /
  `idempotency_conflict` / `invalid` / `not_found`.
- 관리자 목록/사진 RPC: `ready|found` / `unauthorized` / `forbidden` /
  `invalid|not_found`.
- 관리자 조치 RPC: `applied|duplicate` / `idempotency_conflict` /
  `conflict` + 제한된 사유 / `unauthorized` / `forbidden` / `invalid|not_found`.

### v0.4.0 reviewer fixture lifecycle

- 구현됨: 영구 reviewer 이력·Auth credential 잠금·재활성화 금지와 함께 관리자
  endpoint 3개, service-role-only prepare/complete/revoke, 결정적 서울 6개 retro,
  metadata-free WebP 샘플 개인카드 1개, 현재 정책 snapshot의 승인 공유 1개,
  append-only inventory/감사, reset 시 사진 객체·share secret 회전
- provision prepare는 credential을 먼저 동결하지만 Storage 설치와 complete 전에는
  `participant_access`를 만들지 않는다. complete가 모든 DB fixture를 원자 적용하며,
  응답 유실 재시도는 같은 `client_action_id`와 payload로 같은 결과를 돌려준다
- reset complete는 교체되는 이전 사진 exact path의 digest-only tombstone을 같은
  owner-locked 트랜잭션에 남겨, 외부 삭제 뒤 지연된 reset 전 Storage upload가 이전
  객체를 재생성하지 못하게 한다
- reviewer 정책 snapshot의 `acceptance_source=reviewer_fixture`는 운영 fixture임을
  명시하며 실제 사용자의 자발적 동의로 해석하지 않는다. reset 시 현재 정책에
  `acceptance_source=user`인 기존 행이나 결정적 ID·영문 locale·SHA-256가 다른 행이
  있으면 이를 fixture 동의로 재사용하지 않고 전체 reset을 409로 되돌린다
- DB·fixture·감사에는 이메일·비밀번호·access/refresh token·raw share secret을
  저장하지 않는다. Auth 계정 생성과 credential 전달은 Supabase Admin API·비밀 관리자·
  Store Console 비공개 필드의 별도 운영 경계다
- provision은 단일 활성 identity 외 참여·획득·정책·위치·UGC·분석·삭제 이력이 전혀
  없고 `auth.users.last_sign_in_at`도 null인 전용 논리 사용자만 허용한다. 이 검사는 최초
  provision에만 적용해 지정 후 정상 reviewer sign-in과 이후 reset은 허용한다. 실제 사용자
  데이터를 reviewer fixture로 전환하지 않는다
- revoke와 계정삭제는 append-only action의 완료·미완료 사진 object를 모두 수집한다.
  revoke는 각 exact path의 역산 불가 HMAC tombstone을 원자 철회와 함께 남겨,
  외부 삭제가 아직 없는 object를 본 뒤 느린 upload가 commit하는 경합도 차단한다.
  계정삭제 trigger는 이를 기존 2-pass Storage manifest에 합쳐 prepare 직후 orphan도 남기지 않는다

로컬 실제 GoTrue Admin `createUser`부터 HTTP provision/reset/revoke까지는 자동 검증한다.
남은 제출 조건은 Apple·Google별 원격 계정 생성, hosted Storage/Auth canary, 실제 후보
IPA/AAB의 Review Notes 경로와 세션 후속 철회 검증이다.

## 4. 획득 무결성

- 현장 획득은 `(user_id, spot_id, acquired_on_kst)` 부분 고유 인덱스로
  동일 사용자·동일 스팟·KST 하루 한 번만 허용한다.
- `acquired_on_kst`는 서버 저장시각에서 생성되는 저장 열이며 클라이언트가 쓰지 않는다.
- idempotency는 `(user_id, idempotency_key)`로 고유하다.
- 현장 순번은 `(card_id, field_sequence)`로 고유하고 1 이상의 값만 허용한다.
- `retro`와 `gift`는 `field_sequence`를 갖지 않으며 현장 일일 제한에 포함되지 않는다.
- `retro` 획득과 감사 원장은 1:1이며 감사 행을 삭제·이동하거나 획득 유형을
  바꾸어 불일치를 만들 수 없다.
- 획득 카드와 스팟은 복합 외래키로 일치해야 한다.
- 사용자 원시 좌표·정확도 열은 `acquisitions`와 `analytics.events`에 존재하지 않는다.
- 분석 이벤트 속성은 중첩 객체·배열을 포함해 위치 관련 키를 거부한다.
- 비정상 이동은 원시 좌표 대신 `implausible_transition` 파생 플래그만 보존한다.

동시 획득은 `acquire_commit`이 게시 카드를 먼저 `FOR SHARE`, 스팟을 다음
`FOR SHARE`로 잠그고 공개 상태·완전성·설정 버전을 재검사한 뒤 멱등성 →
KST 일일 순서로 트랜잭션 advisory lock을 잡고 카드 카운터 행을 갱신한다. 순번 갱신·획득
삽입·`acquire_success` 삽입은 하나의 서브트랜잭션이며, 어느 하나라도
실패하면 카운터도 롤백되어 결번을 만들지 않는다. POI 간 비현실적
이동 파생 플래그는 2 km 미만을 제외하고 180 km/h 초과일 때만 설정하며,
차단 근거가 아닌 내부 진단 정보로만 쓴다.

### 획득 RPC JSON 계약

- `acquire_context`: `ready` 시 `user_id`, POI 기준좌표·반경·정확도·
  `updated_at`, 공개 카드 문맥을 반환한다. 이 응답은 Route Handler 내부에서만
  소비하고 클라이언트에 그대로 전달하지 않는다.
- `acquire_context`: 기존 성공 키면 `replay` + 획득·카드 정보를 반환한다.
- `acquire_commit`: 신규 성공은 `created`, 재요청은 `replay`를 반환한다.
- 오류는 `{ "status": "error", "code": "..." }`이다. 공통 코드 외에 commit은
  `ALREADY_ACQUIRED_TODAY`·`SPOT_CONFIG_CHANGED`를 반환한다.
- `replay`·`created` 페이로드는 `field_sequence`, 비정상 이동 플래그,
  판정 임계치를 포함하지 않는다.
- 첫 획득 이후 카드의 `spot_id`·`kind`·호환 제목·`sketch_path`·`color_hex`와
  6개 언어 번역은 변경할 수 없다. 획득 삽입은 카드에 `FOR SHARE`를 사용하여
  비키 UPDATE와도 직렬화한다. 콘텐츠 교체는 새 `card_id`를 가진 새 카드
  버전으로 수행해 기존 멱등 응답을 유지한다.
- 이미 획득된 카드의 자산은 이후 스팟 중지·카드 비공개 상태에서도
  `get_published_card_asset`이 반환하여 재현 응답의 이미지를 유지한다.

## 5. 권한·RLS 행렬

| 직접 테이블 접근 | `anon` | `authenticated` | 서버 전용 역할 |
|---|---|---|---|
| `spots`, `cards` | 없음 | 없음 | 보안정의 RPC 경유 |
| `regions`, 3개 번역 테이블 | 없음 | 없음 | 보안정의 RPC 경유 |
| `app_users` | 없음 | 없음 | 보안정의 RPC 경유 |
| `acquisitions` | 없음 | 없음 | 보안정의 RPC 경유 |
| `personal_cards` | 없음 | 없음 | 보안정의 RPC 경유 |
| `physical_requests` | 없음 | 없음 | 보안정의 RPC 경유 |
| 정책·신고·검수 `private.*`, `analytics.*` | 없음 | 테이블 접근 없음 | 보안정의 RPC 경유 |

Stage 0의 공개·본인 데이터도 계약에 정의된 `/api` Route Handler를 통해서만
반환한다. 이는 전체 테이블 SELECT 권한으로 `field_sequence`, 비정상 이동 플래그,
판정 임계값, 원본 Storage 경로가 노출되는 것을 막기 위한 결정이다.

RLS 정책은 직접 권한이 잘못 추가되더라도 행 소유권을 제한하는 방어선이다. 익명
로그인 이용자도 DB 역할은 `authenticated`이므로 모든 본인 정책은
`private.current_user_id()`와 행의 `user_id`를 함께 비교한다. 관리자 판단은
사용자가 수정할 수 있는 metadata가 아니라 `private.admin_members`의 현재 행을 사용한다.

`private.current_user_id()`, `private.is_admin()`,
`private.has_participant_access()`만 RLS 평가를 위해 `authenticated` 실행을
허용한다. 함수는 고정된 빈 `search_path`와 완전 수식 객체명을 사용하며 다른
함수의 기본 `PUBLIC EXECUTE`는 회수한다.

## 6. Storage

- `personal-card-temp`: 비공개 임시 업로드. PNG/JPEG/WebP, 최대 10 MiB,
  `<app_user_id>/<upload_id>.<ext>` 고정 경로와 발급 후 10분 승격 제한.
- `personal-cards`: 서버가 매직 바이트·크기·디코딩을 검증하고 재인코딩한
  파생본만 저장하는 비공개 영구 버킷.
- `card-assets`: 공개 일러스트 콘텐츠 버킷. API는 Storage 경로 대신
  `/api/card-assets/:card_id`를 노출하고 서버가 자산을 스트리밍한다.
- 브라우저 쓰기 Storage 정책은 없다. 서명 URL 발급·승격·정리는
  `service_role`를 사용하는 Route Handler가 담당한다.
- `personal_cards.photo_path`는 해당 논리 사용자 ID 폴더로 시작해야 한다.
- 클라이언트 EXIF 제거·리사이즈는 최적화이며, 보안 경계는 서버 재인코딩이다.
- 서명 업로드 URL의 Supabase 만료는 마지막 토큰 발급에서 2시간이고, 서버 승격
  허용은 최초 URL 발급 시각에서 10분인 불변 `promotion_expires_at`을 기준으로 한다.
  같은 논리 사용자·`client_request_id`·MIME·size 재시도는 이 최초 10분 안에서만
  같은 reservation/path의 토큰을 다시 발급하며 active slot·rolling quota를 재소비하지
  않는다. payload 충돌 또는 만료·승격·처리·정리된 reservation 재사용은 거부한다.
- 10분이 지난 미승격 원본은 1차 정리 대상으로 만든다. 선택한 5분 scheduler가
  45초 soft·48초 hard 예산 안에서 4건씩 반복 처리하므로 10분 직후 삭제를
  보장하지 않되, backlog·최고 대기시간을 운영 경보한다.
- 서명 URL이 아직 유효한 동안 재업로드될 수 있으므로 2시간 만료 뒤
  10분의 safety margin을 둔 후 같은 경로를 다시 삭제하고 최종 정리로 표시한다.
- `signed_url_expires_at`은 `signed_url_last_issued_at + 2시간`으로 DB가 강제한다. 승격·
  검증 실패 후 임시 객체를 즉시 지울 수는 있으나, 서명 토큰 재업로드에
  대비한 최종 cleanup 완료는 2시간 만료 + 10분 이후에만 표시한다. 정리 큐
  인덱스는 `signed_url_expires_at` 기준이다.
- 서버의 Supabase 요청은 30초 후 중단하고 업로드 URL 발급 Route의 실행 상한은
  60초로 고정한다. 따라서 실제 토큰 발급 지연이 최종 정리의 10분 안전 여유를
  넘지 않도록 애플리케이션 경계에서도 제한한다.
- 승격 처리 lease는 최대 5분이며 최초 10분 승격 창을 넘을 수 없다. 토큰은
  `acquisition_id`·캡션·`<user_id>/<processing_token>.webp` 영구 경로와 함께 고정한다.
- 서버는 실제 매직 바이트·MIME·선언 크기·40MP 상한·단일 프레임·디코딩을
  확인한 후 자동 회전, 최대 2048px, WebP 재인코딩을 수행한다. EXIF를 포함한
  원본 메타데이터는 파생본에 복사하지 않는다.
- Vercel 정리 작업은 `CRON_SECRET` bearer 검증 후 Storage API로 객체를
  삭제한다. SQL로 `storage.objects`를 직접 삭제하지 않는다.
- 공유는 원본 Storage 경로가 아닌 단기 서명 URL 또는 이미지 프록시를 사용한다.
- 소유자 공유 URL은 `/share#SECRET`이고 fragment secret은 HTTP path·query에
  전송되지 않는다. 브라우저는 이를 메모리로 한 번 읽은 즉시 `/share`로
  지우며, legacy secret path는 redirect 없이 404다.
- 공개 해석·WebP 사진·신고·차단은 fixed `/api/public-share/*` POST와
  strict JSON body의 `share_secret`만 사용한다. 해석 응답은 KST 일자·6개
  언어 스팟명·캡션 원문·`photo_available`만 내보내고 URL을 내보내지
  않는다. 사진 POST는 매 요청마다 현재 `share_slug`를 재검사해 철회를
  즉시 반영한다.
- web 연령 attestation은 DB 스키마를 추가하지 않는 30분 HMAC cookie다.
  DOB는 기기에서만 Asia/Seoul 달력으로 판정·폐기하고 서버는 pass/version만
  받는다. 만 18세
  미만으로 확인되면 현재 shell을 재입력 없는 상태로 잠그며, 잘못된
  날짜 형식만 정정할 수 있다.
- fixed 공개 차단은 web cookie와 분리한다. publication 404를 먼저 판정한 뒤 필수
  bearer JWT의 active identity와 `minimum_age_attestations`를 검증하고 strict body를
  읽는다. 공개 web의 resolve·photo·report는 signed age cookie 경계를 유지한다.

## 7. 공유·소급 무결성

- 공유 secret은 편향 없는 표본 추출로 만든 base62 22자를 사용한다. 신규 공유는
  소유권·참여 게이트·공유 생성 게이트·현재 정책 동의·소유자 정지를 확인한 후
  `pending`만 생성한다. `PUBLIC_SHARE_CREATION` 기본값은 false다.
- `PUBLIC_SHARE_CREATION`은 새 secret 생성과 acceptance snapshot 갱신이 필요한
  재제출만 통제한다. 상태를 바꾸지 않는 기존 공유 멱등 반환·소유자 상태 조회·철회는
  이 flag와 무관하다.
- 공유 상태는 `private|pending|active|rejected|taken_down`으로 고정한다. 오직
  관리자 검수 RPC만 `pending → active|rejected`를 만들 수 있고, 일반 사용자는
  `private → pending` 제출과 모든 상태에서의 즉시 철회만 할 수 있다.
- UGC 전진 마이그레이션은 기존 slug를 모두 `null`로 무효화하고 해당 공유를
  `private`, `share_resubmission_required=true`,
  `share_reason_code=LEGACY_SLUG_ROTATION_REQUIRED`로 전환한다. 제출 gate가 열린 뒤
  최신 정책 동의와 새 secret으로 재제출·재검수해야 하며 기존 secret은 재사용하지 않는다.
- `approve`는 공유 제출에 고정된 이용약관·커뮤니티 acceptance가 각각 현재 시행본이고
  소유자가 정지되지 않은 경우만 허용한다. `reinstate`는 `pending`과 재제출 필요
  상태로만 되돌리며 자동 공개하지 않는다.
- current set publication은 exclusive `danyeodam:policy-current-set` lock을 사용하고,
  upload-url 발급·개인카드 승격·공유 제출·승인은 current acceptance 확인 전 같은
  키의 shared lock을 획득한다. 공유 제출은 이 lock을 소유자/card lock보다 먼저,
  승인은 moderation·소유자/card lock보다 먼저 잡아 작업 완료까지 snapshot을 고정한다.
- `take_down`은 해당 공유를, `suspend_owner`는 소유자의 모든 `pending|active`
  공유를 `taken_down`으로 바꾸고 신규 제출을 차단한다. 해제 역시 기존 공유를
  자동 공개하지 않는다. 모든 관리자 mutation은 관리자별 `client_action_id`로
  멱등 처리하고 변경 불가능한 `moderation_actions` 원장에 전후 상태를 남긴다.
- 신규 제출·공유/신고 기반 소유자 정지·정지 해제는 모두
  `danyeodam:suspend-owner:<logical-user-id>` transaction advisory lock을 먼저 공유하고,
  잠금 뒤 활성 정지를 다시 검사한다. 정지와 신규 제출이 겹쳐도 정지 뒤 새 pending
  secret이 남지 않는다.
- `PUBLIC_SHARE_PUBLICATION` 기본값은 false다. false이면 관리자 `approve|reinstate`는
  service-role RPC에서도 `publication_gate_closed`로 거부하며, 기존 `active` 상태를
  바꾸지 않고 public JSON·사진·신고·차단 RPC는 모두 `not_found`로 fail closed한다.
  true일 때만 public share JSON·사진은 `active`이고 소유자가 정지되지 않은 경우 반환한다.
  인증 viewer가 소유자를 차단한 경우도 404다. 다른 상태·정지·미존재는 모두
  404다. 검수 사진 프록시는 관리자 membership과
  대상을 요청마다 재검사하며 Storage 경로를 응답하지 않는다.
- 공개 신고는 active secret을 RPC 안에서 해석한다. DB에는 raw slug나 raw IP를
  넣지 않고 secret SHA-256과 날짜 없는 purpose-domain HMAC reporter key hash만 보관한다.
  `client_report_id`는 동일 payload 재시도를 재현하고 다른 payload 재사용은 충돌로
  거부한다. reporter key별 기본 1시간 5회이며 UTC 자정을 지나도 같은 window를
  유지하고 rate-limit 행은 마지막 요청 후 48시간 정리 대상이다. 신고는 report-id
  lock 뒤 소유자 정지와 같은 owner advisory lock을 획득하고 active·정지 상태를
  다시 검사한 뒤 카드 `FOR SHARE`를 유지하므로 정지와 경합한 숨김 신고는 404다.
- 철회는 공유 상태와 secret·심사 표식을 즉시 `private`로 되돌린다. secret을
  로그·분석·오류 추적에 남기지 않으며 유효한 `share_view`도 해석된 카드 ID만 쓴다.
- 모바일 인증 사용자는 active secret에서 내부 해석한 소유자를 서버 차단한다.
  목록에는 opaque 차단 ID와 생성시각만 반환하며 owner UUID·slug는 노출하지 않는다.
  무인증 웹 로컬 숨김은 보조 UX이고 서버 차단을 대체하지 않는다. 신고와 차단은
  서로 독립이다. 발견·상호작용 기능을 추가하면 모든 관련 쿼리에 차단을 강제한다.
- 검수 완료 상태는 `share_reviewed_by` 또는 `share_reviewed_by_redacted_at` 중 정확히
  하나를 보존한다. 계정삭제 redaction 뒤 새 moderation은 reviewer UID를 기록하고
  redaction marker를 지운다.
- 소급 획득은 `(user_id, spot_id)`당 한 건만 허용하고 순번을 배정하지
  않는다. `retro_grants` 감사 행과 `retro_granted` 서버 이벤트는
  획득과 같은 트랜잭션에서 한 번만 생성하며, 관리자 메모는 1~500자로 필수다.
- 소급 지급은 관리자와 대상의 활성 identity를 복구 claim과 같은 정렬 순서로
  `FOR SHARE` 잠근다. 활성 identity가 없는 논리 사용자에는 지급하지 않으며,
  동시 claim은 지급 완료 후 획득 존재 여부를 다시 확인한다.

## 8. 분석 이벤트 경계

- 클라이언트: `spot_view`·`physical_interest_view`. `user_id`·`client_event_id`가
  모두 필수다. `acquire_attempt`·`personal_card_started`는 exact-erasure 상관키가
  없어 cutover에서 기존 client 행을 폐기하고 이후 입력을 거부한다. 위치 시도 지표는
  서버 `location_use_facts`로 대체한다.
- 클라이언트 배치는 1~20건, 발생 시각은 수신 기준 24시간 이내·미래
  5분 이내만 허용한다. `spot_id`는 실제 스팟이어야 하며 배치는
  `(user_id, client_event_id)`로 `ON CONFLICT DO NOTHING` 중복 제거한다.
- 비인증 서버: `landing_view`·`share_view`. `user_id`·`client_event_id`는 모두
  `null`이다. `share_view`는 raw secret 대신 해석된 `personal_card_id`만 저장하고
  props는 정확히 `{}`이다. 마이그레이션은 기존 raw-slug 공유 이벤트를 삭제한다.
- 인증 서버: 나머지 서버 이벤트. `user_id`는 필수이고
  `client_event_id`는 `null`이다.
- props는 이벤트별 정확한 JSON 형태만 허용한다. `acquire_fail.code`는
  `OUT_OF_RANGE`·`LOW_ACCURACY`·`ALREADY_ACQUIRED_TODAY`·`SPOT_NOT_OPEN`·
  `GATE_CLOSED`만 허용한다.
- 위치 관련 키 재귀 차단 제약은 props 허용 제약과 독립적으로 유지한다.
- `landing_view`는 랜딩 서버 렌더링에서, `share_view`는 유효한 공개
  fixed resolve POST에서만 생성한다. 없는·철회된 secret은 조회 이벤트를 남기지
  않는다.
- `revisit`은 첫 획득의 다음 KST 날짜부터 인증된 컬렉션 조회에서 서버가 생성한다.
  `(user_id, revisit_on_kst)` 부분 고유 인덱스로 사용자별 KST 하루 한 번만 저장한다.

## 9. 스키마에 포함하지 않은 콘텐츠

스팟·카드 시드는 이 PR에 포함하지 않는다. 좌표·반경·정확도 임계값은 TRUST의
현장 실측과 운영 승인을 거친 뒤 별도 변경으로 추가한다. 따라서 현재 마이그레이션은
서울 스팟 수나 명칭을 추측해 고정하지 않는다.

## 10. API-CONTRACT v0.3.8 fragment 전송 누적 반영 결과

기존 v0.2.3 기준선 위에 다음 전진 변경을 반영했다.

1. 승인 감사가 있는 6개 언어 지역·스팟·카드 번역과 완전성·불변성 통제.
2. 공개 콘텐츠 정렬 순서·버전과 서버 전용 스팟 목록 RPC.
3. 커서·통계·KST revisit를 포함한 소유자 컬렉션과 사진 소유권 RPC.
4. 획득 결과·문맥의 6개 언어 응답과 카드 → 스팟 고정 잠금 순서.
5. 공유 상태 전환과 레거시 재제출 표식, `active` 전용 public read.
6. raw share slug 분석 데이터 삭제와 `personal_card_id` 기반 `share_view`.
7. 선택적 viewer 인증과 `active` 전용 6개 언어 공개 공유 RPC.
8. 공개 스팟의 draft-first 카드 교체 절차와 동시 retirement 경합 제거.
9. `private|pending|active|rejected|taken_down` 공유 상태 정규화와 정책 acceptance FK.
10. locale별 URL·SHA-256이 완전한 현재 정책 조회와 version/locale 동의 snapshot.
11. raw secret/IP가 없는 공개 신고 원장, 멱등 키, HMAC 기반 최소 rate limit.
12. 관리자 검수 queue·사진·공유/신고 조치와 append-only 감사, 소유자 공유 정지.
13. 소유자 상태 조회·즉시 철회와 정지 포함 `active` 전용 fail-closed 공유/사진 조회.
14. 사용자 차단/opaque 해제와 viewer별 JSON·사진 fail-closed, 차단 멱등/rate 원장.
15. 사진 upload-url·승격 전 정책 동의, 발행 정책 불변성과 locale hash 재검사.
16. 카드 독립 opaque suspension 해제와 reviewer redaction-compatible 검수 표식.
17. current 정책 전환 전용 RPC와 acceptance가 공유하는 advisory lock, locked-ID 동의 재검사.
18. target과 무관한 blocker 단위 차단 rate advisory lock.
19. opaque block ID만 반환하는 사용자 귀속 서명 cursor·keyset pagination.
20. `PUBLIC_SHARE_CREATION`과 `PUBLIC_SHARE_PUBLICATION`의 독립 fail-closed 경계.
21. 모든 legacy raw slug 무효화·private 재제출 표식과 새 secret 회전.
22. 소유자 정지·해제와 신규 공유 제출의 논리 사용자 단위 직렬화.
23. upload-url·승격·제출·승인까지 확장한 current-policy shared lock snapshot.
24. UTC 자정과 무관한 purpose-domain reporter HMAC과 연속 1시간 제한.
25. 소유자 정지와 공개 신고의 owner→card lock 순서 및 suspended-owner 404.
26. owner `/share#SECRET`·fixed public POST로 URL path/query secret 제거.
27. 30분 domain-separated HMAC web 연령 attestation과 만 18세 미만 fail-closed UX.
28. 6개 browser locale shell, secret 비존재 DOM/storage/log 경계, 15초·unmount abort.

## 11. 마이그레이션·검증 규칙

- 기존 마이그레이션을 수정하지 않고 새 타임스탬프 파일로 전진 변경한다.
- `20260811164317_share_state_privacy_cutover.sql`은 기존 획득·개인카드가 있는
  DB에도 먼저 적용한다. 레거시 slug를 당시 중간 상태인 `pending_review`로
  전환하고 `active`를 hard-block하며 raw `share_view`를 삭제한다. localized
  migration이 뒤에서 중단되더라도 기존 2-인자 public read는 `not_found`, 기존
  share 생성은 `share_creation_gate_closed`로 닫고 소유자 revoke는 계속 동작한다.
- 이어지는 `20260811164318_localized_content_model.sql`은 시작 시
  `acquisitions`가 비어 있어야 한다. 기존 획득 카드에는 승인된 일본어·중국어
  간체·번체·베트남어 원문이 없고 임의 번역이나 fallback은 금지되므로, 획득이
  한 건이라도 있으면 localized DDL 전에 명시적으로 중단한다. 이는 배포 가능한
  상태가 아니라 운영 blocker다. nonempty 환경은 실제 6개 언어 TRUST 데이터와
  승인자를 포함한 별도 staged migration 없이는 localized slice와 후속 RPC를
  적용할 수 없다.
- `20260811181209_ugc_policy_and_moderation.sql`은 위 중간 6-state 공유 enum을
  최종 5-state canonical enum으로 정규화하고 모든 기존 slug를 폐기한 뒤
  private 재제출 상태로 전환하며 정책·신고·검수 모델과 서버 전용 RPC를 추가한다.
  이 파일이 저장소에 존재하는 것만으로 원격 적용·운영 준비
  완료를 의미하지 않으며 아래 reset·pgTAP·API 테스트와 실제 정책 seed가 필요하다.
- 빈 로컬 DB에서 `supabase db reset --local`이 재현되어야 한다.
- `supabase test db --local`로 pgTAP 테스트를 통과해야 한다.
- `npm run db:test:concurrency`로 초대 동시 소비, 복구 발급↔claim,
  reviewer 지정↔복구 발급, reviewer 지정↔claim target/current, email identity
  link-first↔지정, 지정-first↔Auth credential 변경, 획득↔claim, 소급 지급↔claim,
  current 정책 전환↔동의, 서로 다른 target의
  blocker rate 경합, 소유자 정지↔신규 공유 제출을 포함한 실제 다중 연결 잠금
  시나리오를 통과해야 한다.
- `npm run build` 후 `npm run api:test:personal-card`로 실제 로컬 Auth·Storage·
  Route Handler·DB를 통한 서명 업로드, WebP 재인코딩, 이벤트 저장,
  임시 원본 삭제를 확인해야 한다.
- `npm run api:test:share-retro`로 공유 안전 projection·사진 프록시·viewer 차단/해제·즉시
  철회·관리자 소급 멱등성·랜딩/공유 서버 이벤트를 관통 검증해야
  한다.
- `npm run api:test:localized-read`로 6개 언어 스팟 목록·컬렉션·소유 사진·
  공유 read를 Route Handler부터 DB까지 관통 검증해야 한다.
- `npm run api:test:auth-email-confirmation`으로 S256 연결 완료 후 지정,
  reviewer password sign-in/refresh, 공개 URL·anon key·reviewer JWT를 쓴 GoTrue
  email/password 직접 변경의 정확한 status/code·비식별 denial counter 증가,
  일반 사용자 변경 성공, 실제 GoTrue reviewer soft/hard delete를 관통 검증해야 한다.
- `npm run db:test:reviewer-upgrade`로 prelaunch 적용 이력에서 reviewer 전진
  migration만 선택되는지, `npm run db:test:reviewer-concurrency`로 reset↔revoke가
  target lock에서 직렬화되는지 확인해야 한다.
- `npm run api:test:reviewer-access`로 실제 GoTrue Admin `createUser` → 관리자 password
  sign-in → HTTP provision/reset/revoke → reviewer password sign-in → 철회된 JWT 401을
  검증하고, 응답에 email/password/token/Storage path/share secret이 없는지 확인해야 한다.
- 정책 조회/동의 → 공유 제출(`pending`) → 관리자 승인 → active 공개/사진 →
  신고 멱등/제한 → 게시중단/소유자 정지 → 소유자 철회의 전체 경로를 pgTAP과
  Route Handler 통합 테스트로 검증해야 한다. raw slug/IP가 DB·로그·이벤트에
  남지 않는지도 별도 확인한다.
- `supabase db lint --local --level warning --fail-on error`를 통과해야 한다.
- 실제 원격 프로젝트 연결·배포는 이 PR 범위에 포함하지 않는다.

## 12. 위치 준수 전진 스키마

reviewer v0.3.7과 fragment v0.3.8의 누적 결정을 보존해 위치 준수 스키마를 통합했다.
상세 불변식과 보유·삭제 경계는 `docs/LOCATION-COMPLIANCE.md`를 따른다.

| 테이블 | 목적 | 최소화 경계 |
|---|---|---|
| `private.minimum_age_attestations` | 18+ 통과 attestation | true, `18plus-v1`, 서버시각만 |
| `private.location_consents` | active·paused·withdrawal_pending | current location acceptance FK |
| `private.location_use_facts` | 위치 판정 최소 원장 | raw 좌표·정확도·거리·IP 없음 |
| `private.location_attempt_tombstones` | 완료 후 stale retry 차단 | owner·attempt-key 32-byte digest와 만료시각만 |
| `private.personal_card_field_object_ledger` | field 승격의 temp·permanent 경로 reconciliation | Storage I/O 전 등록, exact commit 또는 두 단계 삭제 뒤 제거 |
| `private.location_disclosure_accesses` | 이용내역 열람 최소 audit | 사용자·시각·건수만 |
| `private.location_correction_requests` | fact/acquisition 정정 lifecycle, `(user_id, requested_at desc, id desc)` keyset | immutable 요청 fingerprint; 정정내역 100건 절단 금지 |
| `private.data_erasure_jobs` | location 정정·철회와 개별 개인카드 삭제 worker | 전체 계정삭제 시작 시 superset manifest로 원자 이관 |
| `private.data_erasure_manifest` | Storage 두 단계 삭제 | 완료 즉시 object path 제거 |

## 13. 전체 계정삭제·업로드 quota 전진 스키마

| 테이블 | 목적 | 최소화·무결성 경계 |
|---|---|---|
| `private.account_deletion_jobs` | request·lease·phase·30일 receipt | 완료 시 user/prefix null, 비식별 status만 |
| `private.account_deletion_storage_manifest` | temp/permanent 2-pass 삭제 | 완료/finalize 후 path 제거 |
| `private.account_deletion_auth_manifest` | 관련 Auth UID hard delete | Auth phase 완료 즉시 제거 |
| `private.account_deletion_rate_limits` | recovery/status 공개 제한 | purpose HMAC, 48시간 이내 bounded purge |
| `private.account_deletion_admin_actions` | 관리자 retry append-only audit | request/관리자 계정 보유기간과 함께 cascade |
| `private.account_deletion_storage_prefix_tombstones` | 완료 후 late upload 재생성 차단 | 별도 DB key HMAC만 영구, raw UUID/path/time/FK 없음 |
| `private.personal_card_upload_rate_states` | upload URL 10/hour·20/day | 최근 20 timestamp만, app_user cascade |
| `private.personal_card_deletion_requests` | 개별 카드 삭제 UUID 재시도 receipt | job 완료 30일 뒤 cascade purge; final Storage pass 전 exact byte charge |
| `private.rate_limit_windows` | 인증 API 60초 rolling 제한 | 최근 timestamp 최대 60개, app_user cascade, token/IP/body/idempotency key 없음 |

계정삭제 request는 recovery-target→identity rows→owner advisory 순으로 잠그고
identity·participant·reviewer·recovery·share를 즉시 철회한다. worker는 Storage initial/final,
database, auth, finalize를 각 새 lease token으로 처리하며 실패는 접근을 복원하지 않는다.
production scheduler는 전체 계정삭제를 1분마다 호출하고, location·temp maintenance는
5분마다 호출한다. 중복·겹침 호출은 lease와 멱등 상태 전이로 수렴해야 한다.
`photo_size_bytes`는 신규 WebP exact size이고 legacy는 Storage metadata에서 이관한다.
개별 카드 삭제는 공유 철회·generic erasure manifest/tombstone 등록·field/generic ledger
소유권 이관·카드 행 삭제를 하나의 owner-serialized transaction에서 수행한다. 동일
acquisition은 즉시 재사용할 수 있지만 삭제된 객체의 exact byte는 두 번째 Storage pass
완료 전까지 500 MiB 물리 quota에 포함한다. 완료 시 charge를 0으로 만들고 완료 job과
멱등 receipt를 30일 뒤 기존 bounded retention worker가 함께 삭제한다. quota migration은
기존 object/path/size/count가 계약 범위를 벗어나면 fail closed한다.
인증 API 제한은 실행권한이 없는 `private` helper를 원래 도메인 이름의
service-role-only wrapper 안에서 호출한다. wrapper는 active identity와 삭제 상태를
다시 확인하고 논리 사용자 공통 advisory key로 직렬화하며, 제한 소비와 보호
조회·mutation을 같은 트랜잭션에서 수행한다. acquire 설정 재조회·commit·failure,
공유 slug 충돌 재시도, 개인카드 승격 완료 continuation은 첫 호출이 반환한 server-only
예상 사용자 ID와 현재 identity를 후속 트랜잭션 안에서 잠그고 비교한다. 불일치하면
다른 사용자 데이터·제한 상태를 건드리지 않고 종료한다. 개인카드 승격·공유 제출·실물
요청은 `participant_write` 창을, 초대·retro·moderation·위치정정 action은
`admin_mutation` 창을 공유한다. upload-url과 계정삭제 관리자 retry는 각각 기존의 더
구체적인 DB 제한을 권위 경계로 유지하여 generic 창을 이중 소비하지 않는다.
형식이 잘못된 body/query는 wrapper 호출 전에 거부되어 소비하지 않는다. 기존 public
RPC를 내부 구현으로 rename하고 같은 signature의 wrapper로 교체하는 마이그레이션은
구·신 writer가 섞이지 않도록 전체 writer quiescence를 전제로 하며, rename된 내부
함수와 limiter helper에는 `PUBLIC`·Data API role 실행권한을 부여하지 않는다.
배포·canary의 권위 체크리스트는 `docs/ACCOUNT-DELETION-DEPLOYMENT.md`다.

`analytics.events.location_use_fact_id`는 terminal `acquire_success|acquire_fail`과
정확히 상관되며 fact 삭제 시 함께 삭제된다. 클라이언트 `acquire_attempt`과
`personal_card_started`는 exact erasure 상관키가 없어 Stage 0 입력에서 제거한다.

모든 테이블은 RLS+FORCE RLS, direct role privilege 0을 유지한다. 서버 RPC는
`api_private`, `SECURITY DEFINER`, 빈 `search_path`, service-role-only EXECUTE를
적용한다. privacy-rights read/write는 active identity, 새 수집·파생물은 adult active
current location consent 경계를 사용한다.

`20260812042312_location_correction_pagination.sql`은 첫 100건만 반환하던
`api_private.list_own_location_corrections(uuid,integer)` overload를 제거하고
`requested_at + id` anchor를 받는 4-인자 함수로 교체한다. 기존
`location_corrections_user_idx`가 owner filter와 descending keyset 순서를 모두
지원하므로 offset이나 신규 중복 index를 추가하지 않는다. 함수는 active binding을
행 잠금으로 고정하지만 최소연령·participant·current 위치동의를 조회하지 않으며,
`PUBLIC`·browser role의 실행권한은 없고 `service_role`만 호출한다.
