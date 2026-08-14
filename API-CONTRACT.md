# API-CONTRACT v0.4.0 (구현 기준선 — 스토어 제출 준비)

> 변경 규칙: Codex 검토 + TRUST 승인 후 버전 확정.
> 이 문서가 FE·BE의 단일 기준이다. 구현이 계약과 다르면 구현이 버그다.

## 변경 이력

- v0.4.0 (2026-08-12): 계정 삭제를 즉시 접근·공유 철회, 서명 URL 만료 후 Storage 2회 삭제, DB, Auth, 30일 비식별 영수증 순서의 무제한 재시도 state machine으로 구체화했다. 관리자는 활성 service identity와 현재 DB membership을 모두 재검증한 후에만 최대 100건의 비식별 운영 상태를 열람하고, 완료되지 않은 요청을 접근 복구 없이 즉시 재시도할 수 있다. 인증 API의 collection·acquire·events·기타 참여 쓰기·관리자 mutation은 호출자가 limit을 선택할 수 없는 DB 고정 목적의 사용자별 rolling 60초 제한으로 통일하고, 제한 소비와 실제 도메인 처리를 동일 DB 트랜잭션에 묶었다. 개인카드 사진 upload-url에 소유자 귀속 UUID 멱등 키를 추가하고, 개별 카드 삭제는 요청 트랜잭션의 공유 철회·행 삭제, Storage 2회 삭제, 삭제 대기 용량 charge, 30일 재시도 영수증으로 확정했다. 별도 Admin API로 만든 email/password Auth 사용자에 대해 service-role 전용 reviewer provision/reset/revoke lifecycle, 결정적 서울 6개 retro·샘플 개인카드·승인 공유 fixture, append-only 비식별 감사 원장과 Storage 보상 재시도를 추가했다
- v0.3.9 (2026-08-12): 신원 기반 `18plus-v1` 최소연령 attestation과 4번째 current `location_terms`, 위치 수집 동의·일시중지·철회, 최소 위치 이용 원장·열람·정정, field 파생물과 Storage의 durable ledger·2단계 삭제·보유기간·5분 유지보수 경계를 추가했다. 위치 수집·resume·field 파생물은 adult-active와 current 위치동의를 요구하지만 기존 데이터 열람·정정·철회는 active identity만 요구한다. fixed 공개 차단은 publication 404를 먼저 적용한 뒤 bearer JWT의 adult-active DB projection을 검증하며 web age cookie를 요구하지 않고, 공개 web의 resolve·photo·report는 기존 `AGE_ATTESTATION_REQUIRED` cookie 경계를 유지한다
- v0.3.8 (2026-08-12): 공유 secret을 URL path/query에서 제거해 소유자 링크를 `/share#SECRET`으로 고정하고, 공개 해석·WebP 사진·신고·차단을 secret이 strict JSON body에만 있는 fixed POST API로 전환했다. `/share`는 fragment를 메모리로 한 번 읽은 즉시 `/share`로 지우며 6개 browser locale UI를 제공한다. 공개 웹은 DOB를 기기에서만 판정·폐기하고 domain-separated HMAC의 30분 HttpOnly·Secure·SameSite=Strict 연령 attestation cookie를 요구한다
- v0.3.7 (2026-08-12): reviewer 지정·recovery claim·Auth 변경을 공통 lock protocol로 직렬화하고, 정확히 1개의 confirmed email identity·email-only/non-SSO·무 phone·무 pending·무 MFA/passkey와 nonempty password hash를 요구한다. 현재·과거 reviewer의 GoTrue user credential/provider metadata, Auth identity INSERT/DELETE/binding, MFA/passkey 변경과 reviewer logical user 변경을 DB에서 차단하되 일반 사용자 변경, reviewer sign-in/refresh, 실제 soft/hard delete는 유지한다. 설치 전 활성 reviewer 전수검사는 비식별 fail-closed로 수행하며, 철회 계정은 재활성화하지 않고 새 Auth/논리 사용자·fixture version으로만 재발급한다. password hash rewrap은 password 변경과 SQL에서 구분할 수 없으므로 Auth DB encryption key/version 변경 전 철회·staging rehearsal·새 계정 canary를 배포 차단 조건으로 확정한다
- v0.3.6 (2026-08-12): 현재·과거 reviewer 논리 사용자의 복구 발급·claim·이메일 연결을 서버·DB에서 금지하고, 레거시 미사용 코드 철회·이력 tombstone·전체 서비스 바인딩/참여 권한/공유 철회 primitive를 확정. 모바일은 reviewer에게 복구·이메일 UI를 fail-closed로 숨기며, 현장 획득은 여전히 실제 foreground 위치를 요구
- v0.3.5 (2026-08-12): 정책 publication exclusive lock과 upload-url 발급·개인카드 승격·공유 제출·승인 경계의 shared lock을 하나의 순서로 통일했다. 공개 신고 reporter key는 날짜를 제거한 purpose-domain HMAC으로 고정해 UTC 자정에도 1시간 제한을 유지하고, 소유자 정지와 신고 생성은 owner advisory lock 뒤 active·정지 상태를 재검사해 숨김 콘텐츠 신고를 404로 차단한다
- v0.3.4 (2026-08-12): 공유 제출과 공개 발행을 별도 kill switch로 분리했다. `PUBLIC_SHARE_PUBLICATION=false`이면 승인·재게시를 거부하고 기존 active JSON·사진·신고·차단도 404로 숨긴다. UGC 전진 마이그레이션은 배포 전 legacy slug를 모두 무효화해 재제출 시 새 secret을 발급하며, 소유자 정지와 신규 제출을 논리 사용자 advisory lock으로 직렬화한다
- v0.3.3 (2026-08-12): 정책 동의와 current-version 전환을 동일 advisory lock protocol로 직렬화하고 동의 완료 전 현재 문서·acceptance를 재검사한다. 사용자 차단 rate limit을 target과 무관한 blocker 단위로 직렬화하고, 차단 목록을 사용자 귀속 서명 cursor의 keyset pagination으로 변경했다. 공통 `IDEMPOTENCY_CONFLICT` 메시지는 장소 외 API에도 맞는 중립 문구로 정정했다
- v0.3.2 (2026-08-12): secret-link UGC의 범위를 수동 사전 검수로 한정하고 공유 상태를 `private|pending|active|rejected|taken_down`으로 통일. 정책 문서는 locale별 URL·SHA-256을 함께 제공하며, 사진 업로드 전 정책 동의·사용자 차단/해제·소유자 상태 조회·공개 신고·관리자 검수/사진/조치 API와 raw secret·IP 비보관 경계를 확정. 인증 사용자의 서버 차단은 공개 JSON·사진에 함께 적용하고, 무인증 웹의 로컬 숨김은 보조 UX로만 사용한다
- v0.3.1 (2026-08-12): 이메일 연결을 클라이언트 생성 S256 PKCE 경계로 정밀화하고, 서버 고정 callback·flow 상관관계·비밀값 비저장 원칙을 확정. 심사 권한은 활성 서비스 바인딩과 `private.reviewer_accounts`·`private.participant_access`의 현재 DB membership을 함께 재검사하는 `/api/me/access` projection으로 고정
- v0.3 (2026-08-12): Codex 독립 감사 GO·TRUST 지시로 확정. iOS App Store·Google Play 제출 준비 기준선 — 6개 언어 콘텐츠, 컬렉션·소유 사진 조회, 계정 및 전체 데이터 삭제, UGC 약관·사전 검수·신고·차단·운영자 조치, 심사자 fixture, 공개 API rate limit·업로드 quota를 정의
- v0.2.3 (2026-08-12): PR #3 구현 감사 정정 확정 — 복구·이메일 충돌 오류 409 분리, recovery claim 익명/비익명 분기와 활성 바인딩 401 보안 경계 명확화, refresh-session 철회 조건부 베스트 에포트 정의, 개인카드 승격 10분의 기준을 서명 URL 발급 시각으로 정정, 업로드 상태별 오류 `details`와 성공 상태 명시
- v0.2.2 (2026-08-08): Codex 최종 검토 승인·확정 — PR #2 재검토 8건 반영: idempotency 충돌 조건 한정, 이벤트 user_id 경계, acquire_fail props 분리, enum 후속 5종, VALIDATION_FAILED 상태 통일, 업로드 URL 만료·승격 시간 구분
- v0.2.1 (2026-08-08): Codex 검토 지적 5건 반영 — 미확정, 재검토 대기
  - 복구코드 발급 흐름 통일 (자동 발급 표현 제거, FE 별도 호출로 일원화)
  - 복구 claim 의미 정밀화 (JWT 즉시 무효화 아님 — 활성 바인딩 철회 + 매 요청 재검사)
  - idempotency 정의 재작성 (payload 동일성은 spot_id 기준, 원시 좌표 제외)
  - 분석 이벤트 인증 경계 정리 (landing_view·share_view 서버 생성 이관, auth_start 제거, client_event_id 필수)
  - 업로드 EXIF 서버 통제 추가 (임시 저장 → 서버 검증·재인코딩 → 영구 저장)
- v0.2 (2026-08-08): Codex 조건부 승인 P0 8건 반영 + TRUST 결정 3건 반영
  - Stage 0 응답에서 `seq` 제거 (저장만, 비노출)
  - 좌표 정책을 "사용자 기기 원시 좌표"와 "공개 POI 기준좌표"로 구분
  - 복구코드 발급을 획득 흐름에서 분리, claim 정책 확정 (성공 시 기존 바인딩 즉시 철회)
  - 게이트 폐쇄 중 모든 참여 쓰기 API에 내부 테스터 자격 검사 (1회용 초대코드)
  - 획득 함수 실행권한 서버 역할 한정 명문화
  - 인증 전달·idempotency 충돌·오류 형식(`request_id`/`details`) 확정
  - 업로드 MIME·크기·경로·EXIF, 공유 철회·slug 엔트로피 확정
  - 분석 이벤트 props 이벤트별 고정 allowlist + 서버 생성 성과 이벤트 확정
  - 안전 응답 projection 원칙 신설
- v0.1 (2026-08-07): 최초 초안

## 0. 공통

- Base: `/api`, JSON, UTF-8
- 출시 정책: 소비자 앱은 무료·무광고이며 결제·구독·실물 제작·배송 API를 포함하지 않는다. B2C 실물은 출시 후 명시적 수요와 별도 원가·공급 검증이 있을 때만 후속 버전에서 재검토한다
- 인증: Supabase 세션 JWT를 `Authorization: Bearer <jwt>`로 전달 (익명 세션 포함). 쿠키 세션 사용 시에도 서버는 JWT 검증 경로를 단일화한다
- 활성 바인딩: `(인증)`으로 표시된 모든 보호 API는 JWT 검증에 더해 현재 UID의 활성 서비스 바인딩을 매 요청 재검사한다. JWT가 아직 암호학적으로 유효하더라도 바인딩이 없거나 철회됐으면 401 `UNAUTHORIZED`다
- 지원 locale: `ko`, `en`, `ja`, `zh-Hans`, `zh-Hant`, `vi`. 콘텐츠 번역 객체는 아래 6개 키를 항상 모두 가지며 UI 문자열은 앱 언어팩이 관리한다. 사용자 캡션은 작성 원문만 반환하고 자동 번역하지 않는다. 지원하지 않는 시스템 언어의 UI fallback은 `en`이다

```ts
type LocalizedText = {
  ko: string;
  en: string;
  ja: string;
  "zh-Hans": string;
  "zh-Hant": string;
  vi: string;
};
```
- 시간: 서버는 `timestamptz`(UTC) 저장. 일자 단위 규칙인 현장 획득 일일 제한과 `revisit` 중복 제거만 Asia/Seoul 기준으로 서버 계산한다 (`acquired_on_kst`·`revisit_on_kst`)
- 오류 형식:

