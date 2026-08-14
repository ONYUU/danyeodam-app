import type { SupportedLocale } from '@/i18n/locales';

export type PolicySupportCopy = {
  body: string;
  cachedNotice: string;
  communityGuidelines: string;
  currentNotice: string;
  effectiveAt: string;
  entry: string;
  loadError: string;
  locationTerms: string;
  open: string;
  openError: string;
  opening: string;
  privacyPolicy: string;
  settingsBody: string;
  settingsTitle: string;
  support: string;
  supportBody: string;
  termsOfUse: string;
  title: string;
  verificationBody: string;
};

const copy: Record<SupportedLocale, PolicySupportCopy> = {
  en: {
    body: 'Review the four current policy documents or contact support without signing in.',
    cachedNotice: 'The server is unavailable. This saved manifest may be older; reconnect and refresh to confirm the current versions.',
    communityGuidelines: 'Community Guidelines',
    currentNotice: 'These versions were confirmed by the server for the selected language.',
    effectiveAt: 'Effective',
    entry: 'Policies and support',
    loadError: 'Current policies and support could not be loaded. No unverified link was opened.',
    locationTerms: 'Location Terms',
    open: 'Verify and view',
    openError: 'The exact URL, origin, response, or SHA-256 could not be verified. Nothing was displayed.',
    opening: 'Loading the exact document safely…',
    privacyPolicy: 'Privacy Policy',
    settingsBody: 'Open the current privacy policy directly, or review every policy and support option.',
    settingsTitle: 'Policies and support',
    support: 'Support',
    supportBody: 'View public support in the app from the same verified HTTPS response.',
    termsOfUse: 'Terms of Use',
    title: 'Policies and support',
    verificationBody: 'The app blocks redirects, matches downloaded bytes to the server SHA-256, and displays those same verified bytes in the app.',
  },
  ko: {
    body: '로그인하지 않아도 현재 정책 문서 4종을 확인하거나 지원 채널을 이용할 수 있습니다.',
    cachedNotice: '서버에 연결할 수 없어 저장된 목록을 표시합니다. 이전 버전일 수 있으므로 연결 후 새로고침하여 현재 버전을 확인하세요.',
    communityGuidelines: '커뮤니티 가이드라인',
    currentNotice: '선택한 언어의 현재 버전을 서버에서 확인했습니다.',
    effectiveAt: '시행일',
    entry: '정책 및 고객지원',
    loadError: '현재 정책과 지원 정보를 불러오지 못했습니다. 검증되지 않은 링크는 열지 않았습니다.',
    locationTerms: '위치정보 이용약관',
    open: '검증된 내용 보기',
    openError: '정확한 URL·출처·응답 또는 SHA-256을 검증하지 못했습니다. 아무 내용도 표시하지 않았습니다.',
    opening: '정확한 문서를 안전하게 불러오는 중…',
    privacyPolicy: '개인정보처리방침',
    settingsBody: '현재 개인정보처리방침을 바로 열거나 모든 정책과 지원 정보를 확인합니다.',
    settingsTitle: '정책 및 고객지원',
    support: '고객지원',
    supportBody: '검증한 동일한 HTTPS 응답의 고객지원 내용을 앱 안에서 표시합니다.',
    termsOfUse: '이용약관',
    title: '정책 및 고객지원',
    verificationBody: '리디렉션을 차단하고 다운로드한 바이트를 서버 SHA-256과 대조한 뒤, 검증한 동일 바이트를 앱 안에서 표시합니다.',
  },
  ja: {
    body: 'ログインせずに、現在の4つのポリシー文書を確認したり、サポートに連絡したりできます。',
    cachedNotice: 'サーバーに接続できないため保存済みの一覧を表示しています。古い可能性があるため、再接続後に更新して現行版を確認してください。',
    communityGuidelines: 'コミュニティガイドライン',
    currentNotice: '選択した言語の現行版をサーバーで確認しました。',
    effectiveAt: '発効日',
    entry: 'ポリシーとサポート',
    loadError: '現在のポリシーとサポート情報を読み込めませんでした。未検証のリンクは開いていません。',
    locationTerms: '位置情報利用規約',
    open: '検証済みの内容を見る',
    openError: '正確なURL、送信元、応答、またはSHA-256を検証できませんでした。内容は表示されていません。',
    opening: '正確な文書を安全に読み込み中…',
    privacyPolicy: 'プライバシーポリシー',
    settingsBody: '現在のプライバシーポリシーを直接開くか、すべてのポリシーとサポートを確認します。',
    settingsTitle: 'ポリシーとサポート',
    support: 'サポート',
    supportBody: '検証済みの同一HTTPS応答から公開サポート内容をアプリ内に表示します。',
    termsOfUse: '利用規約',
    title: 'ポリシーとサポート',
    verificationBody: 'リダイレクトを拒否し、取得バイトとサーバーのSHA-256を照合した後、同じ検証済みバイトをアプリ内に表示します。',
  },
  'zh-Hans': {
    body: '无需登录即可查看四份现行政策文档或联系支持。',
    cachedNotice: '服务器当前不可用，现显示已保存的清单。该清单可能较旧，请联网后刷新并确认现行版本。',
    communityGuidelines: '社区准则',
    currentNotice: '服务器已确认所选语言的现行版本。',
    effectiveAt: '生效日期',
    entry: '政策与支持',
    loadError: '无法加载现行政策与支持信息。未打开任何未经验证的链接。',
    locationTerms: '位置服务条款',
    open: '查看已验证内容',
    openError: '无法验证准确 URL、来源、响应或 SHA-256。未显示任何内容。',
    opening: '正在安全加载准确文档…',
    privacyPolicy: '隐私政策',
    settingsBody: '直接打开现行隐私政策，或查看全部政策与支持选项。',
    settingsTitle: '政策与支持',
    support: '客户支持',
    supportBody: '在应用内显示来自同一已验证 HTTPS 响应的公开支持内容。',
    termsOfUse: '使用条款',
    title: '政策与支持',
    verificationBody: '应用会阻止重定向，将下载字节与服务器 SHA-256 进行匹配，并在应用内显示同一份已验证字节。',
  },
  'zh-Hant': {
    body: '無需登入即可查看四份現行政策文件或聯絡支援。',
    cachedNotice: '目前無法連線至伺服器，現顯示已儲存的清單。此清單可能較舊，請連線後重新整理並確認現行版本。',
    communityGuidelines: '社群準則',
    currentNotice: '伺服器已確認所選語言的現行版本。',
    effectiveAt: '生效日期',
    entry: '政策與支援',
    loadError: '無法載入現行政策與支援資訊。未開啟任何未經驗證的連結。',
    locationTerms: '位置服務條款',
    open: '查看已驗證內容',
    openError: '無法驗證正確 URL、來源、回應或 SHA-256。未顯示任何內容。',
    opening: '正在安全載入正確文件…',
    privacyPolicy: '隱私權政策',
    settingsBody: '直接開啟現行隱私權政策，或查看所有政策與支援選項。',
    settingsTitle: '政策與支援',
    support: '客戶支援',
    supportBody: '在應用程式內顯示來自同一個已驗證 HTTPS 回應的公開支援內容。',
    termsOfUse: '使用條款',
    title: '政策與支援',
    verificationBody: '應用程式會阻擋重新導向，將下載位元組與伺服器 SHA-256 比對，並在應用程式內顯示同一份已驗證位元組。',
  },
  vi: {
    body: 'Xem bốn tài liệu chính sách hiện hành hoặc liên hệ hỗ trợ mà không cần đăng nhập.',
    cachedNotice: 'Không thể kết nối máy chủ nên ứng dụng đang hiển thị danh sách đã lưu. Danh sách có thể cũ; hãy kết nối lại và làm mới để xác nhận phiên bản hiện hành.',
    communityGuidelines: 'Nguyên tắc cộng đồng',
    currentNotice: 'Máy chủ đã xác nhận phiên bản hiện hành cho ngôn ngữ đã chọn.',
    effectiveAt: 'Có hiệu lực',
    entry: 'Chính sách và hỗ trợ',
    loadError: 'Không thể tải chính sách và thông tin hỗ trợ hiện hành. Không có liên kết chưa xác minh nào được mở.',
    locationTerms: 'Điều khoản vị trí',
    open: 'Xem nội dung đã xác minh',
    openError: 'Không thể xác minh chính xác URL, nguồn, phản hồi hoặc SHA-256. Không có nội dung nào được hiển thị.',
    opening: 'Đang tải an toàn đúng tài liệu…',
    privacyPolicy: 'Chính sách quyền riêng tư',
    settingsBody: 'Mở trực tiếp chính sách quyền riêng tư hiện hành hoặc xem mọi chính sách và tùy chọn hỗ trợ.',
    settingsTitle: 'Chính sách và hỗ trợ',
    support: 'Hỗ trợ',
    supportBody: 'Hiển thị trong ứng dụng nội dung hỗ trợ công khai từ cùng một phản hồi HTTPS đã xác minh.',
    termsOfUse: 'Điều khoản sử dụng',
    title: 'Chính sách và hỗ trợ',
    verificationBody: 'Ứng dụng chặn chuyển hướng, đối chiếu byte đã tải với SHA-256 từ máy chủ và hiển thị chính các byte đã xác minh đó trong ứng dụng.',
  },
};

export function policySupportCopy(locale: SupportedLocale): PolicySupportCopy {
  return copy[locale];
}
