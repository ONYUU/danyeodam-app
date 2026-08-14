# 다녀담 모바일 앱

App Store와 Google Play 제출을 목표로 하는 Expo React Native 앱입니다. 앱 식별자, 권한 정책, 6개 언어, 기본 내비게이션, 암호화 세션 저장, 익명 시작, 이메일 확인 딥링크와 스토어 심사자 로그인 경계를 포함합니다.

## 기준 버전

- Node.js `24.19.0`
- Expo SDK `~57.0.13`
- React Native `0.86.2`
- React `19.2.3`
- TypeScript `~6.0.3`
- EAS CLI `21.8.0`

앱 식별자는 iOS와 Android 모두 `kr.danyeodam.app`, 딥링크 scheme은 `danyeodam`입니다.

## 로컬 실행

```bash
cd apps/mobile
cp .env.example .env.local
npm ci
npm run ios
```

Android는 `npm run android`, 웹 셸은 `npm run web`을 사용합니다. 환경 변수 이름이 `EXPO_PUBLIC_`로 시작하면 앱 번들에 포함되므로 비밀키를 넣으면 안 됩니다.

## 검증

```bash
npm run check
npm run config:assert:production
npm run export:production:verify
```

첫 명령은 TypeScript, ESLint, Vitest, Expo Doctor를 순서대로 실행합니다. 두 번째
명령은 실제 prebuild 결과에서 네이티브 권한·전송 보안·iOS 6개 언어 권한 문구를
검증하고, 세 번째 명령은 CI용 임시 production iOS·Android·Web 번들을 만든 뒤
삭제합니다. `export:production:verify`는 코드 검증용이며 출시 산출물이 아닙니다.
이 임시 export는 EAS pre-install이 전달하는 build source commit이 iOS·Android·Web
bundle 각각에 실제로 포함되는지도 확인합니다.
이 디렉터리는 독립 `package-lock.json`과 전용 Mobile CI를 사용하며 루트 Next.js
검증 범위에서는 제외됩니다.

## production 후보 빌드

다음 명령은 공개 소스의 코드·모바일 설정을 검증하고 production EAS 빌드를 요청합니다.

```bash
npm run release:preflight
npm run release:build
```

`release:preflight`는 공개 저장소 보안검사와 웹·API·모바일 테스트, 타입검사, 린트,
production 설정을 확인합니다. 이 성공은 카드 권리, 서울 현장검증, 번역, 심사계정,
스토어 선언 또는 서명 산출물의 승인을 의미하지 않습니다.

`release:build`의 EAS production 단계는 저장소 밖에서 주입한
`DANYEODAM_RELEASE_APPROVAL_FILE`을 추가로 검사합니다. 승인파일은 정확한 빌드 Git SHA와
비공개 카드 권리·현장·스토어 사전검증 산출물의 SHA-256을 포함해야 하며, 누락·불일치 시
빌드를 중단합니다. 형식과 보안 경계는
[`docs/PRIVATE-RELEASE-ATTESTATION.md`](../../docs/PRIVATE-RELEASE-ATTESTATION.md)에 정리돼
있습니다. 서명 IPA/AAB와 심볼의 최종 검사는 비공개 출시 파이프라인에서 수행하며,
해당 자료와 도구는 이 공개 저장소에 포함하지 않습니다.

GitHub Actions의 `Public code release preflight` 수동 실행도 공개 코드만 검증합니다.
따라서 그 workflow의 성공을 스토어 제출 승인으로 사용하면 안 됩니다.

## 빌드 프로필

`eas.json`은 `development`, `e2e`, `preview`, `production` 네 프로필만 정의합니다. 제출 설정과 실제 자격 증명은 포함하지 않습니다.

