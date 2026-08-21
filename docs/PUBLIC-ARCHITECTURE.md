# 공개 저장소 구조와 보안 경계

## 공개 범위

- Next.js API·공개 웹 소스
- Expo React Native 앱 소스와 공개 브랜드 아이콘
- Supabase 마이그레이션, 합성 seed, pgTAP·동시성·E2E 테스트
- 예시 환경변수 이름과 CI 설정

## 비공개 범위

- 운영 비밀키, 서명키, 프로비저닝 파일, 심사계정
- 실제 이용자 데이터와 원시 위치좌표
- 카드 원본·생성과정·권리 승인서
- 현장 좌표·반경·정확도·현장 검증 기록
- 스토어 제출 패킷, 서명 IPA/AAB, 내부 운영 런북

비공개 자료는 별도 접근통제 저장소와 배포 플랫폼 Secret에서 관리한다. 기존 비공개 Git
이력은 이 저장소에 복제하지 않으며, 공개 저장소는 검증된 단일 스냅샷에서 시작한다.
일일 보너스 팩의 신규 발급 scope와 사용자 귀속 pagination 서명키는 각각
`BONUS_PACK_ISSUANCE_SCOPE`·`BONUS_PACK_CURSOR_SECRET` 서버 환경변수로만 주입한다.
서버 preview·production 빌드는 `npm run env:assert:deployment`를 먼저 실행해
필수 cursor/HMAC secret, Supabase 공개·service key 역할, 운영 공개 URL을
검증한다. `.invalid`, `.example`, `.test`, `.localhost`, `example.com/net/org`,
사설·문서용 IP는 Vercel build 시작 단계에서 거부한다.
특별 카드의 승인 전 원본·참조 보드·권리자료는 공개 저장소에 두지 않는다.
승인 후 운영 자산도 공개 일반카드 endpoint와 분리하며, 앱 사용자는 active adult 인증과
실제 개봉 소유권을 다시 확인하는 `/api/me/special-card-assets/:cardId`로만 받는다. 특별
카드 원본은 일반카드용 public bucket과 분리한 전용 private `special-card-assets` bucket에만
보관하고, 서버는 Storage redirect를 따르지 않아 service credential 전달을 차단한다.

## 출시 경계

공개 CI 성공은 코드의 빌드 가능성과 테스트 통과만 의미한다. production EAS 빌드는
저장소 밖의 비공개 승인파일과 정확한 Git SHA·앱 버전·production API·Supabase·
publishable-key fingerprint·정렬된 정책 origin·승인자가 기대한 서버 보너스 scope의
통합 SHA-256가 일치할 때만 진행한다. 서버 scope 기대값은 모바일 번들에
주입하지 않는다. Vercel의 실제 scope와 세 공개 feature flag는 production
`GET /api/release-state` 응답의 deployment/project/Git SHA를 Vercel의 읽기 전용
deployment 조회와 교차 대조해 확인한다. 수기 JSON이나 project env 목록만으로는
이미 배포된 runtime 설정을 승인하지 않는다. 승인된 source SHA는 iOS Info.plist와
Android application manifest의 고정 native marker에도 기록하며, 서명 artifact 검사는
임의 asset 검색 대신 이 marker를 exact 비교한다.
Vercel의 자동 system environment 노출을 켜지 않아 deployment/project/Git 식별값이
없으면 release-state endpoint는 404로 fail closed한다.
정식 출시는 여기에
운영 백엔드, 권리·현장·번역·정책 승인, 정식 서명, 실제 기기, App Store·Google Play
콘솔 검증이 추가로 필요하다.

## iOS 개인정보 매니페스트 경계

앱의 `PrivacyInfo.xcprivacy`는 공개 코드와 현재 데이터 모델을 기준으로 다음을
선언한다. 이메일, 사진, 캡션 등 사용자 콘텐츠, 앱 범위 사용자 ID, 특정 POI와
사용자를 연결해 6개월 보관하는 위치 이용 원장, 카드 획득·보너스팩 진행 상태는
사용자에게 연결된 앱 기능 데이터다. 별도 `analytics.events`의 조회·관심·획득·공유
이벤트는 사용자 ID와 정확한 지원 장소를 함께 저장하므로 User ID·Precise Location과
Product Interaction에 Analytics 목적을 추가한다.
카드 획득과 보너스팩 저장 상태는 Product Interaction으로 뭉개지 않고 Apple의
Gameplay Content로 선언한다. 광고·제3자 추적은 구현하지 않으며 tracking과 tracking
domain은 비활성·빈 배열을 유지한다.

원시 위도·경도·정확도는 요청 처리 중 메모리에서만 검증하고 저장하지 않는다. 그러나
최종 위치 이용 원장은 계정과 정확한 지원 장소를 연결하므로 Precise Location 선언을
유지한다. 모바일이 사용하는 공개 계정 삭제 상태 조회는 신뢰한 프록시가 전달한 원본
IP를 저장하지 않고, scope별 HMAC 값만 속도 제한 원장에 최대 48시간 저장한다. 이 값은
계정·삭제요청과 조인되지 않으므로 `Device ID`, 사용자 연결 안 됨, App Functionality
(보안·부정사용 방지)로 선언한다. Vercel 등 처리자가 원본 IP를 별도 로그에 남기는지와
그 보존기간은 공개 코드만으로 확인할 수 없으므로 운영 설정 및 처리자 계약에서 출시 전
확인해야 한다. 이 분류는 Apple App Privacy 콘솔 문안, 개인정보처리방침, 서명 IPA의
SDK privacy report와 출시 전에 다시 일치시켜야 한다.

Required Reason API는 설치된 Expo SDK·React Native의 각 `PrivacyInfo.xcprivacy`를
근거로 UserDefaults, File Timestamp, Disk Space, System Boot Time의 승인 사유를 앱
매니페스트에도 합친다. `npm run config:assert:production`은 Expo config와 clean iOS
prebuild 결과의 수집 유형·목적·추적 여부·승인 사유 및 Xcode 리소스 포함 여부를
구조적으로 검증한다.

- Apple data collection: <https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests>
- Apple App Privacy details: <https://developer.apple.com/app-store/app-privacy-details/>
- Expo privacy manifests: <https://docs.expo.dev/guides/apple-privacy/>
