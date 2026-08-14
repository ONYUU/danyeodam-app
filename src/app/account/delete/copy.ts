export const deletionLocales = ["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"] as const;
export type DeletionLocale = (typeof deletionLocales)[number];

export function resolveDeletionLocale(language: string | undefined): DeletionLocale {
  const normalized = language?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("ko")) return "ko";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("zh-tw") || normalized.startsWith("zh-hant")) return "zh-Hant";
  if (normalized.startsWith("zh")) return "zh-Hans";
  if (normalized.startsWith("vi")) return "vi";
  return "en";
}

type DeletionCopy = {
  title: string;
  intro: string;
  developer: string;
  scope: string;
  deadline: string;
  emailLabel: string;
  emailAction: string;
  emailSent: string;
  authenticated: string;
  reviewerTitle: string;
  reviewerDescription: string;
  reviewerPasswordLabel: string;
  reviewerPasswordAction: string;
  reviewerSignInError: string;
  recoveryLabel: string;
  recoveryAction: string;
  confirm: string;
  deleteAction: string;
  pending: string;
  completed: string;
  actionRequired: string;
  support: string;
  unavailable: string;
  retry: string;
  genericError: string;
};

export const deletionCopy: Record<DeletionLocale, DeletionCopy> = {
  ko: {
    title: "다녀담 계정 및 데이터 삭제",
    intro: "앱을 설치하지 않아도 연결된 이메일 인증 링크, 심사 계정 이메일·비밀번호 또는 복구코드로 삭제를 요청할 수 있습니다.",
    developer: "개발자",
    scope: "계정, 방문·획득 기록, 개인카드·사진, 공유, 동의 및 관련 서비스 데이터를 삭제합니다. 법적 의무가 있는 최소 기록은 고지된 기간만 보관합니다.",
    deadline: "정상 상태에서는 요청 후 24시간 안에 완료합니다.",
    emailLabel: "연결된 이메일",
    emailAction: "인증 링크 받기",
    emailSent: "계정 존재 여부와 관계없이 인증 가능한 경우에만 이메일 링크가 발송됩니다.",
    authenticated: "이메일 인증이 확인되었습니다.",
    reviewerTitle: "스토어 심사 계정",
    reviewerDescription: "심사용 이메일과 비밀번호를 받은 경우 이 경로로 로그인하세요. 이메일 링크를 보내거나 계정을 만들지 않습니다.",
    reviewerPasswordLabel: "심사 계정 비밀번호",
    reviewerPasswordAction: "심사 계정으로 로그인",
    reviewerSignInError: "로그인할 수 없습니다. 입력 정보를 확인한 후 다시 시도해 주세요.",
    recoveryLabel: "익명 계정 복구코드",
    recoveryAction: "복구 없이 삭제 요청",
    confirm: "삭제 범위와 처리기간을 확인했으며 계정 및 데이터 삭제를 요청합니다.",
    deleteAction: "계정 및 데이터 삭제 요청",
    pending: "삭제가 처리 중입니다.",
    completed: "삭제가 완료되었습니다.",
    actionRequired: "처리가 지연되어 지원 확인이 필요합니다.",
    support: "지원 문의",
    unavailable: "삭제 요청 경로의 운영 설정이 완료되지 않았습니다.",
    retry: "상태 다시 확인",
    genericError: "요청을 처리하지 못했습니다. 저장된 요청 정보로 다시 시도해 주세요.",
  },
  en: {
    title: "Delete your DANYEODAM account and data",
    intro: "Without installing the app, request deletion using a linked-email sign-in link, reviewer email and password, or an anonymous recovery code.",
    developer: "Developer",
    scope: "We delete your account, visit and acquisition records, personal cards and photos, shares, consent records, and related service data. Only legally required minimal records are retained for the disclosed period.",
    deadline: "Under normal conditions, deletion is completed within 24 hours.",
    emailLabel: "Linked email",
    emailAction: "Send sign-in link",
    emailSent: "To avoid account discovery, a link is sent only when the email can be authenticated.",
    authenticated: "Email authentication confirmed.",
    reviewerTitle: "Store reviewer account",
    reviewerDescription: "If you received a reviewer email and password, sign in here. This does not send an email link or create an account.",
    reviewerPasswordLabel: "Reviewer account password",
    reviewerPasswordAction: "Sign in as a reviewer",
    reviewerSignInError: "Sign-in was unsuccessful. Check the entered information and try again.",
    recoveryLabel: "Anonymous account recovery code",
    recoveryAction: "Delete without recovery",
    confirm: "I understand the scope and processing period and request deletion of my account and data.",
    deleteAction: "Request account and data deletion",
    pending: "Deletion is in progress.",
    completed: "Deletion is complete.",
    actionRequired: "Processing is delayed and requires support review.",
    support: "Contact support",
    unavailable: "The deletion service configuration is not complete.",
    retry: "Check status again",
    genericError: "The request could not be completed. Retry with the saved request credential.",
  },
  ja: {
    title: "DANYEODAMのアカウントとデータを削除",
    intro: "アプリをインストールせず、連携メールの認証リンク、審査用メールアドレスとパスワード、または匿名復旧コードで削除を申請できます。",
    developer: "デベロッパー",
    scope: "アカウント、訪問・獲得履歴、個人カード・写真、共有、同意および関連サービスデータを削除します。法令上必要な最小記録のみ告知期間保管します。",
    deadline: "通常は申請後24時間以内に完了します。",
    emailLabel: "連携メール",
    emailAction: "認証リンクを受け取る",
    emailSent: "アカウントの有無を明らかにしないため、認証可能な場合のみリンクが送信されます。",
    authenticated: "メール認証を確認しました。",
    reviewerTitle: "ストア審査用アカウント",
    reviewerDescription: "審査用のメールアドレスとパスワードを受け取った場合は、ここからログインしてください。メールリンクの送信やアカウント作成は行いません。",
    reviewerPasswordLabel: "審査用アカウントのパスワード",
    reviewerPasswordAction: "審査用アカウントでログイン",
    reviewerSignInError: "ログインできません。入力内容を確認して、もう一度お試しください。",
    recoveryLabel: "匿名アカウント復旧コード",
    recoveryAction: "復旧せず削除を申請",
    confirm: "削除範囲と処理期間を確認し、アカウントとデータの削除を申請します。",
    deleteAction: "アカウントとデータの削除を申請",
    pending: "削除処理中です。",
    completed: "削除が完了しました。",
    actionRequired: "処理が遅延しており、サポート確認が必要です。",
    support: "サポートに連絡",
    unavailable: "削除申請サービスの設定が完了していません。",
    retry: "状態を再確認",
    genericError: "処理できませんでした。保存済みの申請情報で再試行してください。",
  },
  "zh-Hans": {
    title: "删除 DANYEODAM 账户和数据",
    intro: "无需安装应用，可通过关联邮箱验证链接、审核邮箱和密码或匿名恢复码申请删除。",
    developer: "开发者",
    scope: "我们会删除账户、访问和获取记录、个人卡片和照片、分享、同意记录及相关服务数据。仅在公示期限内保留法律要求的最少记录。",
    deadline: "正常情况下将在申请后24小时内完成。",
    emailLabel: "关联邮箱",
    emailAction: "发送验证链接",
    emailSent: "为防止探测账户，仅在邮箱可验证时发送链接。",
    authenticated: "邮箱验证已确认。",
    reviewerTitle: "应用商店审核账户",
    reviewerDescription: "如果您收到了审核邮箱和密码，请从此处登录。此操作不会发送邮箱链接或创建账户。",
    reviewerPasswordLabel: "审核账户密码",
    reviewerPasswordAction: "以审核账户登录",
    reviewerSignInError: "无法登录。请检查输入的信息后重试。",
    recoveryLabel: "匿名账户恢复码",
    recoveryAction: "不恢复并申请删除",
    confirm: "我已了解删除范围和处理期限，并申请删除账户和数据。",
    deleteAction: "申请删除账户和数据",
    pending: "删除正在处理中。",
    completed: "删除已完成。",
    actionRequired: "处理延迟，需要支持人员确认。",
    support: "联系支持",
    unavailable: "删除服务的运营配置尚未完成。",
    retry: "重新检查状态",
    genericError: "请求未能完成。请使用已保存的请求凭据重试。",
  },
  "zh-Hant": {
    title: "刪除 DANYEODAM 帳戶與資料",
    intro: "無需安裝應用程式，可透過連結信箱驗證連結、審核信箱與密碼或匿名復原碼申請刪除。",
    developer: "開發者",
    scope: "我們會刪除帳戶、造訪與取得紀錄、個人卡片與照片、分享、同意紀錄及相關服務資料。僅於公告期間保留法律要求的最少紀錄。",
    deadline: "正常情況下會在申請後24小時內完成。",
    emailLabel: "連結信箱",
    emailAction: "傳送驗證連結",
    emailSent: "為避免探測帳戶，僅在信箱可驗證時傳送連結。",
    authenticated: "已確認信箱驗證。",
    reviewerTitle: "應用程式商店審核帳戶",
    reviewerDescription: "如果您收到審核用信箱與密碼，請從此處登入。此操作不會傳送信箱連結或建立帳戶。",
    reviewerPasswordLabel: "審核帳戶密碼",
    reviewerPasswordAction: "以審核帳戶登入",
    reviewerSignInError: "無法登入。請檢查輸入的資訊後再試一次。",
    recoveryLabel: "匿名帳戶復原碼",
    recoveryAction: "不復原並申請刪除",
    confirm: "我已了解刪除範圍與處理期限，並申請刪除帳戶與資料。",
    deleteAction: "申請刪除帳戶與資料",
    pending: "刪除處理中。",
    completed: "刪除已完成。",
    actionRequired: "處理延遲，需要支援人員確認。",
    support: "聯絡支援",
    unavailable: "刪除服務的營運設定尚未完成。",
    retry: "重新檢查狀態",
    genericError: "要求未能完成。請使用已儲存的要求憑證重試。",
  },
  vi: {
    title: "Xóa tài khoản và dữ liệu DANYEODAM",
    intro: "Không cần cài ứng dụng, bạn có thể yêu cầu xóa bằng liên kết xác thực email đã liên kết, email và mật khẩu của người đánh giá hoặc mã khôi phục ẩn danh.",
    developer: "Nhà phát triển",
    scope: "Chúng tôi xóa tài khoản, lịch sử ghé thăm và nhận thẻ, thẻ và ảnh cá nhân, nội dung chia sẻ, bản ghi đồng ý và dữ liệu dịch vụ liên quan. Chỉ hồ sơ tối thiểu theo yêu cầu pháp luật được lưu trong thời hạn đã công bố.",
    deadline: "Trong điều kiện bình thường, việc xóa hoàn tất trong vòng 24 giờ.",
    emailLabel: "Email đã liên kết",
    emailAction: "Gửi liên kết xác thực",
    emailSent: "Để tránh dò tìm tài khoản, liên kết chỉ được gửi khi email có thể được xác thực.",
    authenticated: "Đã xác nhận email.",
    reviewerTitle: "Tài khoản đánh giá của cửa hàng ứng dụng",
    reviewerDescription: "Nếu bạn đã nhận được email và mật khẩu dành cho người đánh giá, hãy đăng nhập tại đây. Thao tác này không gửi liên kết email hoặc tạo tài khoản.",
    reviewerPasswordLabel: "Mật khẩu tài khoản đánh giá",
    reviewerPasswordAction: "Đăng nhập bằng tài khoản đánh giá",
    reviewerSignInError: "Không thể đăng nhập. Hãy kiểm tra thông tin đã nhập và thử lại.",
    recoveryLabel: "Mã khôi phục tài khoản ẩn danh",
    recoveryAction: "Yêu cầu xóa mà không khôi phục",
    confirm: "Tôi đã hiểu phạm vi và thời hạn xử lý và yêu cầu xóa tài khoản cùng dữ liệu.",
    deleteAction: "Yêu cầu xóa tài khoản và dữ liệu",
    pending: "Yêu cầu xóa đang được xử lý.",
    completed: "Đã hoàn tất việc xóa.",
    actionRequired: "Quá trình bị chậm và cần bộ phận hỗ trợ kiểm tra.",
    support: "Liên hệ hỗ trợ",
    unavailable: "Cấu hình vận hành dịch vụ xóa chưa hoàn tất.",
    retry: "Kiểm tra lại trạng thái",
    genericError: "Không thể xử lý yêu cầu. Hãy thử lại bằng thông tin yêu cầu đã lưu.",
  },
};
