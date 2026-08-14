# 결정 로그

| 날짜 | 결정 | 근거 |
|---|---|---|
| 2026-08-07 | 브랜드 확정: 다녀담/DANYEODAM 단일 표기 | 조어·스크리닝 클린, DND/D&D 폐기 |
| 2026-08-07 | 초기 BM 가설: 무료+광고, B2B/B2G 중심, 실물 확장 옵션 | v0.5~v0.8 당시 가설. 2026-08-12 결정으로 대체 |
| 2026-08-07 | 시즌제 폐지 → 지역 순차 공개, 소급 획득 도입 | v0.7 |
| 2026-08-07 | 초기 Stage 0 가설은 모바일웹, QR 없음, 원탭 위치 인증 | 접근성 우선. 2026-08-12 Expo 결정으로 모바일웹 선택 대체 |
| 2026-08-07 | 당시 서울 6개 방향 결정 (북촌 제외, 롤파크 추가). 구체 목록은 2026-08-12 현장검증 후보 결정으로 대체 | 레드존 리스크 / e스포츠 인바운드 |
| 2026-08-07 | 익명 시작+복구코드, 정상자 보호 판정, 법률 검토 전 내부 테스트만 | REPLY_01 대표 결정 |
| 2026-08-07 | Stage 1 착수 게이트는 사용자 지표만 (B2B/B2G 병행) | 대표 결정, 리스크 문서화 |
| 2026-08-08 | 복구 claim: 트랜잭션 내 활성 바인딩 즉시 철회 + 보호 API 매 요청 재검사(401) | 대표 결정 (중복 획득·악용 차단, JWT 즉시 무효화 아님) |
| 2026-08-08 | 내부 테스터 자격은 1회용 초대코드 방식 | 대표 결정 (운영 부담 최소) |
| 2026-08-08 | 분석 이벤트 props는 이벤트별 고정 allowlist, 성과 지표는 서버 생성 이벤트만 신뢰 | 대표 결정 (위치정보 최소주의) |
| 2026-08-08 | API-CONTRACT v0.2 작성 (Codex P0 8건 반영), Codex 검토 대기 | 계약 변경 절차 |
| 2026-08-08 | 계약 v0.2.1: Codex 지적 5건 반영 (claim 정밀화·idempotency spot_id 기준·이벤트 경계·EXIF 서버 통제·발급 흐름 통일) | Codex 재검토 대기 |
| 2026-08-08 | 계약 v0.2.2: PR #2 재검토 8건 반영 (충돌 조건 한정·user_id 경계·acquire_fail props·enum 5종·상태 통일·업로드 시간 구분) | Codex 최종 검토 승인·계약 확정 |
| 2026-08-12 | 계약 v0.2.3: 복구·이메일 충돌 코드, claim 익명 분기·활성 바인딩 401, 조건부 refresh 철회, 업로드 발급 시각 기준 10분·상태별 오류를 정정 | PR #3 구현 감사 결과 반영·계약 확정 |
| 2026-08-12 | 최종 개발 목표: iOS App Store·Google Play에 제출 가능한 상태까지 완성. 실제 제출·심사는 별도 | 대표 확정 |
| 2026-08-12 | 소비자 앱은 무료·무광고·무결제. B2C 실물 제작은 출시 범위에서 제외하고 명시적 수요·원가·공급 검증 후 재검토 | 대표 확정 |
| 2026-08-12 | 네이티브 앱은 Expo React Native, 앱 ID는 `kr.danyeodam.app`; Next.js는 API·공개 웹·운영 화면 유지 | 대표 확정·스토어 요건 검토 |
| 2026-08-12 | 서비스 현장은 대한민국, 스토어 배포는 글로벌. 지원 언어는 `ko`, `en`, `ja`, `zh-Hans`, `zh-Hant`, `vi` | 대표 확정 |
| 2026-08-12 | 공개 사진은 검색·피드 없는 secret-link 공유를 유지하되, 초기에는 정책 동의·수동 사전 검수·신고·차단·삭제를 적용 | 스토어 UGC 정책 대응 |
| 2026-08-12 | 스토어 심사는 별도 계정에 retro 카드·승인 샘플 공유를 사전 지급. 현장 위치 획득 우회나 가짜 field 획득은 만들지 않음 | 대표 확정·획득 불변식 보호 |
| 2026-08-12 | 브랜드 표시명은 `다녀담_다녀온 곳을 담다`, 영문 브랜드는 `DANYEODAM` | 대표 확정 |
| 2026-08-12 | API-CONTRACT v0.3: 다국어 조회·전체 삭제·UGC 안전·남용 방지·심사 fixture를 제출 준비 기준선으로 확정 | 스토어 제출 개발 기준 |
| 2026-08-12 | API-CONTRACT v0.3.1: 이메일 연결은 S256 PKCE와 서버 고정 callback으로 한정하고, reviewer 권한은 현재 DB membership projection으로 판정 | 인증 비밀값 최소화·JWT metadata 권한 오용 방지 |
| 2026-08-12 | API-CONTRACT v0.3.2: 사진 업로드 전 정책 동의, 발행 문서 불변성, 인증 사용자 서버 차단, 카드 독립 정지 해제, reviewer redaction 표식을 확정 | App Store·Play UGC 안전·계정삭제 호환 경계 |
| 2026-08-12 | API-CONTRACT v0.3.3: current 정책 전환·동의를 동일 lock protocol로 직렬화하고 blocker 단위 차단 제한과 서명 cursor 목록을 확정 | 정책 동의 경합·차단 rate 우회·목록 truncation 제거 |
| 2026-08-12 | API-CONTRACT v0.3.4: pending 제출과 공개 발행 kill switch를 분리하고 legacy slug 전량 회전, 발행 폐쇄 시 active surface 404, 정지·신규 제출 직렬화를 확정 | 독립 감사 P0: 배포 전 공개 차단·raw secret 재사용·정지 경합 제거 |
| 2026-08-12 | API-CONTRACT v0.3.5: 정책 소비 전 경계의 shared current-set lock, 날짜 없는 신고 HMAC, 정지·신고 owner lock 직렬화를 확정 | 독립 감사 P1: policy TOCTOU·자정 rate 우회·정지 소유자 신고 제거 |
| 2026-08-12 | API-CONTRACT v0.3.6: 현재·과거 reviewer의 복구 issue/claim·이메일 연결을 영구 금지하고, 철회 시 권한·바인딩·복구코드·공유를 즉시 닫음 | 재사용 심사 계정을 일반 사용자 이전 경로에서 분리 |
| 2026-08-12 | API-CONTRACT v0.3.7: reviewer 지정·recovery claim·Auth 변경을 공통 lock protocol로 직렬화하고 exact email-only credential, Auth identity/MFA·passkey guard, 비식별 cutover, 재활성화 금지, rewrap 전 철회·staging rehearsal·새 계정 canary를 확정 | claimant 경합·공개 Auth/자동 provider 우회·기존 invalid reviewer·credential 재사용 제거 |
| 2026-08-12 | API-CONTRACT v0.3.8: owner `/share#SECRET`, fixed public POST, web DOB self-attestation, 6 locale shell을 확정 | URL path/query raw secret 제거와 공개 웹 연령 경계 확정 |
| 2026-08-12 | API-CONTRACT v0.3.9: DB 최소연령·current 위치약관, 위치 이용 원장/권리행사/보유·2단계 삭제, field object ledger와 bearer-only adult 차단을 통합 | 원시 위치 최소화·철회/정정 완결성·native 인앱 차단 확보 |
| 2026-08-12 | API-CONTRACT v0.4.0: 익명 포함 계정삭제의 즉시 접근·공유 철회, Storage 2-pass→DB→Auth→30일 영수증, 공개 삭제 웹, 관리자 inspection/retry, 계정삭제 1분 scheduler, 업로드 rate·card/storage quota를 확정 | App Store·Play 삭제 의무와 24시간 운영 목표를 실제 state machine·용량 경계로 구현 |
| 2026-08-12 | 서울 첫 6개 현장검증 후보를 LoL PARK 인근 외부 인증지점(청진공원), 광화문광장, DDP·동대문역사문화공원, 홍대 레드로드 R1, 석촌호수공원, 올림픽공원으로 확정. 운영 좌표·반경은 iOS·Android 현장시험 통과 후만 승인 | 공식 관광 수요, 무료 야외 공개 접근, GPS 분리 가능성의 균형. 북촌·유료/실내 의존 후보 제외 |
| 2026-08-12 | production 개발자 표시명·지원 이메일·주/예비 운영담당은 후보 빌드 전 대표에게 다시 확인하고, 그 전에는 placeholder를 출시 승인으로 간주하지 않음 | 현재 개발을 막지 않되 Store·정책·권리행사 연락처의 최종 일치를 보장 |
| 2026-08-12 | 정책·번역·spot·지원 운영은 전문 서브에이전트 병렬 감사와 통합 P0/P1 판정을 수행하되, 법률·원어민·권리·현장·운영의 사람 승인을 대체하지 않음 | AI 검수 범위와 외부 출시 승인 책임 분리 |
