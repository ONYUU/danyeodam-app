# 위치정보·최소연령 준수 경계

작성 기준일: 2026-08-12
상태: 구현·정적 검증 진행 중. fresh reset, 전체 pgTAP, 동시성, API E2E 및
스테이징 운영 증거가 모두 완료되기 전에는 출시 준비 완료로 보지 않는다.

이 문서는 다녀담 Stage 0의 위치정보 수집, 만 18세 이상 확인, 열람·정정·철회,
보유기간 및 삭제 작업의 단일 기준 문서다. 법률 해석과 정책 문안의 최종 적정성은
대한민국 개인정보보호법·위치정보법 기준으로 별도 법무 검토가 필요하다.

## 1. 고정 결정

- 서비스 이용을 위한 최소연령 확인은 `minimum_age_passed=true`,
  `version=18plus-v1`, 서버 기록시각만 저장한다. 생년월일, 출생연도, 실제 나이,
  파생 해시를 서버에 저장하거나 전송하지 않는다.
- 정책 current set은 이용약관, 개인정보처리방침, 커뮤니티 가이드라인,
  위치기반서비스 이용약관의 4종이며, 각 정책은 `ko`, `en`, `ja`, `zh-Hans`,
  `zh-Hant`, `vi` 6개 locale이 모두 있어야 원자적으로 게시된다.
- UGC 제출 동의는 이용약관과 커뮤니티 가이드라인 2종을 유지한다. 위치약관
  동의는 별도 상태로 관리하며 UGC 동의에 묶지 않는다.
- 위치 동의 상태는 `active`, `paused`, `withdrawal_pending`만 사용한다. 정책
  버전 갱신 동의는 `paused`를 자동 해제하지 않으며 재개는 명시적 PATCH만 허용한다.
- 위도·경도·정확도·거리·원시 IP·요청 본문은 DB, 분석 이벤트, 로그에 저장하지
  않는다. 좌표와 정확도는 Node 런타임 메모리에서만 검증한다.
- KST 일일 획득, 카드별 비노출 순번, 서버 판정, 논리적 시도별 idempotency
  경계는 기존 획득 계약을 유지한다.

## 2. 인증과 권리행사 경계

두 인증 경계를 구분한다.

1. 서비스 이용 경계: 새 위치 동의, `paused`에서 `active` 재개, 현장 획득,
   field 카드·사진·공유 파생물 생성은 active identity, 최소연령 확인, current
   위치동의를 모두 재검사한다.
2. 개인정보 권리 경계: 기존 동의 상태, 위치 이용내역, 정정 대상·요청 내역,
   일시중지, 전부철회는 active identity만 요구한다. 최소연령 확인이나 participant
   권한을 선행조건으로 두지 않는다. revoked UID는 계속 401이다.

모든 identity-bound 쓰기는 recovery claim과 active binding을 행 잠금으로
직렬화한다. current policy를 사용하는 경로는 `policy-current-set` shared lock 뒤
owner lock 순서를 사용한다. 정책 게시자는 같은 key의 exclusive lock만 획득한다.

## 3. API 표면

| 목적 | 메서드·경로 | 성공 | 인증 경계 |
|---|---|---|---|
| 최소연령 기록 | `POST /api/me/minimum-age-attestation` | 204 | active identity, exact payload |
| 최소연령 상태 | `GET /api/me/minimum-age-attestation` | 200 | active identity |
| 위치 동의 상태 | `GET /api/me/location-consent` | 200 | privacy rights |
| 위치 동의 | `POST /api/me/location-consent` | 204 | adult active |
| 일시중지·재개 | `PATCH /api/me/location-consent` | 204 | pause=privacy rights, resume=adult active |
| 전부철회 | `DELETE /api/me/location-consent` | 202 또는 204 | privacy rights |
| 이용내역 | `GET /api/me/location-use-facts` | 200 | privacy rights |
| 정정 대상 | `GET /api/me/location-correction-subjects` | 200 | privacy rights |
| 정정 요청·내역 | `POST/GET /api/me/location-corrections` | 201·200 | privacy rights |
| 관리자 정정 | `GET /api/admin/location-corrections`, `POST .../[id]/actions` | 200 | active admin |
| 유지보수 | `GET /api/internal/maintenance/location-compliance` | 200 | `CRON_SECRET` |

주요 오류는 428 `MINIMUM_AGE_ATTESTATION_REQUIRED`, 428
`LOCATION_CONSENT_REQUIRED`, 403 `LOCATION_USE_PAUSED`, 409
`LOCATION_WITHDRAWAL_PENDING`, 409 `LOCATION_CORRECTION_PENDING`으로 고정한다.

정정 대상 목록은 `field_acquisition_id`, `spot_id`, `acquired_on_kst`만 반환한다.
커서는 같은 KST 날짜와 불투명 acquisition UUID만 서명하며 정확한 방문시각을
포함하지 않는다. 위치 이용내역의 실패 사유는 고정 allowlist와 제한된 속성만
반환한다: `LOW_ACCURACY {retry:true}`, `OUT_OF_RANGE {distance_band:near|far}` 또는
세부값이 없는 나머지 coarse code다.

