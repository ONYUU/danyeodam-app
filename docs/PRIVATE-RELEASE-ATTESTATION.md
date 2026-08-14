# 비공개 출시 승인파일

production EAS 빌드는 `DANYEODAM_RELEASE_APPROVAL_FILE`로 전달된 외부 JSON 파일을 요구한다.
이 파일은 EAS의 비공개 file Secret 등으로 주입하고 공개 저장소 안에 두지 않는다.

```json
{
  "schemaVersion": 2,
  "status": "approved",
  "sourceCommitSha": "0000000000000000000000000000000000000000",
  "approvedAt": "2026-08-15T00:00:00Z",
  "approvedBy": "release-owner",
  "expectedServerBonusPackIssuanceScope": "off",
  "mobilePublicConfigSha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "evidence": {
    "cardAssetRightsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "seoulFieldApprovalSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "storePacketPrebuildSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

위 0 값은 형식 설명용 placeholder로 실제 gate에서 거부된다.

실제 파일은 다음 조건을 모두 충족해야 한다.

- 실제 EAS build의 `production` 프로필이며 `APP_ENV=production`이다.
- 공개 checkout 밖의 절대경로에 있는 일반 파일이며 symlink가 아니다.
- POSIX 환경에서 소유자만 읽고 쓸 수 있다.
- `sourceCommitSha`가 `EAS_BUILD_GIT_COMMIT_HASH`와 정확히 일치한다.
- `mobilePublicConfigSha256`가 현재 EAS production 공개 설정을 아래 규칙으로
  정규화해 계산한 SHA-256와 정확히 일치한다.
- `expectedServerBonusPackIssuanceScope`는 `off`, `participants`, `public` 중 승인자가
  의도한 서버 rollout 범위다. 이 값은 EAS 환경변수나 모바일 번들에
  주입하지 않는다.
- 세 증빙 해시는 비공개 승인 산출물의 실제 SHA-256이며, 0 해시나 서로 같은 해시는 허용하지 않는다.
- 허용되지 않은 추가 필드가 없고 상태가 `approved`다.

## 모바일 공개 설정 해시

해시 입력은 다음 값을 이 순서의 JSON으로 정규화한 UTF-8 바이트다.

1. `schemaVersion` (`1`)
2. 정규화된 production API base URL
3. 정규화된 production Supabase URL
4. Supabase publishable key 원문의 SHA-256 fingerprint
5. 사전순으로 정렬한 policy/support exact-origin 목록
6. `apps/mobile/package.json`의 앱 버전
7. 정확한 source Git SHA
8. `expectedServerBonusPackIssuanceScope`

원문 publishable key는 승인파일에 저장하지 않고 fingerprint만 정규화 데이터에
포함한다. 정확한 규칙은
`apps/mobile/scripts/lib/mobile-public-config-attestation.cjs`가 단일 구현이다.
운영 공개 환경변수를 주입한 후 다음 명령으로 digest만 출력할 수 있다.

```bash
cd apps/mobile
npm run --silent release:public-config-sha256 -- <exact-source-sha> <off|participants|public>
```

이 명령과 EAS gate는 공개 설정의 형식과 승인 digest 일치만 확인하며 네트워크
요청을 하지 않는다.

## 서버 rollout 대조 경계

`expectedServerBonusPackIssuanceScope`는 승인자의 기대값을 모바일 빌드 승인에 묶는다.
EAS는 Vercel의 실제 `BONUS_PACK_ISSUANCE_SCOPE`를 읽지 않으므로, 이 필드만으로
운영 서버 scope가 같다고 검증된 것은 아니다. 출시 직전에 승인파일의
기대값과 Vercel deployment env를 운영자가 별도로 대조해야 한다. Vercel 빌드
gate는 실제 서버 env의 필수값·형식·키 역할을 검증하지만, EAS 승인파일과의
운영 scope 동일성까지 증명하지는 않는다.

검증을 통과하면 빌드 SHA를 `EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA`로 후속 EAS 단계에 전달한다.
서버 scope나 `mobilePublicConfigSha256`는 앱 `extra`에 추가하지 않는다. 승인파일 부재·권한
오류·형식 오류·SHA 불일치·공개 설정 변조는 모두 production 빌드를 중단한다.
