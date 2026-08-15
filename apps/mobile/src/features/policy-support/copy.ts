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
  overviewVerificationBody: string;
  policyVerificationBody: string;
  privacyPolicy: string;
  settingsBody: string;
  settingsTitle: string;
  support: string;
  supportBody: string;
  supportVerificationBody: string;
  termsOfUse: string;
  title: string;
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
    openError: 'The required URL, origin, response, or integrity check failed. Nothing was displayed.',
    opening: 'Loading the exact document safely…',
    overviewVerificationBody: 'The app blocks redirects and displays one response from the exact allowlisted HTTPS URL. Policy document bytes are also matched to the server SHA-256.',
    policyVerificationBody: 'The app blocks redirects, matches the response bytes to the server SHA-256, and displays content from that same response without requesting the URL again.',
    privacyPolicy: 'Privacy Policy',
    settingsBody: 'Open the current privacy policy directly, or review every policy and support option.',
    settingsTitle: 'Policies and support',
    support: 'Support',
    supportBody: 'View public support in the app from the same verified HTTPS response.',
    supportVerificationBody: 'The app blocks redirects, verifies the response came from the exact allowlisted HTTPS URL, and displays content from that same response without requesting it again. Support pages are not pinned by a content hash.',
    termsOfUse: 'Terms of Use',
    title: 'Policies and support',
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
    openError: '필요한 URL·출처·응답 또는 무결성 검증을 통과하지 못했습니다. 아무 내용도 표시하지 않았습니다.',
    opening: '정확한 문서를 안전하게 불러오는 중…',
    overviewVerificationBody: '리디렉션을 차단하고 허용된 정확한 HTTPS URL의 한 번의 응답만 앱 안에 표시합니다. 정책 문서 바이트는 서버 SHA-256과도 대조합니다.',
    policyVerificationBody: '리디렉션을 차단하고 응답 바이트를 서버 SHA-256과 대조한 뒤, URL을 다시 요청하지 않고 같은 응답의 내용을 표시합니다.',
    privacyPolicy: '개인정보처리방침',
    settingsBody: '현재 개인정보처리방침을 바로 열거나 모든 정책과 지원 정보를 확인합니다.',
    settingsTitle: '정책 및 고객지원',
    support: '고객지원',
    supportBody: '검증한 동일한 HTTPS 응답의 고객지원 내용을 앱 안에서 표시합니다.',
    supportVerificationBody: '리디렉션을 차단하고 허용된 정확한 HTTPS URL의 응답인지 확인한 뒤, URL을 다시 요청하지 않고 같은 응답의 내용을 표시합니다. 고객지원 페이지는 콘텐츠 해시 고정 대상이 아닙니다.',
    termsOfUse: '이용약관',
    title: '정책 및 고객지원',
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
    openError: '必要なURL、送信元、応答、または完全性の検証に失敗しました。内容は表示されていません。',
    opening: '正確な文書を安全に読み込み中…',
    overviewVerificationBody: 'リダイレクトを拒否し、許可済みの正確なHTTPS URLからの1回の応答だけをアプリ内に表示します。ポリシー文書のバイトはサーバーのSHA-256とも照合します。',
    policyVerificationBody: 'リダイレクトを拒否し、応答バイトをサーバーのSHA-256と照合した後、URLを再取得せず同じ応答の内容を表示します。',
    privacyPolicy: 'プライバシーポリシー',
    settingsBody: '現在のプライバシーポリシーを直接開くか、すべてのポリシーとサポートを確認します。',
    settingsTitle: 'ポリシーとサポート',
    support: 'サポート',
    supportBody: '検証済みの同一HTTPS応答から公開サポート内容をアプリ内に表示します。',
    supportVerificationBody: 'リダイレクトを拒否し、許可済みの正確なHTTPS URLからの応答であることを確認した後、URLを再取得せず同じ応答の内容を表示します。サポートページはコンテンツハッシュ固定の対象ではありません。',
    termsOfUse: '利用規約',
    title: 'ポリシーとサポート',
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
    openError: '未通过所需的 URL、来源、响应或完整性验证。未显示任何内容。',
    opening: '正在安全加载准确文档…',
    overviewVerificationBody: '应用会阻止重定向，并仅显示来自获准的准确 HTTPS URL 的一次响应。政策文档字节还会与服务器 SHA-256 进行匹配。',
    policyVerificationBody: '应用会阻止重定向，将响应字节与服务器 SHA-256 进行匹配，并在不再次请求 URL 的情况下显示同一响应的内容。',
    privacyPolicy: '隐私政策',
    settingsBody: '直接打开现行隐私政策，或查看全部政策与支持选项。',
    settingsTitle: '政策与支持',
    support: '客户支持',
    supportBody: '在应用内显示来自同一已验证 HTTPS 响应的公开支持内容。',
    supportVerificationBody: '应用会阻止重定向，确认响应来自获准的准确 HTTPS URL，并在不再次请求 URL 的情况下显示同一响应的内容。客户支持页面不固定到特定内容哈希。',
    termsOfUse: '使用条款',
    title: '政策与支持',
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
    openError: '未通過所需的 URL、來源、回應或完整性驗證。未顯示任何內容。',
    opening: '正在安全載入正確文件…',
    overviewVerificationBody: '應用程式會阻擋重新導向，並只顯示來自獲准的正確 HTTPS URL 的一次回應。政策文件位元組也會與伺服器 SHA-256 比對。',
    policyVerificationBody: '應用程式會阻擋重新導向，將回應位元組與伺服器 SHA-256 比對，並在不再次請求 URL 的情況下顯示同一回應的內容。',
    privacyPolicy: '隱私權政策',
    settingsBody: '直接開啟現行隱私權政策，或查看所有政策與支援選項。',
    settingsTitle: '政策與支援',
    support: '客戶支援',
    supportBody: '在應用程式內顯示來自同一個已驗證 HTTPS 回應的公開支援內容。',
    supportVerificationBody: '應用程式會阻擋重新導向，確認回應來自獲准的正確 HTTPS URL，並在不再次請求 URL 的情況下顯示同一回應的內容。客戶支援頁面不固定至特定內容雜湊。',
    termsOfUse: '使用條款',
    title: '政策與支援',
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
    openError: 'Không đạt yêu cầu xác minh URL, nguồn, phản hồi hoặc tính toàn vẹn. Không có nội dung nào được hiển thị.',
    opening: 'Đang tải an toàn đúng tài liệu…',
    overviewVerificationBody: 'Ứng dụng chặn chuyển hướng và chỉ hiển thị một phản hồi từ đúng URL HTTPS đã được cho phép. Byte của tài liệu chính sách cũng được đối chiếu với SHA-256 từ máy chủ.',
    policyVerificationBody: 'Ứng dụng chặn chuyển hướng, đối chiếu byte phản hồi với SHA-256 từ máy chủ và hiển thị nội dung của chính phản hồi đó mà không yêu cầu lại URL.',
    privacyPolicy: 'Chính sách quyền riêng tư',
    settingsBody: 'Mở trực tiếp chính sách quyền riêng tư hiện hành hoặc xem mọi chính sách và tùy chọn hỗ trợ.',
    settingsTitle: 'Chính sách và hỗ trợ',
    support: 'Hỗ trợ',
    supportBody: 'Hiển thị trong ứng dụng nội dung hỗ trợ công khai từ cùng một phản hồi HTTPS đã xác minh.',
    supportVerificationBody: 'Ứng dụng chặn chuyển hướng, xác nhận phản hồi đến từ đúng URL HTTPS đã được cho phép và hiển thị nội dung của chính phản hồi đó mà không yêu cầu lại URL. Trang hỗ trợ không được ghim vào một hàm băm nội dung cố định.',
    termsOfUse: 'Điều khoản sử dụng',
    title: 'Chính sách và hỗ trợ',
  },
};

export function policySupportCopy(locale: SupportedLocale): PolicySupportCopy {
  return copy[locale];
}