이용내역·정정 대상·정정 요청내역은 모두 `limit=1..100`의 사용자 귀속 HMAC
cursor로 끝까지 조회한다. 정정 요청내역은 `(requested_at desc, id desc)` keyset을
사용하며 cursor payload에는 응답으로 이미 공개된 `requested_at`, request UUID,
버전만 포함한다. 빈·변조·다른 사용자·다른 목록 domain의 cursor는 400으로
거부한다. 정확히 100건인 페이지 뒤에는 빈 최종 페이지가 한 번 발생할 수 있으나,
`next_cursor=null`까지 진행하면 101건 이상도 누락 없이 조회되어야 한다.

## 4. 위치 이용 원장과 이벤트

`location_use_facts`는 논리적 사용자, idempotency key, spot, 목적,
서버 수집·결정 시각, `pending|passed|failed`, 제한된 실패 code/details만 저장한다.
한 논리적 시도는 `pending`에서 terminal로 한 번만 전이하며 성공과 실패가 서로를
뒤집지 않는다. 같은 key 재시도는 기존 terminal 결과를 결정적으로 재현한다.

terminal `acquire_success|acquire_fail` 이벤트는 정확한 fact FK를 갖고 한 fact당
최대 1건이다. 클라이언트 `acquire_attempt`와 `personal_card_started`는 정확한 삭제
상관키가 없어 Stage 0 입력 allowlist에서 제거하고, 기존 uncorrelated 행은 전진
마이그레이션에서 집계 후 삭제한다.

## 5. 열람·정정

- 이용내역 열람 시 별도의 최소 disclosure audit만 기록한다. 전부철회와 owner
  lock으로 직렬화하여 철회 완료 뒤 새 audit이 남지 않게 한다.
- 사실 원장은 정상적으로 6개월 보관한다. 다만 open 또는
  `approved_pending_correction` 요청이 참조하거나 전부철회가 진행 중인 fact는
  처리가 끝날 때까지 purge하지 않는다.
- fact가 이미 6개월 purge된 field 방문도 `field_acquisition_id`로 정정할 수 있다.
  privacy-rights 전용 subject 목록을 제공하므로 최소연령 확인을 거부한 legacy
  사용자도 대상을 찾을 수 있다.
- 승인 상태는 실제 정정 완료가 아니다. 관리자 승인은 targeted erasure job을
  만들고 `approved_pending_correction`으로 전환한다. Storage와 DB 삭제가 모두
  끝난 뒤에만 `corrected`가 된다.
- 정정 요청 입력은 한 대상 UUID, client request UUID, 고정 사유 enum만 받는다.
  immutable domain-separated fingerprint로 완료 후 같은 요청 재시도를 duplicate로
  재현하고 다른 payload는 conflict로 거부한다.
- 정정 요청내역 read RPC는 active binding 행 잠금과 owner advisory lock을 같은
  순서로 획득한다. recovery rebind·전부철회 cleanup과 경합해도 한 페이지가 다른
  논리 사용자로 전환되지 않으며, 최소연령 attestation이나 participant 자격은
  여전히 요구하지 않는다.

open 정정은 처리 완료까지 보관하며 운영상 24시간을 초과하면 maintenance가
fail-closed 경보를 낸다. corrected·rejected 요청과 disclosure audit은 6개월 후
purge한다. 최종 법정 보존기간은 출시 전 법무 검토로 확정해야 한다.

## 6. 일시중지·전부철회와 삭제

- `paused`는 새 획득과 위치 파생물 생성을 즉시 차단하지만 기존 권리 API는 유지한다.
- 전부철회 요청은 즉시 `withdrawal_pending`으로 전환하고 새 획득, field 사진 생성,
  share pending·active 진입을 차단한다. 기존 field 공유는 즉시 비공개 처리한다.
- 삭제 대상은 field acquisition과 그 personal card·사진·공유, exact correlated
  terminal analytics, 위치 fact, disclosure, correction, location acceptance·consent다.
  retro·gift acquisition과 카드, 관련 이벤트, 일반 탐색 이벤트는 보존한다.
- Storage manifest에는 temp cleanup이 끝나지 않은 모든 경로와 permanent 경로를
  먼저 동결한다. 첫 삭제 후 `max(기존 만료 경계, first_deleted_at+10분)` 이후의
  별도 worker cycle에서 최종 삭제한다. 미만료 signed URL 재업로드를 이 단계로
  제거한다.
- field 사진 승격은 Storage I/O 전에 temp·permanent 경로를
  `private.personal_card_field_object_ledger`에 원자 등록한다. 완료 RPC가 실제
  commit됐으면 exact card path 확인과 함께 ledger를 제거하고, commit/응답이
  불확실하거나 실패하면 release 이후에도 acquisition 연관을 보존한다. 독립
  reconciliation은 promotion 10분 retry window가 끝나기 전 temp를 claim하지 않으며,
  permanent와 temp 모두 첫 삭제와 10분 유예 후 최종 삭제를 서로 다른 cycle에서
  수행한다. temp 최종 경계는 signed URL 만료+10분보다 빠를 수 없다.
  permanent 최종 경계도 begin lease 만료+10분보다 빠를 수 없어, 철회와 이미 시작된
  server upload가 경합해도 최종 pass 뒤 객체가 재생성되지 않는다.
