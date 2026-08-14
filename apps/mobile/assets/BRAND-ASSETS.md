# 다녀담 브랜드 자산 기록

## 제작 이력

- 아이콘 모티프: 여행 카드, 이동 경로, 방문 도장
- 제작일: 2026-08-12
- 제작 방식: 다녀담 전용 프롬프트로 OpenAI 이미지 생성 도구에서 신규 생성
- 외부 입력 자산: 없음
- 제3자 상표·국기·문구·실재 랜드마크: 사용하지 않음

## 플랫폼별 처리

- `images/icon.png`: iOS용 1024×1024 RGB PNG, 투명도 없음
- `images/android-icon-foreground.png`: Android adaptive icon용 1024×1024 RGBA PNG. 생성 원본에서 배경을 분리하고 전체 모티프를 중앙 66/108 안전영역 안에 배치
- Android 배경: `app.config.ts`의 `#F8F4EA`
- `images/favicon.png`: 웹용 256×256 RGB PNG

Expo 스캐폴드의 background·monochrome placeholder는 사용하거나 배포하지 않습니다. Android themed monochrome 자산은 이번 출시 범위에 포함하지 않습니다.
