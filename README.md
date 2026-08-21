# 다녀담 (DANYEODAM)

> 다녀온 곳을 담다 — 걸어서 모으는 로컬카드 수집 서비스

걸어서 카드 스팟에 도달하면 그 장소의 디지털 카드를 모으는 수집형 여행 기록 서비스.
현재 목표는 Expo React Native 앱을 iOS App Store와 Google Play에 제출할 수 있는 상태로 완성하는 것이다. 서비스 현장은 대한민국이며 첫 출시는 현장 검증된 서울 6개 스팟으로 시작한다.

- 소비자 정책: 무료·무광고·무결제
- 앱 ID: `kr.danyeodam.app`
- 지원 언어: 한국어·영어·일본어·중국어 간체·중국어 번체·베트남어
- 브랜드 표시: `다녀담_다녀온 곳을 담다` / `DANYEODAM`

현재 방문 일반카드는 사용자·장소·한국 날짜 기준 하루 한 번 지급한다. 별도의 일일
보너스 팩(일반 80%, 특별 20%, 5번째까지 특별 보장)은 DB/API/앱에
구현되어 있으며, 특별 카드 자산·권리·현장·출시 승인 전에는 서버
`BONUS_PACK_ISSUANCE_SCOPE=off`로 신규 발급을 닫는다.

## 공개 저장소 보안 경계

이 저장소에는 소스 코드와 예시 설정만 둔다. 운영 비밀키, 앱 서명키, 스토어·심사 계정,
실사용자 데이터, 원시 위치좌표, 비공개 출시 증빙은 커밋하지 않는다. 로컬 설정은
`.env.example`을 복사해 사용하고 실제 값은 환경변수·배포 플랫폼 Secret·스토어 콘솔의
비공개 필드에서 관리한다. 공개 전 검사는
`node scripts/check-public-repo-safety.mjs`로 실행한다.

카드 원본·권리자료·현장 좌표·스토어 증빙은 공개 저장소에 포함하지 않는다. production
EAS 빌드는 [비공개 출시 승인파일](docs/PRIVATE-RELEASE-ATTESTATION.md)이 정확한 빌드
커밋과 일치해야 진행된다. 전체 경계는 [공개 저장소 구조](docs/PUBLIC-ARCHITECTURE.md)에
정리돼 있다.

Vercel preview·production 빌드는 `npm run build`의 첫 단계에서 실제 배포
환경변수를 검증한다. 필수 secret 누락, Supabase 키 역할 반전·동일키,
예시·예약·사설·문서용 URL이 있으면 Next 빌드 전에 중단한다. 로컬과 공개
CI는 `VERCEL_ENV=preview|production`이 아닐 때만 이 배포 검증을 건너뛴다.

보안 문제는 공개 Issue 대신 [보안 정책](SECURITY.md)의 비공개 신고 절차를 사용한다.
이 저장소에는 현재 별도의 오픈소스 라이선스가 부여되지 않았다.

## 보너스 팩 HTTP E2E 폐기형 스택 계약

`npm run api:test:bonus-pack`은 published pool·정책·카드·특별 Storage 객체를 합성
fixture로 만든다. 해당 감사 행은 설계상 삭제하지 않으므로 지속 사용하는 로컬 DB에서는
실행하지 않는다. API와 DB가 모두 563xx인 격리 스택에서만
`DANYEODAM_BONUS_PACK_E2E_ALLOW_DISPOSABLE=true`를 명시해 실행하며, 성공·실패와
관계없이 호출자가 반드시 `corepack npm run db:stop`으로 스택과 볼륨을 폐기한다.
553xx는 Jubilee Worship 보호를 위해 이 명령에서 항상 거부한다.

CI는 시작 전에 `npm run ci:remap-supabase-ports`로 여섯 개 서비스 포트와 shadow
포트를 563xx로 바꾼다. 이 remap 명령은 fresh checkout 전용이며, 예상 config가
조금이라도 다르면 실패한다. workflow의 `if: always()` 종료 단계는 제거하지 않는다.

## 문서

| 문서 | 내용 | 소유 |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | 개발 공유 컨텍스트 (동일 내용 유지) | Codex·TRUST |
| `API-CONTRACT.md` | API 계약 — 단일 기준 | Codex 검토 + TRUST 승인 |
| `docs/SCHEMA.md` | DB 스키마 명세 | Codex |
| `docs/DECISIONS.md` | 결정 로그 | TRUST |
| 기획서 v0.8 (외부) | 배경 기획서 | TRUST |

## 스택

Expo React Native(모바일) / Next.js(App Router) + Vercel(API·공개 웹·운영) / Supabase(Postgres·Auth·Storage)

## 규칙 요약

- 브랜치 작업과 PR 리뷰를 거치며 main 직접 푸시는 금지
- 커밋: `feat:` `fix:` `docs:` `chore:` 프리픽스
- 공개 모집 배포는 feature flag `PUBLIC_RECRUIT_GATE`로 차단 (위치정보법 검토 완료 전 개방 금지)
- 공개 사진 공유 생성은 UGC 정책·검수·신고·차단·삭제가 준비될 때까지 `PUBLIC_SHARE_CREATION=false`