- 개발 및 E2E는 로컬 API 기본값을 사용할 수 있습니다.
- preview와 production은 공개 HTTPS `EXPO_PUBLIC_API_BASE_URL`과 `EXPO_PUBLIC_SUPABASE_URL`, Supabase publishable key, 쉼표로 구분한 exact-origin `EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS`가 없으면 설정 단계에서 실패합니다. localhost·사설 IP·query·fragment를 거부하고 `sb_secret_`·service-role key를 앱에 포함하지 못하게 차단합니다.
- EAS CLI, Node, npm은 각각 `21.8.0`, `24.19.0`, `11.16.0`으로 고정합니다. 각 프로필은 Corepack을 사용하고 커밋되지 않은 소스로 빌드하지 않습니다.
- EAS 프로젝트 연결, Apple Team, Android signing, 운영 API 도메인은 후속 보안 설정에서 주입해야 합니다.

## 권한 원칙

- 위치: 사용자가 카드 획득을 시도할 때의 foreground 위치만 허용
- 사진: 권한 요청 없는 시스템 사진 선택기로 정지 이미지 1장만 선택
- 차단: 카메라, 동영상, 마이크, 백그라운드 위치, 동작 인식, Android 광범위 미디어 접근
- 전송: preview·production에서 iOS ATS 임의 로드와 Android cleartext를 차단

앱 코드에서 카메라 촬영이나 백그라운드 위치 API를 추가하면 안 됩니다. 원시 위치 좌표도 로컬 분석 로그나 서버 기록으로 남기면 안 됩니다.

## 인증·세션 경계

- 앱은 인증 모듈을 불러오기 전에 중립적인 생년월일 입력 화면에서 18plus-v1 정책을 달력 단위로 판정합니다. 기준 나이는 화면에 힌트로 표시하지 않으며, 입력한 생년월일·연도·계산 나이는 React 메모리에서 판정 직후 제거하고 저장·전송·로그에 남기지 않습니다.
- native 기기에는 WHEN_UNLOCKED_THIS_DEVICE_ONLY SecureStore로 두 필드의 통과 여부와 정책 버전만 저장합니다. 정책 버전이 달라지거나 레코드에 필드가 추가되면 해당 레코드를 폐기하고 입력 화면을 다시 표시합니다. 웹 번들은 이 값을 영구 저장하지 않습니다.
- 로컬 확인이 끝나기 전에는 일반 `AuthProvider`를 import/mount하지 않습니다. 다만 연령 미확인·이용불가 상태에서도 개인정보 권리를 행사할 수 있도록, 사용자가 명시적으로 권리센터를 열면 저장된 기존 세션만 읽는 제한 provider를 lazy-load합니다. 이 경로는 새 익명 세션을 만들거나 일반 서비스 API를 열지 않습니다.
- 로컬 확인 후에만 익명 세션을 준비하고 `/api/me/minimum-age-attestation`에 같은 두 필드만 POST하며, 서버 성공 전에는 Expo Router Stack을 열지 않습니다. 401 또는 네트워크 오류에서는 일반 앱 내용을 닫은 상태로 명시적인 재시도와 제한된 권리센터만 제공합니다.
- 현장 획득은 서버의 current location consent가 active인지 먼저 확인합니다. 누락·구버전·일시중지·철회 처리 중이면 기기 위치 권한 요청과 위치 읽기를 시작하지 않으며, 설정의 별도 약관 동의·재개 또는 권리센터로 안내합니다.
- 일반 사용자는 Supabase 익명 세션으로 시작합니다.
- native에서 세션은 iOS Keychain·Android Keystore 기반 `expo-secure-store`에 UTF-8 청크로 나누어 저장합니다. 세션을 로그에 기록하지 않습니다.
- 이메일 연결을 시작할 때 `expo-crypto`의 native CSPRNG와 SHA-256으로 flow별 S256 PKCE를 만듭니다. verifier·원래 Auth 사용자 ID·생성 시각만 SecureStore에 최대 65분 보관하고, 서버에는 challenge와 소문자 UUID v4 flow ID만 전송합니다.
- 이메일 확인 반환 경로는 `danyeodam://auth/callback`으로 고정합니다. 앱은 같은 기기의 일회용 verifier와 일치하는 `code`·`sb_flow_id`만 Supabase Auth에 직접 교환하고, 응답 Auth 사용자 ID가 요청을 시작한 사용자와 같을 때만 세션을 채택합니다. 다른 scheme·host·path, 알 수 없는 query, 중복 처리, implicit access/refresh token fragment는 거부합니다.
- 스토어 심사자는 `danyeodam://reviewer-login`으로만 진입합니다. 이메일·비밀번호 세션 생성 후 서버의 `/api/me/access` 결과가 `store_reviewer`가 아니면 로컬 세션을 즉시 제거합니다.
- 심사 계정도 현장 `field` 위치 판정을 우회하지 않습니다. 심사 픽스처는 서버가 지급한 `retro`로만 구성합니다.
- 공통 API 클라이언트는 보호 요청에만 Bearer 세션을 첨부하고 10초 타임아웃을 적용합니다. 서버가 401을 반환하면 철회된 바인딩으로 보고 로컬 세션을 즉시 제거하며, 토큰·요청 본문·서버 진단 문구를 오류 객체에 보관하지 않습니다.