- 정정·철회가 먼저 시작되면 ledger의 모든 경로를 manifest에 동결하고 독립
  reconciler는 해당 경로를 건너뛴다. 두 Storage pass가 끝난 뒤 ledger를 먼저
  제거해야 restrictive FK가 field acquisition 삭제를 허용한다.
- Storage 최종 삭제가 끝난 뒤 DB 파생물을 삭제한다. 완료 시 manifest 원문 경로는
  즉시 삭제하고, 사용자 연결 최소 처리 영수증은 30일 후 purge한다.
- Storage 실패는 attempt counter 상한 없이 재시도한다. pending withdrawal 동안
  failed-only fact도 purge하지 않아 완료 시 anti-replay fingerprint를 재구성한다.
- 정정·철회 완료 후 같은 논리적 key 재생성을 막기 위해 user·spot·시각을 담지 않은
  owner digest와 attempt-key digest(각 32-byte)만 6개월 보관한다. 분리된 key digest는
  복구 시 원시 key 없이 source owner에서 target owner로 원자 이전하며, 만료는 실제
  삭제 완료시각을 기준으로 다시 계산한다.

현재 `data_erasure_jobs`는 location withdrawal/correction 전용이다. account deletion
재사용을 주장하지 않는다. 계정삭제는 app_user FK, 30일 receipt, UGC redaction을
포함한 별도 전진 설계가 필요하다.

## 7. 운영과 배포 경계

maintenance는 5분마다 실행해야 한다. `CRON_SECRET` bearer 검증 뒤 bounded job/item
batch, field object reconciliation, Storage 두 단계 삭제, retention purge, backlog 집계를
처리한다. 한 호출은 erasure job 최대 2건·전체 manifest 4건, standalone object 4건,
retention purge 250건으로 제한한다. Storage 호출은 개별 5초 timeout, RPC는 개별 4초,
invocation은 45초 soft/48초 hard budget을 적용하고,
예산 초과로 미처리된 lease는 다음 cycle로 반납한 뒤 retention·backlog을 계속
수행한다. failed item, 24시간 초과 job, 고시도 job, 24시간 초과 open correction,
실제 정리 가능 시각이 1시간 초과한 object reconciliation이 있으면 비민감 집계만
로그하고 500으로 실패한다. future final-delete boundary, 활성 promotion/worker
lease, 미완료 erasure manifest가 소유한 경로는 object overdue에서 제외하고,
해당 erasure job의 24시간 SLA로 감시한다.

Vercel 5분 Cron은 지원 플랜이 확인된 경우에만 사용한다. 지원되지 않으면 Supabase
Cron/pg_net 등 외부 scheduler가 같은 secret-protected Node endpoint를 5분마다
호출해야 한다. 어느 경로도 스테이징에서 실증되지 않으면 제출·출시 blocker다.

마이그레이션 cutover는 모든 구버전 ingress/API writer, cron/maintenance
worker를 차단·scale-to-zero하고 active RPC·DB transaction 0건을 증명한 뒤만
시작한다. DB compatibility trigger는 구 promotion begin의 temp/permanent object
ledger 2행을 보정하고 exact pending fact 없는 구 field acquisition을 rollback하며,
server `acquire_success`를 exact acquisition→fact에 연결한다. 이 방어층은 이미
파싱된 acquire context, promotion complete, share/revoke, recovery 본체를 보정하지
못하므로 전체 writer drain을 대체하지 않는다.

구체 절차와 증거는 `docs/LOCATION-COMPLIANCE-DEPLOYMENT.md`를 따른다.

## 8. v0.3.9 통합 결과와 남은 운영 경계

- reviewer credential v0.3.7과 fragment transport v0.3.8의 이력·기능을 보존하고 위치
  준수 계약을 그 다음 버전에 통합했다.
- location migration은 reviewer `20260811203000` 뒤의 `20260811203100`·
  `20260811203200`으로 배치했고 location pgTAP은 `009`로 분리했다. fresh reset과
  local/remote migration list 대조는 배포 후보에서 다시 수행한다.
- fixed `POST /api/public-share/block`은 publication gate를 가장 먼저 적용하고 필수
  bearer JWT의 adult-active DB projection을 검증한 뒤 body를 읽는다. native 호출에
  web age cookie를 요구하지 않는다. 공개 web의 resolve·photo·report는 기존 signed
  age cookie를 유지하며 미존재·변조·만료 시 `AGE_ATTESTATION_REQUIRED`다.
- 모바일 age gate는 통과 전 일반 AuthProvider를 mount하지 않되, 저장된 세션으로
  이용내역·정정·철회·계정삭제만 수행하는 제한된 privacy-rights 경로를 제공한다.
- 스테이징 scheduler 호출, Storage 실제 삭제, backlog 경보 수신, field spot 현장
  검증 증거는 아직 확인 필요다.
