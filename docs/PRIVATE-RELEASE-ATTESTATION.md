# 비공개 출시 승인파일

production EAS 빌드는 `DANYEODAM_RELEASE_APPROVAL_FILE`로 전달된 외부 JSON 파일을 요구한다.
이 파일은 EAS의 비공개 file Secret 등으로 주입하고 공개 저장소 안에 두지 않는다.

```json
{
  "schemaVersion": 1,
  "status": "approved",
  "sourceCommitSha": "0000000000000000000000000000000000000000",
  "approvedAt": "2026-08-15T00:00:00Z",
  "approvedBy": "release-owner",
  "evidence": {
    "cardAssetRightsSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "seoulFieldApprovalSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "storePacketPrebuildSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

실제 파일은 다음 조건을 모두 충족해야 한다.

- 공개 checkout 밖의 절대경로에 있는 일반 파일이며 symlink가 아니다.
- POSIX 환경에서 소유자만 읽고 쓸 수 있다.
- `sourceCommitSha`가 `EAS_BUILD_GIT_COMMIT_HASH`와 정확히 일치한다.
- 세 증빙 해시는 비공개 승인 산출물의 실제 SHA-256이다.
- 허용되지 않은 추가 필드가 없고 상태가 `approved`다.

검증을 통과하면 빌드 SHA를 `EXPO_PUBLIC_BUILD_SOURCE_COMMIT_SHA`로 후속 EAS 단계에 전달한다.
승인파일 부재·권한 오류·형식 오류·SHA 불일치는 모두 production 빌드를 중단한다.