```json
{ "error": { "code": "OUT_OF_RANGE", "message": "설명", "request_id": "uuid", "details": { } } }
```

- `request_id`: 모든 응답에 포함 (성공 시 헤더 `X-Request-Id`). `details`는 코드별 정의된 경우만
- `error.message`는 운영 진단용이며 표시 언어를 보장하지 않는다. 앱은 `error.code`와 허용된 `details`를 언어팩에서 번역한다
- HTTP 상태 매핑: 400 `VALIDATION_FAILED` · 401 `UNAUTHORIZED` · 403 `GATE_CLOSED`/`FORBIDDEN`/`ACCOUNT_SUSPENDED`/`LOCATION_USE_PAUSED` · 404 `NOT_FOUND` · 409 `ALREADY_ACQUIRED_TODAY`/`IDEMPOTENCY_CONFLICT`/`RECOVERY_CONFLICT`/`EMAIL_ALREADY_IN_USE`/`QUOTA_EXCEEDED`/`MODERATION_CONFLICT`/`LOCATION_WITHDRAWAL_PENDING`/`LOCATION_CORRECTION_PENDING` · 422 `OUT_OF_RANGE`/`LOW_ACCURACY`/`SPOT_NOT_OPEN` · 428 `POLICY_ACCEPTANCE_REQUIRED`/`AGE_ATTESTATION_REQUIRED`/`MINIMUM_AGE_ATTESTATION_REQUIRED`/`LOCATION_CONSENT_REQUIRED` · 429 `RATE_LIMITED` · 500 `INTERNAL`
- 공통 `IDEMPOTENCY_CONFLICT`의 서버 메시지는 장소·신고·차단·삭제 등 어느 mutation에도 맞는 중립 문구를 사용한다. 앱 표시는 항상 code와 endpoint 문맥으로 번역한다

### 좌표 정책 (불변)

- **사용자 기기 원시 좌표(`lat`·`lng`·`accuracy`)**: 판정 후 즉시 폐기. DB·애플리케이션 로그·에러 트래커 어디에도 기록 금지. acquire 핸들러의 예외 리포팅은 좌표 필드를 스크럽 후 전송
- **공개 POI 기준좌표(`spots.latitude`·`longitude`)**: 공개 관광지 정보로, 저장·응답 포함 가능. 이 둘을 혼동하지 않는다

### 안전 응답 projection (불변)

어떤 응답에도 다음을 포함하지 않는다: `field_sequence`(순번), 비정상 이동 플래그, 스팟별 판정 임계값(반경·정확도), Storage 원본 경로, 내부 스키마 식별자. FE는 계약에 명시된 필드만 수신한다고 가정하고, BE는 명시 필드만 select-project한다.

### 비밀값 처리 (불변)

JWT·비밀번호·초대코드·복구코드·삭제 status token·share secret·서명 upload URL은 애플리케이션 로그·분석 이벤트·오류 추적에 남기지 않는다. share secret 원문은 링크 해석에 필요한 `personal_cards.share_slug` 한 곳 외 신고·감사·분석 원장에 복제하지 않는다. 소유자 링크의 secret은 fragment에만 있고 서버 요청 URL에는 포함되지 않으며, 공개 API는 fixed path와 bounded JSON body만 사용한다. 서버·호스팅은 요청 body와 Authorization을 로깅하지 않고 production 후보에서 실제 access log URL이 `/share`와 fixed path만 보유하는지, raw IP가 정책대로 비보관·redaction되는지 검증한다. 저장이 필요한 코드·token은 계약에 명시된 해시만 보관한다.

### 참여 게이트 (불변)

`PUBLIC_RECRUIT_GATE=false`(기본) 동안, 아래 "참여 쓰기 API" 전부는 서버가 내부 테스터 자격(`private.participant_access`)을 검사한다: `POST /api/acquire`, `POST /api/personal-cards*`, `POST /api/physical-requests`, `POST /api/events`. 자격 없으면 403 `GATE_CLOSED`.

## 1. 내부 테스터 등록

`POST /api/participants/redeem` (인증)

```json
{ "invite_code": "string" }
```

→ 204. 1회용 초대코드(운영자 발급, 사용 시 소모)로 현재 서비스 사용자에게 참여 자격 부여.
- 형식 오류는 400 `VALIDATION_FAILED`, 정상 형식이지만 무효·소모된 코드는 404 `NOT_FOUND`, 5회 실패 시 429 `RATE_LIMITED`
- 초대코드 발급은 어드민 전용 (`POST /api/admin/invite-codes`)

## 2. 스팟

`GET /api/spots` (공개)

```json
{ "content_version": "ISO8601",
  "spots": [{ "id", "slug", "name": "LocalizedText",
    "region": { "code": "seoul", "name": "LocalizedText" },
    "status": "open|teaser", "latitude", "longitude",
    "card": { "id", "title": "LocalizedText", "sketch_url", "color_hex" } | null }] }
```

- `teaser` 스팟은 `card: null` (실루엣·비공개). 반경·임계값은 응답에 포함하지 않는다
- `open` 스팟과 공개 카드는 6개 locale 번역이 모두 검수·게시된 행만 반환한다. 번역 누락을 영어로 조용히 대체해 공개하지 않는다
- 정렬은 `region.sort_order`, `spot.sort_order`, `spot.id` 순으로 서버가 고정한다. 내부 `sort_order` 값은 응답하지 않는다
- 응답은 `content_version` 기반 `ETag`를 포함하며 `If-None-Match`가 일치하면 304를 반환한다
- 거리 표시는 FE가 POI 기준좌표와 기기 위치로 클라이언트에서만 계산 (전송 없음)

## 3. 획득

`POST /api/acquire` (인증 + 참여 자격)

```json
{ "spot_id": "uuid", "lat": 0, "lng": 0, "accuracy": 0, "idempotency_key": "uuid(클라이언트 생성; 논리적 시도당 신규, 동일 시도의 전송 재시도 시 재사용)" }
```

→ 201

```json
{ "acquisition": { "id", "spot_id", "card_id", "type": "field", "acquired_at" },
  "card": { "id", "title": {"ko","en","ja","zh-Hans","zh-Hant","vi"}, "image_url", "color_hex" },
  "back": { "date_kst": "YYYY-MM-DD", "weather": "optional" } }
```

- 구현: Route Handler → 서버 역할 전용 원자적 PostgreSQL 함수. **함수 실행권한은 서버 역할로 한정** — 브라우저·`authenticated` 역할 직접 호출 불가
- 판정 순서: 참여 자격 → 스팟 open → 정확도 임계 → 반경 → KST 1일 1회 → insert(순번 배정 포함)
- 응답에 순번(`seq`/`field_sequence`) **미포함** (Stage 0 비노출 결정)
- idempotency 규칙:
  - key 생성: **논리적·물리적 시도당 신규 발급, 동일 시도의 전송 재시도 시에만 재사용**. 위치를 다시 측정하거나 사용자가 재시도 버튼으로 새 판정을 시작하면 새 key를 사용한다
  - payload 동일성 판정 기준은 **`spot_id`만** 사용한다 (원시 좌표는 저장하지 않으므로 판정에 쓰지 않는다)
  - 동일 `(user, key, spot_id)`의 terminal 성공 재요청 → 200 + 최초 성공 응답 재현
  - 동일 `(user, key, spot_id)`의 terminal 실패 재요청 → 최초의 allowlisted failure `code`와 bounded `details`를 결정적으로 재현한다. `LOW_ACCURACY`의 실제 재측정처럼 새 판정은 새 key를 사용한다
  - 동일 `(user, key)`로 기존 pending·성공·실패 기록과 다른 `spot_id`를 요청하면 409 `IDEMPOTENCY_CONFLICT`
  - 성공·실패 terminal 전이는 하나만 승리하고 terminal fact와 정확히 상관된 서버 이벤트를 같은 트랜잭션에 저장한다. DB 기록/전송이 불명확하면 원래 실패로 추측 응답하지 않고 500으로 fail closed한다
- `OUT_OF_RANGE`의 `details`: `{ "distance_band": "near|far" }` — 정확한 거리 미제공
- `LOW_ACCURACY`의 `details`: `{ "retry": true }` — 임계값 수치 미노출

## 4. 내 컬렉션

`GET /api/me/collection?limit=50&cursor=<opaque>` (인증)

```json
{ "items": [{
    "acquisition": { "id", "spot_id", "card_id", "type": "field|retro|gift", "acquired_at", "date_kst" },
    "spot": { "slug", "name": "LocalizedText" },
    "card": { "title": "LocalizedText", "image_url", "color_hex" },
    "personal_card": { "id", "caption", "photo_url": "/api/personal-cards/:id/photo", "created_at",
      "share": { "status": "private|pending|active|rejected|taken_down", "slug": "string|null", "url": "string|null", "reason_code": "string|null" } } | null
  }],
  "page": { "next_cursor": "string|null", "has_more": false },
  "stats": { "total_acquisitions", "spots_visited", "personal_cards" } }
```

- `limit`은 1~100, 기본 50이다. 정렬은 `acquired_at DESC, acquisition.id DESC`이고 커서는 서버가 서명한 불투명 값이다
- cursor의 형식·서명·버전이 잘못됐거나 다른 인증 사용자용이면 400 `VALIDATION_FAILED`다
- `type`은 발도장(field)/기억(retro)/선물(gift) 마크 렌더링에 사용한다
- `stats.spots_visited`는 `field|retro`의 서로 다른 spot 수이고 `gift`는 제외한다. B2B/B2G 방문 성과 집계는 계속 `field`만 사용한다
- 응답에는 현재 사용자의 행만 포함하며 `field_sequence`, 비정상 이동 플래그, Storage 경로는 포함하지 않는다
- 조회 함수는 현재 활성 identity를 `FOR SHARE`로 잠가 복구 claim·계정 삭제와 직렬화한다
- `GET /api/personal-cards/:id/photo` (인증)는 소유권을 다시 확인한 뒤 private WebP를 프록시하며 `Cache-Control: private, no-store`를 사용한다. 미존재와 비소유는 모두 404다

## 5. 개인화 카드

`POST /api/personal-cards/upload-url` (인증 + 참여 자격)

```json
{
  "content_type": "image/jpeg|image/png|image/webp",
  "size": 1234,
  "client_request_id": "uuid"
}
```

→ 200 `{ "upload_url", "temp_path" }`

- 현재 이용약관·커뮤니티 지침 acceptance가 모두 필요하다. 미동의·구버전·선택 locale의 현재 SHA-256과 불일치하면 428 `POLICY_ACCEPTANCE_REQUIRED`, `details.required`를 반환하며 임시 경로를 발급하지 않는다
- 업로드 대상은 **임시 영역**(temp) 경로. 서버가 `<app_user_id>/<uuid>.<ext>` 경로 생성 — 클라이언트 경로 입력 불신
- 제한: 최대 10 MiB, 허용 MIME 3종
- `client_request_id`는 strict UUID이며 논리 사용자에 귀속된다. 같은 소유자·키·MIME·size를 첫 발급의 10분 승격 창 안에서 재전송하면 같은 `temp_path`·reservation을 반환하고 Storage 서명 토큰만 다시 발급한다. 이 재시도는 활성 temp slot이나 10회/시간·20회/24시간 발급 quota를 추가 소비하지 않는다. 같은 키의 MIME 또는 size가 다르거나 원 reservation이 만료·승격·처리·정리 상태면 409 `IDEMPOTENCY_CONFLICT`다
- 시간 규칙 구분: **서명 업로드 URL 만료 = 마지막 토큰 발급 시각(`signed_url_last_issued_at`)부터 2시간**(Supabase 고정값) / **서버 승격 허용시간 = 최초 발급 시각(`issued_at`)부터 10분**. 멱등 토큰 재발급은 첫 10분 안에서만 허용되고 `promotion_expires_at`을 연장하지 않는다. 업로드 완료 시각도 10분을 다시 시작하지 않는다. `POST /api/personal-cards`의 서버 승격 시작 판정이 최초 `issued_at + 10분` 이상이면 만료이며, 초과된 임시 파일은 정리(삭제) 대상이다
- FE 의무(UX·트래픽 최적화): 업로드 전 클라이언트에서 EXIF 제거 + 최대 2048px 리사이즈. 단, 이는 최적화 의무이며 **보안 경계가 아니다**

