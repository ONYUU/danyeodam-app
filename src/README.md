# src 구조 (예정)

- `app/` — Next.js App Router (Claude)
  - `(web)/` 랜딩·스팟·카드·컬렉션 화면
  - `api/` Route Handlers (acquire 등은 Codex와 계약 기준 협업)
  - `admin/` 운영 어드민 (Claude UI + Codex 데이터)
- `lib/` — 공용 유틸 (supabase 클라이언트, 이벤트 트래커)
- `i18n/` — next-intl 딕셔너리 (ko/en)