## 공개 공유 차단 경계

- 공개 공유 소유자 차단은 정확한 `danyeodam://share-block#<share_secret>` 형식만 받습니다. query·path·universal link로 비밀값을 받지 않으며, fragment를 메모리 금고로 한 번 옮긴 뒤 비밀값이 없는 내부 경로로 즉시 `replace`합니다.
- share secret은 query, navigation params, SecureStore, local/session storage, 로그, 분석에 기록하지 않습니다. 차단 요청은 성인 서버 attestation을 통과한 Stack 내에서 Bearer만 보내고, 공통 전송 계층은 ambient cookie를 `credentials: "omit"`으로 차단합니다.
- 네트워크·5xx·429 결과에서는 사용자가 명시적으로 재시도할 때만 같은 `client_action_id`를 재사용합니다. 자동 재시도나 새 ID를 사용한 맹목적 재전송은 하지 않습니다.
- 설정의 차단 목록은 서버가 제공한 opaque 차단 ID·생성일만 표시하고, 서명 cursor keyset pagination을 그대로 사용합니다. 차단 해제도 같은 논리적 재시도에서 동일한 `client_action_id`를 보존합니다.

## 언어 상태

앱 UI와 iOS foreground 위치 권한 문구는 `ko`, `en`, `ja`, `zh-Hans`, `zh-Hant`, `vi`를 제공합니다. 지원하지 않는 기기 언어는 영어로 대체합니다. 설정에서 선택한 언어는 native SecureStore와 웹 localStorage에 지원 locale 식별자만 저장하고 재실행 시 복원합니다.

## 정책 및 고객지원 허브

- 연령 확인·익명 세션·reviewer 로그인·계정 상태보다 바깥의 public boundary에서
  `/api/policies/current`를 인증 없이 호출하므로 시작 화면과 설정에서 항상 접근할 수
  있습니다. 설정의 개인정보처리방침 버튼은 추가 메뉴 없이 현재 문서 검증과 열기를
  한 번에 시작합니다.
- API는 정책 4종의 6개 locale별 `url`·`sha256`·버전·시행일과
  `PUBLIC_SUPPORT_URL`을 함께 반환합니다. 앱은 production 빌드에 고정된
  `EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS`와 URL origin을 정확히 비교하고 HTTPS,
  credential/hash 부재, 2xx, 무리디렉션, 최종 URL 동일을 확인합니다.
  `credentials: "omit"`과 10초 단일 deadline을 적용하고, 응답 body를 스트리밍하며
  2MiB를 넘는 즉시 취소합니다. 정책은 다운로드한 바이트의 SHA-256을 대조한
  뒤 재요청하지 않고 검증된 동일 바이트를 앱 내 텍스트 뷰어에 표시합니다.
  지원 URL도 동일한 origin·무리디렉션·스트리밍 상한을 통과한 한 번의
  응답 내용만 앱 안에 표시합니다.