`POST /api/personal-cards` (인증 + 참여 자격)

```json
{ "acquisition_id": "uuid", "temp_path": "string", "caption": "최대 60자" }
```

→ 201 `{ "personal_card": { "id", "share_slug": null } }`

- 승격 시작에서도 현재 이용약관·커뮤니티 지침 acceptance를 다시 검사한다. 428 응답 뒤에는 임시 파일을 읽거나 영구 파생본을 만들지 않는다. 이 정책 게이트는 사용자 사진 UGC 업로드/승격에만 적용하며 사진 없는 private 카드·획득 데이터에는 적용하지 않는다
- **보안 경계는 서버다.** 서버 처리 순서:
  1. 활성 서비스 바인딩·참여 자격을 재검사
  2. `acquisition_id` 소유권, `temp_path` 소유 폴더 일치 검사
  3. 임시 파일의 실제 MIME(매직 바이트)·크기·디코딩 가능 여부 검증
  4. **재인코딩으로 메타데이터가 제거된 파생본**을 생성해 영구 private 저장소에 보관
  5. 처리 완료 후 임시 원본 삭제
- 검증 실패 시 400 `VALIDATION_FAILED` + 임시 파일 삭제 (0장 상태 매핑과 통일)
- 승격 상태별 오류 계약:
  - 승격 허용시간 만료 → 400 `VALIDATION_FAILED`, `details: { "reason": "upload_expired" }`
  - 동일 업로드가 처리 중이거나 처리 lease가 아직 유효 → 400 `VALIDATION_FAILED`, `details: { "reason": "upload_processing" }`
  - 획득·업로드 레코드 또는 임시 객체가 없거나, 이미 정리됐거나, 현재 사용자가 소유하지 않음 → 404 `NOT_FOUND` (`details` 미포함; 존재 여부를 더 세분화하지 않음)

`POST /api/personal-cards/:id/share` (인증 + 참여 자격 + `PUBLIC_SHARE_CREATION`)

→ 최초 요청 202

```json
{ "share": { "slug": "base62 22자 이상", "url": "https://.../share#SECRET", "status": "pending" } }
```

- slug는 128bit 이상 엔트로피를 가진 추측 불가 secret이다
- 무료 초기 운영에서는 사용자 사진과 캡션을 **공개 전에 수동 검수**한다. 승인 뒤에만 `status=active`가 된다
- 동일 카드의 재요청은 현재 공유 상태를 멱등 반환한다. `rejected|taken_down`에서 운영자가 `reinstate`하지 않은 공유를 사용자가 임의 재활성화할 수 없다
- 공유 제출 시점의 현재 이용약관·커뮤니티 지침 acceptance ID를 공유 행에 고정한다. 정책 current-version 변경 등으로 snapshot이 stale해진 `pending`은 소유자가 최신 정책에 동의한 뒤 이 엔드포인트를 다시 호출해야 검수 가능 상태가 된다
- 최신 이용약관·커뮤니티 지침 미동의 시 428, 공유 정지 사용자면 403 `ACCOUNT_SUSPENDED`다
- `PUBLIC_SHARE_CREATION=false`이면 새 secret 생성과 policy snapshot 갱신이 필요한 legacy·stale `pending` 재제출은 403 `GATE_CLOSED`, `details: { "gate": "share_creation" }`다. 현재 상태를 바꾸지 않는 기존 공유 조회·멱등 반환과 소유자 철회는 계속 허용한다
- UGC 전진 마이그레이션은 그 이전에 존재한 모든 raw slug를 즉시 `null`로 지우고 공유를 `private` + `share_resubmission_required=true` + `LEGACY_SLUG_ROTATION_REQUIRED`로 바꾼다. 이후 제출 게이트가 열린 상태에서 최신 정책 동의와 새 secret으로 다시 제출해야 하며 기존 secret은 복구·재사용하지 않는다

`GET /api/personal-cards/:id/share` (인증)

```json
{ "share": { "status": "private|pending|active|rejected|taken_down", "slug": "string|null", "url": "string|null", "reason_code": "string|null", "submitted_at": "ISO8601|null", "reviewed_at": "ISO8601|null" } }
```

현재 소유자만 공유 제출·검수 상태를 조회한다. 미존재와 비소유는 모두 404다. owner projection에서만 secret slug와 URL을 반환하며 로그·분석 이벤트에는 남기지 않는다.

`DELETE /api/personal-cards/:id/share` (인증) → 204 — 참여 게이트·검수 상태와 무관하게 소유자가 철회할 수 있고 slug는 즉시 무효가 된다

`GET /share#<share_secret>`은 고정 공개 웹 shell이다. URL fragment는 HTTP 요청에 전송되지 않는다. shell은 mount 전 layout effect에서 fragment를 메모리로 한 번 읽고 즉시 `history.replaceState(..., "/share")`로 지운다. secret을 DOM·local/session storage·분석·오류 문구에 넣지 않으며 사진 Blob URL은 교체·unmount 때 revoke한다. 과거 `/share/:secret`과 `/api/share/:secret/**`는 redirect 없이 404다. 공개 UI는 `Accept-Language` 기준 `ko|en|ja|zh-Hans|zh-Hant|vi`, 미지원 언어는 `en`이고 사용자 caption은 원문 그대로다. shell과 fixed API는 `no-store`·`no-referrer`·`noindex,nofollow`·nosniff, 엄격한 nonce CSP와 외부 기능을 닫는 Permissions Policy를 사용한다. shell의 resolve·photo·report 요청은 각각 응답 body 소비까지 15초에 제한하고 unmount에서 즉시 abort한다. 202 신고 응답은 deadline 안에 exact `{ report: { id, status: "received" } }` JSON으로 검증하고, 사용하지 않는 428·기타 error·부적합 사진 body는 같은 deadline 안에 cancel한다.

`POST /api/public-share/age-attestation` (공개)

```json
{ "pass": true, "version": "dob-18-v1" }
```

DOB는 브라우저에서만 Asia/Seoul 달력 기준으로 만 18세 여부를 판정한 뒤 입력과 임시 변수에서 즉시 폐기하며 서버 body·DOM 결과·storage에 남기지 않는다. 유효한 DOB가 만 18세 미만으로 판정되면 현재 secret을 폐기하고 재입력 폼이 없는 unavailable 상태로 잠긴다. 날짜 형식·실존성이 잘못된 입력만 같은 화면에서 정정할 수 있다. 서버는 `pass`와 고정 version만 받고 204와 30분 attestation cookie를 발급한다. cookie는 `ABUSE_HMAC_SECRET`에서 별도 고정 domain으로 파생한 키로 서명하며 `__Host-` prefix, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict`를 사용한다. 변조·만료·구버전·미존재 cookie는 동일한 428 `AGE_ATTESTATION_REQUIRED`, `details: { "version": "dob-18-v1", "minimum_age": 18 }`로 처리한다. 이는 클라이언트 자기진술 gate이지 신원 기반 연령 인증을 의미하지 않는다.

아래 fixed 공개 API는 모두 strict·bounded `application/json` body를 사용하고 secret을 응답에 echo하지 않는다. 발행 flag가 false이면 cookie·JWT·body보다 먼저 404이고 DB에도 boolean false 경계를 전달한다. 공개 web의 resolve·photo·report 순서는 `PUBLIC_SHARE_PUBLICATION` 검사 → age cookie 검사 → 선택 JWT 검사 → body 파싱 → DB RPC다. 인증 차단은 별도 순서인 publication 검사 → 필수 bearer의 adult-active DB projection → body 파싱 → DB RPC를 사용하며 web age cookie를 요구하지 않는다.

- `POST /api/public-share/resolve` (JWT 선택) `{ "share_secret": "base62 22자 이상" }` → 200 `{ "date_kst", "spot": { "name": "LocalizedText" }, "caption", "photo_available": true }`. `photo_url`·secret·정확 시각·위치·순번·Storage 경로는 없다.
- `POST /api/public-share/photo` (JWT 선택) `{ "share_secret": "..." }` → 200 `image/webp` body. JSON 해석과 동일한 active·소유자 정지·viewer 차단 판정을 요청마다 다시 수행한 뒤 private Storage를 프록시한다.

두 API 모두 JWT가 없으면 공개 요청으로 처리하고, Authorization을 보냈으나 검증에 실패하면 401이다. `PUBLIC_SHARE_PUBLICATION=true`이고 `active`인 공유만 반환하며 다른 상태·정지 소유자·인증 viewer가 차단한 소유자는 404다. 응답은 `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer`, noindex/nofollow, nosniff를 사용한다.

### UGC 정책·신고·안전 조치

`GET /api/policies/current` (공개)

```json
{ "support_url": "https://...|null (local development only)", "policies": [{
  "type": "terms_of_use|privacy_policy|community_guidelines|location_terms",
  "version": "문서 버전",
  "effective_at": "ISO8601",
  "documents": {
    "ko": { "url": "https://...", "sha256": "64자 lowercase hex" },
    "en": { "url": "https://...", "sha256": "64자 lowercase hex" },
    "ja": { "url": "https://...", "sha256": "64자 lowercase hex" },
    "zh-Hans": { "url": "https://...", "sha256": "64자 lowercase hex" },
    "zh-Hant": { "url": "https://...", "sha256": "64자 lowercase hex" },
    "vi": { "url": "https://...", "sha256": "64자 lowercase hex" }
  }
}] }
```

현재 시행 중인 네 정책(`terms_of_use`·`privacy_policy`·`community_guidelines`·`location_terms`)이 모두 6개 locale의 HTTPS URL과 실제 문서 바이트의 SHA-256을 갖지 않으면 500 `INTERNAL`로 fail closed한다. `support_url`은 로그인·연령 상태와 무관한 공개 고객지원 페이지다. 로컬 개발에서 미설정이면 `null`이지만 preview·production 서버는 `PUBLIC_SUPPORT_URL`이 없으면 환경 검증 단계에서 시작하지 않는다. production URL의 실제 값은 외부 배포 설정이다. 발행된 정책의 type·version·시행/발행시각과 locale별 URL·SHA-256은 수정·삭제할 수 없고 새 버전을 발행해야 한다. current set 전환은 service-role 전용 publication RPC만 허용하며, 이 RPC는 정책 전환 exclusive advisory lock을 정책 행보다 먼저 획득한다. 직접 `is_current` 변경은 DB trigger가 거부한다. placeholder URL·hash는 production 준비 완료로 간주하지 않는다. 앱은 build-time exact HTTPS origin allowlist, 무리디렉션 최종 URL, credential 미전송, 10초 단일 deadline과 2MiB streaming 상한, 실제 byte SHA-256를 모두 확인한다. 정책 문서는 외부 URL을 재요청하지 않고 검증한 동일 byte를 앱 내 뷰어에 표시한다. 응답 가능한 지원 이메일·계정 삭제 URL과 실제 policy/support URL은 후보 빌드 전 외부 블로커다.

`POST /api/me/policy-acceptances` (인증)

```json
{ "acceptances": [
  { "type": "terms_of_use", "version": "문서 버전", "locale": "ko|en|ja|zh-Hans|zh-Hant|vi" },
  { "type": "community_guidelines", "version": "문서 버전", "locale": "ko|en|ja|zh-Hans|zh-Hant|vi" }
] }
```

이 UGC 동의 RPC의 입력은 `terms_of_use`·`community_guidelines` 2종으로 고정한다.
`privacy_policy`는 고지 대상이고, `location_terms` 동의는 위치 동의 API가 별도로
현재 locale/hash snapshot을 기록한다.

→ 204. 배열은 두 필수 type을 정확히 한 번씩 포함해야 한다. 사용자 사진 업로드 URL 발급·개인카드 승격·공유 생성 전에 현재 이용약관·커뮤니티 지침 동의가 필수다. 서버는 publication과 같은 키의 shared advisory lock을 먼저 얻고 현재 두 문서 행을 고정한 뒤, 그 ID와 요청 locale의 SHA-256으로만 snapshot을 기록한다. 반환 직전 current 문서 ID와 두 acceptance를 재검사하며 전환 또는 불완전 삽입이 감지되면 새 current 기준 `required`를 다시 계산해 428 `POLICY_ACCEPTANCE_REQUIRED`를 반환한다. upload-url 발급·개인카드 승격·공유 제출·관리자 승인 RPC도 current acceptance를 읽기 전에 같은 shared lock을 획득하고 결과 저장 또는 active 전환이 끝날 때까지 유지한다. 미동의·구버전·hash 불일치도 같은 428과 `details: { "required": [{ "type", "version" }] }`를 사용한다. 개인정보처리방침은 고지 대상이며 이 동의 요청에 포함하지 않는다.

`POST /api/public-share/report` (공개 + 유효한 age cookie, JSON body 최대 4,096 bytes)

```json
{ "share_secret": "base62 22자 이상", "client_report_id": "uuid", "target": "content|user", "reason": "sexual_content|violence|hate_or_harassment|privacy|copyright|spam|illegal|other", "comment": "선택, 최대 300자" }
```

→ 202 `{ "report": { "id": "uuid", "status": "received" } }`. 서버는 `PUBLIC_SHARE_PUBLICATION=true`인 동안 `active`이고 소유자가 정지되지 않은 secret slug에서 콘텐츠와 작성자를 내부 해석하고 작성자 ID를 공개하지 않는다. 발행 flag 폐쇄·미존재·비활성·소유자 정지 secret은 모두 404이며 기존 `client_report_id` 재전송도 현재 콘텐츠가 숨겨졌으면 404다. 신고 생성은 소유자 정지와 같은 owner advisory lock을 먼저 획득한 뒤 카드와 활성 정지를 재검사하므로 정지와 경합해 숨김 콘텐츠 신고가 남지 않는다. 동일 `client_report_id`와 동일 payload는 공개 상태가 유지되는 동안 멱등 처리하고 같은 ID의 다른 payload는 409 `IDEMPOTENCY_CONFLICT`다. 응답으로 소유자·신고 누적 수·운영 상태를 노출하지 않는다. 신고 원장·로그·분석에는 raw slug와 raw IP를 저장하지 않고, 남용 제한에는 서버 비밀키 HMAC으로 만든 단기 reporter key hash만 사용한다. 공개 신고는 기본 1시간 5회이며 초과 시 429 `RATE_LIMITED`, `details: { "retry_after_seconds": n }`, `Retry-After: n`을 반환한다.

`POST /api/public-share/block` (인증 adult bearer, web age cookie 불필요) `{ "share_secret": "base62 22자 이상", "client_action_id": "uuid" }` → 204. `PUBLIC_SHARE_PUBLICATION=true`인 동안 `active` secret에서 소유자를 내부 해석해 현재 논리 사용자와의 차단 관계를 만든다. 발행 flag 폐쇄는 인증·payload와 무관하게 먼저 404다. bearer JWT는 active identity와 DB의 `18plus-v1` projection을 통과해야 하며 미기록은 428 `MINIMUM_AGE_ATTESTATION_REQUIRED`다. 같은 ID·secret 재전송은 멱등, 같은 ID의 다른 secret은 409다. 자기 자신·비활성 secret은 각각 400·404이며, 신규 차단은 사용자당 1시간 20회로 제한한다. rate window 판정과 기록은 target 소유자가 달라도 blocker 논리 사용자 단위 advisory lock으로 직렬화한다. 신고와 차단은 독립 동작으로 어느 한쪽이 다른 쪽을 자동 생성하지 않는다.

`GET /api/me/blocks?limit=50&cursor=<opaque>` (인증) → 200 `{ "blocks": [{ "id": "opaque uuid", "created_at": "ISO8601" }], "page": { "next_cursor": "string|null", "has_more": false } }`. `limit`은 1~100, 기본 50이며 `created_at DESC, id DESC` keyset pagination을 사용한다. cursor는 서버 서명·버전 검증을 거치고 현재 인증 UID에 귀속되므로 변조·다른 사용자 cursor는 400 `VALIDATION_FAILED`다. 소유자 논리 UUID·share slug·프로필 정보는 반환하지 않는다.

`DELETE /api/me/blocks/:id` (인증) `{ "client_action_id": "uuid" }` → 204. 현재 사용자가 소유한 opaque 차단 ID만 해제하며 같은 mutation 재전송은 멱등이다.

`DELETE /api/personal-cards/:id` (active identity 인증, 참여·연령 gate와 무관)

```json
{ "client_request_id": "uuid" }
```

→ 202 exact `{ "status": "accepted" }`

- 소유자·카드 잠금 아래 공유를 즉시 비공개로 철회하고, 영구 사진 경로를 공통 삭제 manifest와 tombstone으로 이관한 뒤 같은 요청 트랜잭션에서 `personal_cards` 행을 삭제한다. 따라서 commit 직후 공개 secret과 소유 사진 조회는 무효이며 같은 획득 건으로 새 개인카드를 만들 수 있다
- 같은 논리 사용자·`client_request_id`·카드 ID 재전송은 행이 이미 삭제된 뒤에도 30일 동안 같은 202를 반환한다. 같은 키를 다른 카드 ID에 재사용하면 409 `IDEMPOTENCY_CONFLICT`다. 미존재와 비소유 카드는 모두 404 `NOT_FOUND`로 존재 여부를 구분하지 않는다
- 삭제 worker는 영구 사진을 최소 10분 간격으로 두 번 삭제한 뒤에만 완료한다. 삭제된 행의 exact `photo_size_bytes`는 두 번째 Storage 삭제가 끝날 때까지 사용자 500 MiB 물리 quota에 계속 포함하고, 완료 시 0으로 해제한다. 완료 job과 owner-scoped 멱등 영수증은 30일 뒤 bounded purge한다. 전체 계정삭제가 먼저 시작되면 같은 owner lock 아래 해당 manifest를 계정삭제 superset으로 이관하고 개별 job·영수증을 제거한다

- 공개 공유는 검색·피드·사용자 프로필·팔로우·댓글·DM이 없는 추측 불가 secret-link 방식만 허용한다
- 모바일의 인증 익명 사용자도 서버 차단을 사용하며, 차단된 소유자의 active JSON·사진은 해당 viewer에게 404다. 무인증 공개 웹은 계정 식별자가 없으므로 로컬 숨김을 보조 UX로 제공하되 서버 차단을 대체하지 않는다
- 운영자 `reject|take_down|suspend_owner` 조치 즉시 해당 공유 또는 소유자의 모든 공개 공유 JSON·사진 프록시는 404가 되고, `suspend_owner`는 신규 공유 제출도 차단한다. 소유자 정지 해제는 기존 콘텐츠를 자동 공개하지 않는다
- 신규 공유 제출과 공유·신고 기반 `suspend_owner`, 카드 독립 `unsuspend_owner`는 같은 논리 사용자 transaction advisory lock을 사용하고 잠금 뒤 정지 상태를 재검사한다. 정지 요청이 먼저 대기한 경합에서는 뒤의 공유 제출이 403 `ACCOUNT_SUSPENDED`로 끝나며 새 pending secret을 남기지 않는다
- 검색·피드·공개 프로필·팔로우·댓글·DM·추천 등 작성자를 재발견하거나 접촉하는 기능은 현재 범위 밖이며, 추가 시 기존 서버 차단을 모든 발견/상호작용 API에 강제해야 한다
- `PUBLIC_SHARE_CREATION`은 `pending` 제출·재제출 전용이고 `PUBLIC_SHARE_PUBLICATION`은 승인·재게시와 active JSON·사진·신고·차단 전용이다. 둘 다 기본 false이며 하나를 열어도 다른 하나는 자동으로 열리지 않는다. 발행 flag가 닫히면 DB의 기존 active 상태를 변경하지 않고도 공개 surface 전체를 404로 차단한다
- 검수·신고 대기 12시간에 경고하고 24시간을 넘기면 운영 임계 경보를 발생시킨다
- 앱은 신고·로컬 숨김·공유 철회·운영 문의 경로를 공유 화면과 설정 화면에서 제공한다. 이 모바일 UI와 실제 지원 채널 운영은 본 백엔드 슬라이스 밖의 출시 블로커다

## 6. 계정·복구

`POST /api/recovery/issue` (인증)
- 조건: 획득 1건 이상 보유. **자동 발급은 없다** — 획득 API와 완전히 분리된 별도 호출이며, FE가 첫 획득 완료 화면에서 발급 버튼으로 유도한다
- → 201 `{ "code" }` — 이 응답에서 1회만 평문 노출. 서버는 SHA-256 저장. 재발급 시 기존 코드 무효화
- `private.reviewer_accounts`에 한 번이라도 기록된 논리 사용자는 현재 철회 여부와 관계없이 403 `FORBIDDEN`이다. 이력 tombstone은 membership 행을 삭제해도 남으며, 평문·digest를 새로 발급하지 않는다

`POST /api/recovery/claim` (인증)

```json
{ "code": "string" }
```

→ 200 `{ "restored": true }`
- 성공 조건: 현재 세션이 **빈**(획득 0건) 익명 서비스 사용자이고, 제출한 코드가 유효·미사용 상태일 때만. 성공 응답 시 현재 인증 UID가 복구 대상 서비스 사용자에 활성 바인딩된 상태다
- 유효 코드의 대상이 이미 현재 활성 서비스 사용자와 같으면 코드는 소모하되 identity·참여 자격·이벤트·실물 수요·privacy state를 self-merge/delete하지 않는 안전한 성공 no-op으로 처리한다
- 사전조건 실패 분기:
  - 익명 사용자지만 획득이 1건 이상이면 409 `RECOVERY_CONFLICT`, `details: { "reason": "not_empty" }`
  - 비익명 사용자면 보유 획득 수와 무관하게 403 `FORBIDDEN`
  - 코드 형식 오류는 400 `VALIDATION_FAILED`; 정상 형식이지만 없거나 무효·만료·철회·이미 사용됐으면 404 `NOT_FOUND` (`details` 미포함)
  - 현재 UID의 서비스 바인딩이 없거나 이미 철회됐으면 401 `UNAUTHORIZED`
- 성공 시 의미 (TRUST 결정의 정밀 정의):
  1. claim **트랜잭션 안에서** 현재 인증 UID를 대상 서비스 사용자에 바인딩하고, **기존 활성 서비스 바인딩을 즉시 철회**한다. 코드는 소모 처리. 전 과정 서버 전용 함수의 단일 트랜잭션
  2. 기존 기기의 access JWT는 만료 전까지 유효할 수 있다 — 이것은 "로그아웃"이 아니다
  3. 대신 **모든 보호 API는 매 요청마다 활성 바인딩을 재검사**하며, 철회된 UID의 앱 접근은 즉시 401로 차단된다. 이것이 claim 이후의 필수 보안 경계다
  4. FE는 401 수신 시 로컬 세션을 제거한다
  5. Supabase refresh-session 철회는 DB 트랜잭션 **밖의 후속 조치**다. 서버가 기존 세션을 철회할 수 있는 Supabase 지원 핸들을 실제로 보유한 경우에만 조건부 베스트 에포트로 시도한다. UID만으로 임의 철회를 가정하지 않으며, 미지원·실패는 claim을 롤백하지 않는다. 이 후속 조치의 성공 여부와 무관하게 3항의 활성 바인딩 401 검사는 유지한다
- reviewer 이력 사용자의 미사용 코드는 마이그레이션·reviewer 지정 트리거로 철회하고, DB는 새 활성 코드 생성·재활성화를 거부한다. reviewer 이력이 있는 논리 사용자의 Auth identity가 일반 사용자 코드를 claim하는 역방향도 전체 트랜잭션을 롤백한다. 두 경우 모두 reviewer 여부를 노출하지 않고 일반 무효 코드와 동일한 404 `NOT_FOUND`로 끝난다
- 실패 5회 → 세션 기준 잠금 (429, `details: { "locked_minutes": n }`)

`POST /api/auth/link-email` (인증, **익명 사용자 전용**)

```json
{
  "email": "person@example.com",
  "flow_id": "UUID v4",
  "code_challenge": "43자 base64url SHA-256 challenge",
  "code_challenge_method": "s256"
}
```

→ 204 — Supabase 이메일 연결 확인 요청이 접수된 상태다. 이메일 소유 확인과 콜백/세션 갱신이 완료되기 전까지 계정 연결 성공을 뜻하지 않으며 사용자는 익명 상태로 취급한다.
- 비익명 사용자의 요청 → 403 `FORBIDDEN`
- 현재 또는 과거 reviewer 논리 사용자의 요청 → 403 `FORBIDDEN`. 서버는 Auth 변경 전에 활성 바인딩과 reviewer 이력을 DB에서 재검사한다
- 공개 Supabase URL·anon key·reviewer JWT로 GoTrue `PUT /auth/v1/user`를 직접 호출해도 우회할 수 없다. DB는 reviewer 지정 이력에 연결된 현재·과거 Auth 사용자의 email·password·phone·email/phone/recovery/reauth change state·anonymous/SSO 상태와 `raw_app_meta_data` provider 정보를 거부하고, `auth.identities`의 INSERT/DELETE/binding 변경도 거부한다. sign-in/refresh의 `last_sign_in_at`·`updated_at` 등 volatile 변경과 GoTrue 전체 계정 soft/hard delete의 redaction·cascade는 허용한다
- 해당 이메일이 이미 다른 Auth 사용자에 연결됨 → 409 `EMAIL_ALREADY_IN_USE`
- payload는 위 4개 필드만 허용한다. `code_challenge_method`는 소문자 `s256` 고정이며 `plain`, padding이 붙은 challenge, `code_verifier`, 임의 redirect URL은 400 `VALIDATION_FAILED`다
- 앱은 논리적 연결 시도마다 128-bit UUID v4 `flow_id`와 PKCE verifier를 생성하고 verifier를 해당 flow에 연결해 SecureStore에 보관한다. 같은 HTTP 전송 재시도에서만 같은 flow/challenge를 재사용한다
- 서버는 환경변수로 고정된 `AUTH_EMAIL_REDIRECT_TO`에 `sb_flow_id=<flow_id>`만 추가한다. 클라이언트가 redirect를 지정할 수 없으며 서버는 GoTrue `/auth/v1/user`에 email·challenge·`s256`만 전달하고 verifier는 받지도 전달하지도 않는다
- callback의 `code`는 같은 `sb_flow_id`에 보관된 verifier로만 교환한다. 성공·실패 후 해당 verifier를 제거하며 다른 flow의 verifier로 대체 교환하지 않는다
- access token·email·challenge·verifier는 다녀담 DB·애플리케이션 로그·오류 추적에 저장하지 않는다. 이메일의 pending/confirmed 상태는 연결 제공자인 Supabase Auth의 보안 경계 안에서만 처리한다

### 계정 및 전체 데이터 삭제

`POST /api/me/deletion-requests` (인증)

```json
{ "client_request_id": "uuid", "status_token": "클라이언트 생성 32-byte-base64url", "confirmation": "DELETE_MY_ACCOUNT" }
```

→ 202

```json
{ "deletion_request": { "id": "uuid", "status": "pending", "requested_at": "ISO8601", "complete_by": "ISO8601" } }
```

앱은 요청 전에 status token을 생성해 SecureStore에 보관한다. 서버는 SHA-256만 저장한다. 같은 `client_request_id`와 같은 token의 재요청은 같은 활성 삭제 요청을 멱등 반환하므로 최초 응답이 유실돼도 상태를 조회할 수 있다. 같은 ID에 다른 token이면 409 `IDEMPOTENCY_CONFLICT`다.

- 요청 트랜잭션에서 모든 활성 서비스 바인딩·참여 자격·복구코드를 철회하고 모든 공유 slug를 무효화한다. 이후 기존 JWT의 보호 API 접근은 즉시 401이다
- 백그라운드 삭제 작업은 임시 원본·영구 사진을 Storage API로 삭제한 뒤 Supabase Auth identity와 논리 사용자 행을 삭제한다. 획득·개인카드·캡션·정책 동의·신고·공유 정지·이벤트 등 FK 종속 데이터도 함께 삭제한다
- 아직 유효할 수 있는 서명 업로드 URL의 재업로드를 막기 위해 즉시 삭제 후 해당 사용자의 모든 `signed_url_expires_at` 중 최댓값 + 10분 뒤 최종 재삭제를 수행하며, 그 전에는 완료로 표시하지 않는다. `signed_url_expires_at`은 각 reservation의 마지막 토큰 발급 시각 + 2시간이며, 토큰 재발급은 최초 10분 승격 창을 연장하지 않는다
- 정상 상태에서 24시간 안에 완료한다. `complete_by`는 `requested_at + 24시간`이다. 실패는 재시도·운영 경보 대상으로 두며 사용자 접근을 다시 활성화하지 않는다
- 계정삭제 maintenance는 선택한 단일 production scheduler가 1분마다 호출한다. 저장소의 Vercel Cron 표현식은 Pro/Enterprise의 1분 최소 간격을 전제로 하며, 그 플랜과 실제 production 등록을 증명할 수 없으면 동일 주기의 Supabase Cron/pg_net 또는 외부 scheduler로 대체한다. lease와 멱등 경계는 중복·겹침 호출에도 안전해야 하고, 최악 허용 cardinality의 동시 삭제 부하가 24시간 SLA 안에 완료되는지를 스테이징에서 검증하기 전 출시하지 않는다
- 완료 후에는 사용자 ID·이메일·사진 경로를 보존하지 않는다. 삭제 작업의 비식별 운영 결과만 제한 기간 보관할 수 있으며 개인정보처리방침에 기간과 목적을 명시한다. 단, 삭제 전에 인증된 지연 업로드가 완료 후 객체를 재생성하지 못하도록 사용자·request·경로·시각과 연결되지 않고 별도 DB 비밀키 없이는 역산할 수 없는 32-byte Storage-prefix HMAC만 anti-recreation 보안 표식으로 유지한다. 이 영구 최소 보관은 개인정보처리방침과 법무 검토에서 목적·접근권한·삭제 예외 근거를 확정해야 한다
- 공개 웹 `/account/delete`는 앱 설치를 요구하지 않고 `다녀담 / DANYEODAM`과 Store Console의 실제 개발자 표시명을 명시한다. 일반 사용자는 연결된 이메일의 Supabase 인증 링크(`signInWithOtp`, `shouldCreateUser=false`)로 같은 삭제 요청을 시작할 수 있다. 현재·과거 reviewer는 credential 잠금 때문에 인증 링크를 사용할 수 없으므로, 명시적으로 분리된 심사 계정 이메일·비밀번호 경로가 기존 계정에 `signInWithPassword` 세션을 만든 뒤 동일한 인증 삭제 API를 사용한다. 이 경로는 계정이나 매직링크를 만들지 않으며, 로그인 실패 원인을 구분하지 않는 동일 문구만 표시한다. 삭제 데이터 범위와 최대 처리기간, 지원 연락처를 함께 제공한다
- 복구코드를 보유한 익명 사용자는 공개 웹에서 `POST /api/account/deletion-requests/recovery`에 `recovery_code`, `client_request_id`, `status_token`, `confirmation`을 보내 복구 없이 삭제를 요청할 수 있다. 코드는 성공 시 즉시 소모하며 recovery 실패 제한과 공개 IP 제한을 함께 적용한다

`GET /api/account/deletion-requests/:id` (공개, 상태 토큰 필요)

```http
X-Deletion-Status-Token: <status_token>
```

```json
{ "id": "uuid", "status": "pending|completed|action_required", "reason_code": "retrying|manual_support_required|null", "requested_at": "ISO8601", "complete_by": "ISO8601", "completed_at": "ISO8601|null", "support_url": "HTTPS URL" }
```

- 서버는 상태 토큰의 SHA-256만 저장하고 비교는 상수시간으로 수행한다
- 삭제 순서: 접근·공유 즉시 차단 → Storage 즉시 삭제 → `max(signed_url_expires_at) + 10분` 후 최종 재삭제 → DB 종속 데이터 삭제 → 관련 Auth UID 삭제 → 식별 가능한 작업 manifest 삭제
- 사용자 연결이 제거된 완료 영수증은 request ID·상태 token hash·요청/완료 시각·결과 코드만 30일 보관해 상태 조회를 제공한 뒤 삭제한다

#### 관리자 삭제 운영

`GET /api/admin/account-deletions?status=active&limit=50` (관리자)

```json
{
  "items": [{
    "id": "opaque deletion request uuid",
    "status": "pending|processing|completed",
    "phase": "storage_initial|storage_final|database|auth|finalize|done",
    "last_error_code": "allowlisted code|null",
    "last_error_at": "ISO8601|null",
    "attempt_count": 0,
    "consecutive_failure_count": 0,
    "requested_at": "ISO8601",
    "complete_by": "ISO8601",
    "next_attempt_at": "ISO8601|null",
    "lease_state": "none|active|expired",
    "lease_expires_at": "ISO8601|null",
    "database_deleted_at": "ISO8601|null",
    "completed_at": "ISO8601|null",
    "updated_at": "ISO8601"
  }]
}
```

- `status` 기본값은 `active`이고 `active|pending|processing|completed|all`만 허용한다. `limit`은 1~100, 기본 50이다. 중복·미정의 query는 400이다
- 응답은 비식별 삭제 request ID와 운영 상태만 포함한다. 논리 사용자/Auth UID, Storage prefix·경로, status token hash를 포함하지 않는다
- 서버는 JWT만 신뢰하지 않고 현재 활성 service identity·미삭제 Auth user·미철회 `admin_members` membership을 DB에서 모두 재검증한다

`POST /api/admin/account-deletions/:id/retry` (관리자)

```json
{
  "action": "retry",
  "client_action_id": "uuid",
  "reason_code": "OVERDUE|TRANSIENT_FAILURE|WORKER_STALLED|MANUAL_REVIEW",
  "note": "1..500 chars"
}
```

새 작업은 202 + `{ "retry": { "status": "retry_scheduled", "id", "next_attempt_at" } }`, 이미 완료된 영수증은 200 + `{ "retry": { "status": "completed", "id" } }`를 반환한다. 동일 관리자의 동일 `client_action_id`에 요청 ID·이유·메모가 정확히 같은 재전송은 200 `duplicate`, 하나라도 다른 재사용은 409 `IDEMPOTENCY_CONFLICT`다. 잘못된 본문은 400, 형식이 잘못되었거나 없는 request ID는 동일하게 404로 처리한다.

- 완료되지 않은 작업만 `pending`·즉시 실행 가능 상태로 되돌리고 기존 lease를 무효화한다. phase·시도 횟수·최근 오류 근거는 유지하며 철회된 identity·참여 자격·복구코드·공유를 재활성화하지 않는다
- 재시도 작업은 관리자 Auth UID, 비식별 request ID, `client_action_id`, 고정 action·reason, 제한된 note, 결과·시각을 append-only 원장에 남긴다. 원장은 직접 수정·삭제할 수 없고, 단기 완료 영수증/작업의 보유 만료 삭제 또는 해당 관리자의 전체 계정 삭제에만 FK cascade로 함께 제거한다
- 관리자 mutation은 관리자별 rolling 1분 30회로 제한하고 초과 시 429와 `Retry-After`를 반환한다

## 7. 실물 수요 관찰

`POST /api/physical-requests` (인증 + 참여 자격) `{ "kind": "request" | "notify" }` → 204
- `(user, kind)`당 1회 — 중복은 204 멱등 처리. 결제·제작 없음

## 8. 남용·비용 방지

- 모든 429 응답은 `Retry-After`와 `details: { "retry_after_seconds": n }`를 포함한다
- 공개 요청 식별자는 신뢰 가능한 플랫폼 제공 IP를 서버 비밀키로 `HMAC(secret, fixed-purpose-domain + ip)` 처리한다. 날짜를 입력에 넣지 않아 UTC 자정 전후에도 같은 1시간 window를 사용하고, 용도별 고정 domain으로 다른 제한 키와 분리한다. 일반 클라이언트 `X-Forwarded-For`를 신뢰하지 않는다. 원시 IP·User-Agent 전체 문자열·공유 slug는 rate-limit 원장이나 분석 이벤트에 저장하지 않으며 HMAC rate 행은 마지막 요청 후 48시간 안에 삭제한다
- 기본 공개 제한: spots IP당 120회/분, fixed 공유 resolve·사진 프록시 IP당 각각 60회/분 및 개인카드당 합산 600회/10분, 신고 IP당 5회/시간
- 기본 인증 제한: collection 사용자당 60회/분, acquire 10회/분, events 12배치/분, 그 밖의 참여 쓰기 30회/분
- 인증 제한은 bearer 검증과 body/query 형식 검증을 통과한 API attempt가 첫 보호 도메인 RPC를 호출할 때 한 번 소비한다. 형식이 잘못된 body/query는 보호 RPC에 도달하지 않으므로 소비하지 않는다. DB wrapper는 Auth UID의 활성 논리 사용자를 잠그고 사용자 단위로 직렬화한 뒤 제한 소비와 실제 조회·mutation을 같은 트랜잭션에서 수행하며, `collection_read|acquire|event_batch|participant_write|admin_mutation`의 고정 목적만 허용한다. 제한 상태에는 논리 사용자 ID·고정 목적·최근 60초 timestamp 최대 60개만 두며 bearer token·IP·User-Agent·request body·멱등 키를 저장하지 않는다
- acquire의 설정 재조회·성공/실패 확정, 공유 slug 충돌 재시도, 개인카드 승격의 Storage 처리 후 확정처럼 한 API attempt가 여러 DB 트랜잭션을 사용하는 경우 첫 RPC가 반환한 server-only 논리 사용자 ID를 후속 RPC가 현재 활성 identity와 같은 트랜잭션에서 다시 잠그고 비교한다. 복구로 Auth UID가 다른 논리 사용자에게 재결합되면 후속 처리는 `UNAUTHORIZED`로 끝나며 새 사용자 데이터나 제한 용량을 변경하지 않는다. 이 ID는 공개 HTTP 응답·오류 details·로그에 포함하지 않고, 같은 attempt의 continuation은 제한을 다시 소비하지 않는다
- `participant_write` 30회/분은 개인카드 승격·공유 제출·실물 요청이 한 창을 공유한다. upload-url은 더 엄격한 DB quota인 10회/시간·20회/24시간을 이미 소비하므로 이 1분 창을 이중 소비하지 않는다. 참여코드 등록·복구·정책/최소연령/위치동의·privacy rights·계정삭제 사용자 요청/상태·collection 외 읽기는 각 전용 제한 또는 명시된 무제한 경계를 유지한다
- `admin_mutation` 30회/분은 초대코드 발급·retro 지급·공유/신고/정지 moderation action·위치정정 action이 한 창을 공유한다. 계정삭제 관리자 retry는 append-only action 원장의 기존 30회/분 제한이 권위 경계이므로 generic 창을 이중 소비하지 않는다. 멱등 mutation 재전송도 새 API attempt이면 제한 용량을 소비할 수 있지만, 제한기는 `client_*_id`를 저장·변경하지 않으며 통과 후 기존 멱등 결과·충돌 판정은 그대로 유지한다
- 복구·초대코드 등록·웹 삭제코드 검증은 subject당 5회/15분과 공개 IP당 20회/시간을 함께 적용한다
- 업로드 URL은 논리 사용자당 10회/시간·20회/24시간, 미정리 활성 임시 업로드 3개로 제한한다
- 개인카드는 사용자당 최대 200개, 영구 파생 이미지 1개당 최대 5 MiB·사용자 물리 합계 500 MiB다. 합계는 live 카드, 승격·정리 ledger, 개별 삭제 후 두 번째 Storage 삭제를 기다리는 exact byte charge를 포함하며 같은 객체를 중복 계산하지 않는다. 한도 초과는 409 `QUOTA_EXCEEDED`이고 저장 quota를 낮추려면 계약 버전을 올린다
- 관리자 mutation은 관리자당 30회/분이다. DB 제한 함수는 활성 service identity와 현재 `admin_members`를 같은 호출에서 재검사한다
- 사진 프록시의 Storage fetch는 10초 안에 끝나지 않으면 500 `INTERNAL`로 종료하며 오류 로그에 경로·slug를 남기지 않는다
- 임시 파일 정리는 선택한 단일 scheduler가 5분마다 내부 maintenance API를 호출한다. 현재 저장소의 Vercel Cron 설정은 45초 soft·48초 hard 예산 안에서 SQL `FOR UPDATE SKIP LOCKED`로 최대 4건씩 lease하고, Storage 삭제와 DB marker를 각각 bounded timeout으로 직렬 처리하며 예산 안에서 다음 page를 반복한다. Vercel 플랜·실등록을 증명할 수 없으면 Supabase Cron/pg_net 또는 외부 scheduler를 같은 5분 endpoint에 연결하고, 어느 경우에도 스테이징 canary 전 출시하지 않는다
- maintenance 실행은 성공·실패·재시도 수, 남은 backlog와 최고 대기시간만 기록하고 임계 초과 시 운영 경보를 발생시킨다. 사용자 ID·경로는 운영 상태 응답에 포함하지 않는다

## 9. 분석 이벤트

`POST /api/events` (인증 + 참여 자격, 배치 최대 20건)

```json
{ "events": [{ "client_event_id": "uuid(필수)", "name": "spot_view", "ts": "ISO8601", "props": { "spot_id": "uuid" } }] }
```

- `client_event_id`: **필수**, 클라이언트 생성 UUID. 서버는 `(user, client_event_id)` 기준 중복 제거
- 인증 경계 원칙: 이 엔드포인트는 인증+참여 자격이 필요하므로, **인증 전에 발생하는 이벤트는 클라이언트 발신 목록에 둘 수 없다**
- `user_id` 경계: `landing_view`·`share_view`는 **`user_id = null`인 서버 이벤트**(비인증 구간 발생 가능). 그 외 모든 이벤트는 **`user_id` 필수**

### 이벤트·props 고정 allowlist (TRUST 결정: 자유형 JSON 금지)

| 이벤트 (클라이언트 발신 — 인증 후에만 발생 가능) | 허용 props |
|---|---|
| `spot_view` | `spot_id` |
| `physical_interest_view` | — |

`acquire_attempt`·`personal_card_started`는 fact/acquisition/card와 정확히 상관할
식별자가 없어 정정·철회 시 선택 삭제할 수 없다. Stage 0 client allowlist에서 제거하고
마이그레이션 cutover에서 기존 client 행을 폐기하며, 이후 전송은 422로 거부한다.

| 이벤트 (서버 생성 — 클라이언트 발신 불가·수신 시 폐기) | 생성 시점 |
|---|---|
| `landing_view` | 공개 랜딩 요청 서버 로깅 (`ref`: `sns`,`share`,`direct`) — `user_id = null` |
| `share_view` | 활성 공유의 `POST /api/public-share/resolve` 처리 시 내부에서 해석한 `personal_card_id` 기준 집계 — `user_id = null`, raw secret 저장 금지 |
| `acquire_success` | acquire 성공 시 (props: `spot_id`) |
| `acquire_fail` | acquire 실패 시. props `code`는 제한된 enum: `OUT_OF_RANGE`·`LOW_ACCURACY`·`ALREADY_ACQUIRED_TODAY`·`SPOT_NOT_OPEN`·`GATE_CLOSED` |
| `personal_card_created` | 개인화 카드 생성 시 |
| `share_created` / `share_revoked` | 공유 생성·철회 시 |
| `physical_interest` | physical-requests 시 |
| `retro_granted` | 어드민 소급 지급 시 |
| `revisit` | 획득이 있는 사용자가 첫 획득일 다음 KST 일자부터 `GET /api/me/collection`을 호출하면 사용자·KST 일자당 1회 서버 생성 |

- `auth_start`는 Stage 0에서 **제거** (인증 전 구간이라 현 경계로 수집 불가 — 필요성 확인 시 후속 과제로 재설계)
- allowlist 외 키·중첩 객체·배열·위치 관련 키는 서버가 거부 (기존 스키마 통제와 일치)
- 성과 지표는 서버 생성 이벤트만 신뢰한다
- `landing_view`와 `share_view`는 원시 이벤트를 장기 보관하지 않고 시간대·ref 또는 `personal_card_id` 기반 집계로 전환한다. 기존 raw `share_slug` 이벤트는 삭제한다

## 10. 어드민 (서버 통제 admin 롤 전용)

- `POST /api/admin/invite-codes` `{ "count": n, "note" }` → 1회용 초대코드 n개 발급
- `POST /api/admin/retro-grants` `{ "app_user_id", "spot_id", "note" }` → type='retro' 지급 + 감사 원장 1:1
- `PATCH /api/admin/spots/:id` — 좌표·반경·정확도 임계·상태·6개 번역 수정
- `GET /api/admin/metrics` — 퍼널 요약 (field/retro 분리 집계)
- `GET /api/admin/moderation/shares?status=pending|active|rejected|taken_down&limit=1..100` — 기본 `status=pending`, `limit=50`. → 200 `{ "items": [...] }`. 공개 전 검수 및 상태별 최소 운영 목록이며 각 항목은 `id`·`share_state`·`submitted_at`·`caption`·`spot_name`·`reason_code`·`owner_suspended`·`open_report_count`·`photo_url`만 포함한다. slug·소유자 ID·Storage 경로는 포함하지 않는다
- `GET /api/admin/moderation/shares/:id/photo` — 현재 관리자 membership과 대상 상태를 매 요청 재검사하는 private WebP 프록시. `Cache-Control: private, no-store`
- `POST /api/admin/moderation/shares/:id/actions` `{ "action": "approve|reject|take_down|reinstate|suspend_owner", "client_action_id", "reason_code", "note": "1~500자" }` → 200 `{ "moderation": { "status": "applied|duplicate", "share_state": "private|pending|active|rejected|taken_down", "affected": 0 } }`. `approve|reinstate`는 `PUBLIC_SHARE_PUBLICATION=true`일 때만 허용하고 false이면 403 `GATE_CLOSED`, `details: { "gate": "share_publication" }`다. 이 boolean은 Route Handler뿐 아니라 service-role moderation RPC에도 전달되어 false이면 active 전환·재게시를 거부한다. `approve`는 제출에 고정된 두 acceptance가 현재 시행 버전·locale hash이고 소유자가 정지 상태가 아닌지 DB에서 재검사한다. 불충족이면 409 `MODERATION_CONFLICT`, `details: { "reason": "policy_resubmission_required|owner_suspended|invalid_transition" }`다. `reinstate`는 `pending`으로만 되돌리고 최신 정책 재제출과 재검수를 요구한다
- `GET /api/admin/moderation/reports?status=open|resolved|dismissed&limit=1..100` — 기본 `status=open`, `limit=50`. → 200 `{ "items": [...] }`. 신고 ID·대상 카드 ID·target·reason·comment·상태·생성시각만 반환하는 최소 운영 목록
- `POST /api/admin/moderation/reports/:id/actions` `{ "action": "dismiss|take_down|suspend_owner", "client_action_id", "reason_code", "note": "1~500자" }` → 200 `{ "moderation": { "status": "applied|duplicate" } }`
- `GET /api/admin/moderation/suspensions?status=active|lifted&limit=1..100` — 카드와 독립된 소유자 정지 목록. `{id,suspended_at,lifted_at,reason_code,note}`만 반환하고 논리 사용자 ID는 노출하지 않는다
- `POST /api/admin/moderation/suspensions/:id/actions` `{ "action": "unsuspend_owner", "client_action_id", "reason_code", "note": "1~500자" }` → 200 `{ "moderation": { "status": "applied|duplicate" } }`. 카드가 철회·삭제된 뒤에도 opaque suspension ID로 해제할 수 있으며 기존 콘텐츠는 자동 공개하지 않는다
- `GET /api/admin/account-deletions` / `POST /api/admin/account-deletions/:id/retry` — 삭제 SLA 조회·실패 작업 재시도
- `GET /api/admin/maintenance` — 경로·사용자 ID 없이 queue별 pending 수·최고 대기시간·마지막 성공 시각·재시도 후 실패 수 반환

모든 관리자 mutation은 실제 `private.admin_members` membership을 매 요청 확인한다. JWT user metadata는 권한 근거로 사용하지 않는다. `client_action_id`는 관리자별 멱등 키이고 운영자·조치·시각·사유를 변경 불가능한 감사 원장에 기록한다.

## 11. 스토어 심사 접근

- Apple·Google 각각 별도 이메일 인증 계정을 사용한다. credential은 Store Console 심사 메모에만 기록하고 Git·DB·API 로그에 저장하지 않는다
- 앱에는 Review Notes에 설명된 심사 로그인 경로를 제공한다. 이 경로는 Supabase email/password 세션을 만든 뒤 즉시 `GET /api/me/access`를 호출하고 `store_reviewer`가 아니면 세션을 제거한다. 일반 사용자 인증 흐름으로 노출하거나 reviewer 권한을 클라이언트에서 판정하지 않는다
- 심사자 계정은 `private.reviewer_accounts`와 실제 DB membership으로 판정한다. 일반 사용자 metadata로 권한을 부여하지 않는다
- 심사 계정은 활성 `private.reviewer_accounts` 행과 활성 `private.participant_access.access_kind=store_reviewer` 행을 모두 보유해야 한다. 한쪽만 존재하면 `store_reviewer`로 판정하지 않는다. 이 자격은 참여 게이트만 통과하며 **현장 위치 판정은 우회하지 않고 가짜 field 획득 API를 만들지 않는다**
- reviewer 지정은 해당 논리 사용자의 target advisory lock → 단 하나의 활성 service identity row lock → `auth.users` row lock → 해당 Auth 사용자의 전체 `auth.identities`·MFA/passkey credential row lock 순서를 따른다. 이메일 확인의 기준은 `auth.users.email_confirmed_at`이다. 정확히 1개의 `provider=email` identity가 Auth UID와 `provider_id`·`identity_data.sub`·이메일 값까지 일치하고, Auth 사용자가 활성·미삭제·non-anonymous·non-SSO이며 nonempty password hash, `role=authenticated`, `aud=authenticated`, `is_super_admin=false`, ban 없음을 모두 만족해야 한다. Supabase Admin `createUser({email,password,email_confirm:true})`가 생성하는 provider 소유 `identity_data.email_verified=false`는 확인 기준으로 사용하지 않는다. `raw_app_meta_data`는 `provider=email`, `providers=[email]` 두 키만, `raw_user_meta_data`는 GoTrue의 `email_verified=true` 외 사용자 정의 값이 없어야 한다. phone·pending email/phone/recovery/reauth 상태와 MFA factor·WebAuthn/passkey credential/challenge도 없어야 한다. phone-only·magic-link-only·`email_confirmed_at`이 없는 계정·다중 provider·SSO·pending·MFA/passkey 계정은 거부한다
- provision 대상은 Admin API가 새로 만든 전용 Auth credential·논리 사용자여야 한다. 최초 provision 시 `auth.users.last_sign_in_at`은 null이어야 하며, 현재 논리 사용자의 단일 활성 identity 외에 같은 Auth UID의 과거 철회 binding이 하나라도 있으면 재사용한 credential로 보고 거부한다. 이 로그인 이력 검사는 provision에만 적용해 지정 후 reviewer의 정상 sign-in과 reset은 허용한다. 과거/현재 reviewer·participant·recovery·acquisition·개인카드·실물수요·정책동의·위치·신고/차단·업로드/삭제·분석·계정삭제 이력이 하나라도 있는 실제 사용자 계정은 fixture 대상으로 전환하지 않고 409로 거부한다
- identity/link 완료가 먼저 commit되면 이후 reviewer 지정은 위 완성 상태에 한해 허용된다. reviewer 지정이 먼저 시작되면 `auth.users` credential·provider/user metadata 변경, `auth.identities` INSERT/DELETE/binding 변경, `auth.mfa_factors` 및 설치된 별도 WebAuthn credential/challenge 변경은 non-blocking fail-closed 경계에서 거부된다. `reviewer_accounts.user_id` 변경도 거부한다. 일반 사용자 변경과 reviewer sign-in/refresh volatile update는 허용한다
- Auth credential guard 설치 전 모든 활성 reviewer를 같은 불변식으로 전수 검사한다. 단 1건이라도 위반하면 UUID·이메일·플랫폼·건수를 오류에 포함하지 않고 전체 마이그레이션을 실패시킨다. 실패 대상을 운영자가 승인된 비식별 조회 절차로 철회·재provision하기 전에는 배포하지 않는다
- Supabase Auth는 수동 identity linking을 끄고(`enable_manual_linking=false`) 최근 재인증 기반 비밀번호 변경을 켠다(`secure_password_change=true`). 모든 외부/custom OAuth·SSO·passkey·Web3·phone·MFA provider는 reviewer production 환경에서 비활성화한다. 로컬 설정파일만으로 원격 적용을 간주하지 않고 staging·production Auth 설정을 배포 체크리스트로 대조한다
- GoTrue의 password-hash DB encryption rewrap과 사용자의 password 변경은 둘 다 `auth.users.encrypted_password` 변경이므로 DB trigger에서 안전하게 구분할 수 없다. 현재·과거 reviewer에는 fail-closed를 유지한다. GoTrue/Auth 버전 또는 Auth DB encryption key/version 변경 전 활성 reviewer를 철회하고, staging에서 동일 변경을 rehearsal한 뒤 새 Auth 계정·새 `app_user_id`·새 `fixture_version`을 provision해 password sign-in/refresh canary가 통과해야만 배포한다. 기존 reviewer credential의 in-place rewrap은 금지한다
- reviewer 세션에서는 복구코드 발급·claim, 획득 후 복구 안내, 이메일 연결 UI를 표시하지 않는다. UI 숨김은 보안 경계가 아니며 서버·DB 거부가 권한 경계다
- reviewer 철회는 인증된 관리자만 호출하는 `DELETE /api/admin/reviewer-access/:app_user_id`를 사용한다. DB 경계에서는 service-role 전용 3-argument `api_private.revoke_reviewer_access(admin_auth_user_id, app_user_id, client_action_id)`가 관리자 인가·요청 제한·멱등성 감사·fixture inventory 정리를 한 트랜잭션으로 처리한다. 과거 1-argument primitive는 Data API 전 역할의 EXECUTE를 철회한 내부 구현이며 직접 호출하지 않는다. 영구 reviewer 이력을 대상 경계로 사용하므로 membership 행이 이미 삭제된 과거 reviewer의 잔여 권한도 닫는다. reviewer·participant 자격, 대상 논리 사용자의 모든 활성 서비스 바인딩·모든 미사용 복구코드를 철회하고 공유 카드를 `private`로 돌린다. 이미 claim된 코드는 소모 완료 상태를 유지한다. 기존 JWT는 이후 모든 보호 API의 활성 바인딩 재검사에서 즉시 401이다. 현재 endpoint는 Auth Admin 삭제를 자동 수행하지 않는다. 승인된 운영자가 DB 철회 성공 후 별도 Admin `deleteUser`를 실행·기록해야 하며, 완료 전에는 외부 출시 게이트를 닫는다. 이 후속 조치는 즉시 보안 경계로 삼지 않는다
- 철회된 reviewer membership·Auth credential·논리 사용자를 수정하거나 재활성화해 재발급하지 않는다. 심사 계정이 다시 필요하면 기존 계정을 철회한 뒤 새 Auth 계정·새 `app_user_id`·새 `fixture_version`으로만 provision한다. DB는 삭제된 membership 재삽입과 `revoked_at` 원복을 거부한다
- 대한민국 밖에서도 나머지 핵심 기능을 검토할 수 있도록 서울 6개 카드를 `retro`로 미리 지급하고, 승인된 안전한 샘플 개인카드와 활성 공유 링크를 fixture로 제공한다
- 앱의 "인화 연출 다시 보기"는 기존 획득 데이터를 읽어 클라이언트에서 연출만 재생한다. 새 획득·순번·이벤트를 쓰지 않고 실제 현장 인증과 명확히 구분한다
- `GET /api/me/access` (인증) → `{ "participant": true, "access_type": "standard|store_reviewer", "field_acquisition_requires_location": true, "fixture_version": "string|null" }`
- 이 GET은 JWT 사용자 확인 뒤 활성 서비스 바인딩을 DB projection에서 다시 검사한다. 철회·삭제된 바인딩은 401이며, `access_type=store_reviewer`와 non-null `fixture_version`은 위 두 DB membership이 모두 활성일 때만 반환한다. 그 외에는 `access_type=standard`, `fixture_version=null`이다
- `POST /api/admin/reviewer-access`는 `{ "app_user_id": "uuid", "store_platform": "app_store|play_store", "fixture_version": "1~64자 버전", "client_action_id": "uuid" }`, `POST /api/admin/reviewer-access/:appUserId/reset`과 `DELETE /api/admin/reviewer-access/:appUserId`는 `{ "client_action_id": "uuid" }`만 받는다. 이메일·비밀번호·token·share secret은 요청·응답·fixture·감사 원장에 넣지 않는다. 같은 관리자의 같은 `client_action_id`·같은 payload 재시도는 멱등이고 다른 payload는 409다. reset은 활성 reviewer만 가능하다
- 세 endpoint와 원자적 prepare/complete/revoke DB primitive, Storage 재시도, 결정적 fixture는 로컬 구현·검증됐다. reset complete는 교체되는 이전 사진 exact path의 digest-only 영구 tombstone을 같은 DB 트랜잭션에 먼저 남겨 외부 삭제 뒤 느린 reset 전 upload metadata가 이전 객체를 재생성하지 못하게 한다. revoke도 완료/미완료 action의 사진 object를 모두 정리하고, DB 철회 트랜잭션에서 각 exact path의 tombstone을 먼저 남겨 같은 경합을 `storage.objects` trigger로 거부한다. 계정삭제 시작 시에도 같은 opaque object 목록을 기존 2-pass 삭제 manifest로 넘긴다. 다만 Apple·Google용 실제 원격 Auth 계정은 승인된 서버 운영 세션에서 Supabase Admin API로 별도 생성하고, 비밀 관리자·Store Console 비공개 Review Notes에 credential을 전달해야 한다. 원격 계정 생성·hosted provision·실제 후보 IPA/AAB canary·Auth 세션 후속 철회가 끝나기 전에는 제출용 계정이 준비됐다고 간주하지 않는다
- Review Notes에는 대한민국 현장 기능임을 밝히고, 심사 계정 로그인·샘플 컬렉션·인화 재생·공유·신고·차단·로컬 숨김·삭제 테스트 경로를 정확히 설명한다
- 실제 국내 현장에서 foreground 위치 권한 요청부터 field 획득까지 촬영한 짧은 검증 영상을 Review Notes의 접근 가능한 HTTPS URL로 함께 제공한다. 영상은 심사용 설명 자료이며 앱 내부 획득을 위조하지 않는다

## 12. 데이터 모델·권한

### 다국어

- `public.regions(code, country_code, sort_order)`
- `public.region_translations(region_code, locale, name, status, approved_at, approved_by)`
- `public.spot_translations(spot_id, locale, name, status, approved_at, approved_by)`
- `public.card_translations(card_id, locale, title, status, approved_at, approved_by)`
- locale은 `ko|en|ja|zh-Hans|zh-Hant|vi` 고정값이다
- translation status는 `draft|approved`다. TRUST가 최종 승인한 6개 locale만 `approved`로 전환하고 승인자·시각을 감사한다. `teaser|open` 전환과 card publish 전에 6개 번역이 모두 `approved`인지 DB에서 검사한다
- 첫 acquisition 이후 카드의 번역·이미지·색상은 변경하지 않고 새 card 행으로 버전업한다
- 기존 `name_ko/name_en`, `title_ko/title_en`은 v0.3 전환 동안 호환용 읽기 전용으로 유지한다

### 삭제·UGC·운영

- 삭제: `app_users.deletion_requested_at`, `private.account_deletion_jobs`, Auth UID·Storage 객체 manifest, 단기 비식별 receipt
- UGC: `personal_cards.share_state(private|pending|active|rejected|taken_down)`와 reviewer UID 또는 redaction marker 중 정확히 하나인 검수 표식, 제출 당시 terms/community acceptance FK, immutable `policy_documents`·locale별 문서 URL/hash, `policy_acceptances`, `user_blocks`·멱등 action 원장, `content_reports`, `public_report_rate_limits`, `moderation_actions`, opaque ID 기반 `share_owner_suspensions`
- 심사: `private.reviewer_accounts`, 결정적 template `private.reviewer_fixture_templates`, 활성 fixture inventory `private.reviewer_fixture_items`, 비식별 append-only lifecycle 감사 `private.reviewer_access_actions`
- 남용·운영: `private.rate_limit_windows`(논리 사용자·고정 purpose별 최근 60초 timestamp 최대 60개), 시간대별 landing/share rollup, `private.maintenance_runs`

모든 신규 앱 테이블은 RLS와 `FORCE ROW LEVEL SECURITY`를 적용한다. `anon`·`authenticated`에 직접 테이블 쓰기 권한을 주지 않는다. 신규 RPC는 `api_private`, `SECURITY DEFINER`, 빈 `search_path`, 완전한 schema-qualified 이름을 사용하고 `PUBLIC`·`anon`·`authenticated` 실행권한을 회수해 `service_role`만 실행한다. 삭제 요청과 공유 철회는 게이트 폐쇄·정지 상태에서도 항상 허용한다.

## 13. Feature Flags

- `PUBLIC_RECRUIT_GATE` (기본 false): 위치정보법 검토 완료 + TRUST 승인 전 true 금지. false 동안 참여 쓰기 API는 초대코드 자격 필수 (0장 참여 게이트 참조)
- `PUBLIC_SHARE_CREATION` (기본 false): 새 pending secret 생성과 policy snapshot 갱신 재제출을 통제한다. 실제 정책 문서와 pending 검수 운영이 준비된 내부 pilot에서만 별도 승인으로 열 수 있다. 기존 소유자의 상태 조회·상태 변경 없는 멱등 반환·철회는 flag와 무관하다
- `PUBLIC_SHARE_PUBLICATION` (기본 false): admin `approve|reinstate`, active 공개 JSON·사진·신고·차단을 함께 통제한다. false이면 승인·재게시는 403 `GATE_CLOSED(details.gate=share_publication)`, public surface는 404다. fragment/fixed POST 회귀, native minimum-age 차단 정합, 실제 신고·차단·삭제·지원 운영, production 로그 검증과 TRUST 승인이 끝나기 전에는 true 금지다

### v0.2.3 → v0.3.8 공유 전환

1. 배포 전 `PUBLIC_RECRUIT_GATE=false`, `PUBLIC_SHARE_CREATION=false`, `PUBLIC_SHARE_PUBLICATION=false`를 확인한다
2. 선행 privacy cutover는 기존 `share_slug IS NOT NULL` 행을 중간 상태 `pending_review`, null 행을 `private`로 설정하고 `active` 전환을 hard-block한다. legacy acceptance snapshot은 null, `share_resubmission_required=true`로 둔다
3. v0.3.5 UGC 전진 마이그레이션은 중간 6-state enum을 5-state로 정규화하되 기존 `share_slug IS NOT NULL` 행은 상태와 무관하게 slug를 제거하고 `private` + `LEGACY_SLUG_ROTATION_REQUIRED` 재제출 상태로 바꾼다. 어떤 legacy 공유도 자동 `active` 또는 기존 secret 유지 상태로 남지 않는다
4. legacy 소유자는 creation flag가 열린 뒤 최신 정책에 동의하고 `POST .../share`를 다시 호출해 새 secret과 acceptance snapshot을 받아야 한다. 그 전에는 운영자도 승인할 수 없다
5. 같은 배포에서 public share JSON·사진·신고·차단 RPC와 admin 승인 RPC에 publication boolean을 전달해 false일 때 DB 경계에서도 fail closed하고 raw share slug 이벤트 기록을 중단한다
6. v0.3.8에서 owner URL을 fragment로 회전하고 legacy page/API secret path를 redirect 없는 404로 제거한다. fixed POST는 publication boolean을 계속 DB까지 전달한다
7. pending 내부 pilot은 creation flag만 열 수 있다. native minimum-age 차단 정합과 API·DB·운영자 검수 도구·신고·인증 사용자 서버 차단·무인증 웹 로컬 숨김·삭제·지원 운영이 함께 검증되기 전에는 publication flag를 열지 않는다

## 14. 구현·제출 전 검증 순서

1. 다국어 스키마와 `GET /api/spots`, `GET /api/me/collection`, 소유 사진 프록시, acquire 응답·공개 share의 6개 언어 전환, raw share slug 이벤트 제거
2. rate limit·quota·반복 cleanup·maintenance 상태
3. 계정 및 전체 데이터 삭제와 공개 웹 삭제 경로
4. 정책 동의·공유 사전 검수·신고·로컬 숨김·개별 삭제·운영자 조치
5. reviewer lifecycle 로컬 회귀와 Apple·Google 원격 계정 provision·실제 후보 빌드 canary
6. 현장 검증된 서울 6개 스팟·6개 언어·카드 자산·정책 문서

각 단계는 `db reset`, pgTAP, DB lint/advisors, API 단위·통합·동시성 E2E를 통과해야 한다. 로그·DB·분석·오류 추적에 사용자 원시 좌표·raw IP·raw share slug가 없고, 삭제 요청 직후 기존 JWT가 모든 보호 API에서 401인지 별도 검증한다.

## 15. 위치정보·최소연령 준수 전진 변경

이 절은 reviewer v0.3.7과 fragment v0.3.8의 누적 결정을 보존해 통합한 위치 준수
계약이다. 상세 데이터·보유·삭제·운영 경계는 `docs/LOCATION-COMPLIANCE.md`가 기준이다.

- 최소연령: `POST /api/me/minimum-age-attestation`은
  `{ "minimum_age_passed": true, "version": "18plus-v1" }` exact payload만 받고
  204를 반환한다. 상태 GET을 제공하며 DOB·연도·나이·파생 hash를 받거나 저장하지 않는다.
- 서비스 이용: 새 위치동의, resume, 현장 획득과 field 파생물은 active identity,
  최소연령 attestation, current `location_terms` 동의를 모두 서버·DB에서 재검사한다.
- 권리행사: 위치동의 상태, 이용내역, 정정 대상·요청, pause, 전부철회는 active
  identity만 요구한다. age·participant·current consent를 선행조건으로 두지 않는다.
- API: `GET/POST/PATCH/DELETE /api/me/location-consent`,
  `GET /api/me/location-use-facts`, `GET /api/me/location-correction-subjects`,
  `GET/POST /api/me/location-corrections`, 관리자 정정 queue/action을 제공한다.
- 위치 이용내역·정정 대상·정정 요청내역 GET은 `limit=1..100`과 사용자 귀속 서명
  `cursor`를 사용하는 descending keyset pagination이다. 정정 요청내역 keyset은
  `(requested_at, correction_request_id)`이며 공개 cursor에는 응답에 이미 포함된
  두 anchor와 버전만 넣는다. age·participant·current consent gate를 추가하지 않는다.
  각 목록 응답은 `{ "items": [...], "next_cursor": "signed|null" }`로 고정하고,
  `next_cursor`가 null이 될 때까지 조회할 수 있어야 하며 100건에서 절단하지 않는다.
- 오류: 428 `MINIMUM_AGE_ATTESTATION_REQUIRED`, 428 `LOCATION_CONSENT_REQUIRED`,
  403 `LOCATION_USE_PAUSED`, 409 `LOCATION_WITHDRAWAL_PENDING`,
  409 `LOCATION_CORRECTION_PENDING`을 추가한다.
- 원시 `lat/lng/accuracy/distance/IP/request`는 저장·로그·분석에서 금지한다.
  `location_use_facts`에는 논리적 시도, spot, 목적, 서버 시각, terminal outcome과
  allowlist 실패 code/details만 기록한다.
- 정상 fact·disclosure·resolved correction 보유기간은 6개월, open correction은
  해결까지 보존한다. 전부철회는 field 파생물만 지우고 retro·gift를 보존한다.
- Storage는 signed URL 만료를 포함한 두 단계 삭제 후 DB를 완료하며 manifest 경로는
  즉시 제거한다. 최소 receipt는 30일, 완료 기준 anti-replay digest는 6개월 보관한다.
- field 사진 승격은 Storage I/O 전에 temp·permanent 경로를 durable ledger에 등록한다.
  완료 commit이 불확실하면 release가 이 상관을 제거하지 않으며, exact card 참조 또는
  별도 cycle의 두 단계 Storage 삭제가 확인된 뒤에만 ledger를 제거한다.
- 유지보수 endpoint는 `CRON_SECRET`으로 보호한다. location·temp는 5분, 전체 계정삭제는
  1분 주기 scheduler와 backlog 경보가
  스테이징에서 실증되지 않으면 출시 blocker다.