- 정상 응답은 공개 문서 메타데이터만 로컬에 저장합니다. 서버가 일시적으로
  unavailable이면 저장된 목록임을 명시하고 새로고침을 제공하며, 실제 문서를 열 때는
  다시 원격 응답과 hash를 검증하므로 오프라인에서 검증되지 않은 링크를 열지 않습니다.
- 실제 운영 URL 값과 문서 바이트는 저장소에 넣지 않습니다. production 배포 전에
  서버 `PUBLIC_SUPPORT_URL`, 앱 `EXPO_PUBLIC_POLICY_ALLOWED_ORIGINS`, DB의 4종×6개
  문서 URL·SHA-256을 동일한 공개 HTTPS 호스트 구성으로 주입하고 canary를 수행해야
  합니다.

공식 제출 근거는 Apple의 [App privacy](https://developer.apple.com/help/app-store-connect/reference/app-information/app-privacy/)와 [Support URL](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information), Google Play의 [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)를 따른다. Google Play용 개인정보처리방침 URL은 공개·비지역제한·비편집 HTML 페이지여야 하며 PDF를 사용하지 않는다.

## 의존성 보안 추적

2026-08-15 기준 고정 lockfile에 대해 `npm audit --omit=dev`는 Expo Metro 빌드 툴체인의
전이 의존성 `image-size` 1.2.1에서 high 14건을 보고합니다. 현재 발행된
`image-size` 2.0.2까지도 해당 ICNS/JXL/HEIF 무한 루프 권고의 수정 버전이 없습니다.
이 패키지는 배포된 앱 런타임이 아니라 Metro가 저장소의 신뢰된 정적 자산을 빌드할 때만
사용합니다. 외부 업로드 파일을 Metro에 전달하지 않으며, 권리 승인된 고정 자산만 빌드합니다.
따라서 upstream 수정 버전이 나올 때까지 빌드 범위 위험으로 기록하되, 신뢰되지 않은
이미지가 빌드 입력으로 연결되면 즉시 출시 차단 항목으로 승격합니다.

`xcode` 빌드 의존성이 가져오던 취약한 `uuid` 7.0.3은 npm override로 호환되는
11.1.1로 상향했습니다. 해당 경로는 Expo native config/prebuild를 다시 검증합니다.

- 매 Expo SDK 57 패치 릴리스와 월 1회 정기 점검 시 `npm audit --omit=dev` 및 Expo Doctor를 재실행합니다.
- 호환되는 upstream 패치가 나오면 lockfile을 갱신하고 전체 native config·export 검증을 다시 수행합니다.
- critical 취약점 또는 앱 런타임에 직접 도달 가능한 취약점이 확인되면 제출 차단 항목으로 승격합니다.

## 제출 전 남은 외부 설정

- 운영/스테이징 도메인 확정 및 universal/app links 연결
- 운영 지원 URL, 정책 문서 origin allowlist, 4종×6개 문서 URL·SHA-256 연결
- EAS 프로젝트 ID와 스토어 서명 자격 증명 연결
- 스플래시·스토어 스크린샷 제작
- 영어·일본어·중국어 간체·중국어 번체·베트남어 원어민 검수

앱 아이콘·Android adaptive icon·웹 favicon은 다녀담의 여행 카드·경로·방문 도장 모티프로 교체했습니다. Android 전경은 투명 레이어와 66/108 안전영역을 적용했습니다. 별도 themed monochrome icon은 제공하지 않으며, 지원 운영체제의 자동 테마 처리는 시스템 정책을 따릅니다. 자산 제작 이력은 `assets/BRAND-ASSETS.md`에 기록합니다.
