export const PUBLIC_SHARE_LOCALES = [
  "ko", "en", "ja", "zh-Hans", "zh-Hant", "vi",
] as const;

export type PublicShareLocale = (typeof PUBLIC_SHARE_LOCALES)[number];

type PublicShareCopy = {
  brand: string;
  checking: string;
  ageTitle: string;
  agePrompt: string;
  dateOfBirth: string;
  confirm: string;
  invalidDate: string;
  dobPrivacy: string;
  shareTitle: string;
  unavailable: string;
  imageAlt: string;
  hide: string;
  blockInApp: string;
  report: string;
  reason: string;
  comment: string;
  submitReport: string;
  reportSubmitting: string;
  reportReceived: string;
  reportFailed: string;
  reportReasons: Record<
    | "sexual_content"
    | "violence"
    | "hate_or_harassment"
    | "privacy"
    | "copyright"
    | "spam"
    | "illegal"
    | "other",
    string
  >;
};

export const PUBLIC_SHARE_COPY: Record<PublicShareLocale, PublicShareCopy> = {
  ko: {
    brand: "다녀담_다녀온 곳을 담다",
    checking: "공유 기록을 확인하고 있습니다.",
    ageTitle: "연령 확인",
    agePrompt: "공유 기록을 열려면 만 18세 이상인지 확인해 주세요.",
    dateOfBirth: "생년월일",
    confirm: "확인",
    invalidDate: "올바른 생년월일을 입력해 주세요.",
    dobPrivacy: "생년월일은 기기에서만 확인하며 서버로 전송하거나 저장하지 않습니다.",
    shareTitle: "공유 기록",
    unavailable: "이 공유 기록은 열 수 없거나 더 이상 공개되지 않습니다.",
    imageAlt: "공유된 여행 기록",
    hide: "이 기록 숨기기",
    blockInApp: "앱에서 이 공유자 차단",
    report: "신고하기",
    reason: "사유",
    comment: "설명(선택)",
    submitReport: "신고 접수",
    reportSubmitting: "신고를 접수하고 있습니다.",
    reportReceived: "신고가 접수되었습니다.",
    reportFailed: "신고를 접수하지 못했습니다.",
    reportReasons: {
      sexual_content: "성적 콘텐츠",
      violence: "폭력",
      hate_or_harassment: "혐오 또는 괴롭힘",
      privacy: "개인정보",
      copyright: "저작권",
      spam: "스팸",
      illegal: "불법 콘텐츠",
      other: "기타",
    },
  },
  en: {
    brand: "DANYEODAM",
    checking: "Checking the shared record.",
    ageTitle: "Age check",
    agePrompt: "Confirm that you are at least 18 years old to open this shared record.",
    dateOfBirth: "Date of birth",
    confirm: "Confirm",
    invalidDate: "Enter a valid date of birth.",
    dobPrivacy: "Your date of birth is checked only on this device and is not sent to or stored by the server.",
    shareTitle: "Shared record",
    unavailable: "This shared record cannot be opened or is no longer available.",
    imageAlt: "Shared travel record",
    hide: "Hide this record",
    blockInApp: "Block this sharer in the app",
    report: "Report",
    reason: "Reason",
    comment: "Details (optional)",
    submitReport: "Submit report",
    reportSubmitting: "Submitting your report.",
    reportReceived: "Your report has been received.",
    reportFailed: "Your report could not be submitted.",
    reportReasons: {
      sexual_content: "Sexual content",
      violence: "Violence",
      hate_or_harassment: "Hate or harassment",
      privacy: "Privacy",
      copyright: "Copyright",
      spam: "Spam",
      illegal: "Illegal content",
      other: "Other",
    },
  },
  ja: {
    brand: "DANYEODAM",
    checking: "共有された記録を確認しています。",
    ageTitle: "年齢確認",
    agePrompt: "共有された記録を開くには、18歳以上であることを確認してください。",
    dateOfBirth: "生年月日",
    confirm: "確認",
    invalidDate: "正しい生年月日を入力してください。",
    dobPrivacy: "生年月日は端末上でのみ確認され、サーバーへ送信・保存されません。",
    shareTitle: "共有された記録",
    unavailable: "この共有記録は開けないか、公開が終了しています。",
    imageAlt: "共有された旅行記録",
    hide: "この記録を非表示にする",
    blockInApp: "アプリでこの共有者をブロック",
    report: "報告する",
    reason: "理由",
    comment: "詳細（任意）",
    submitReport: "報告を送信",
    reportSubmitting: "報告を送信しています。",
    reportReceived: "報告を受け付けました。",
    reportFailed: "報告を送信できませんでした。",
    reportReasons: {
      sexual_content: "性的コンテンツ",
      violence: "暴力",
      hate_or_harassment: "ヘイトまたは嫌がらせ",
      privacy: "プライバシー",
      copyright: "著作権",
      spam: "スパム",
      illegal: "違法コンテンツ",
      other: "その他",
    },
  },
  "zh-Hans": {
    brand: "DANYEODAM",
    checking: "正在检查分享记录。",
    ageTitle: "年龄确认",
    agePrompt: "请确认您已年满18岁，以打开此分享记录。",
    dateOfBirth: "出生日期",
    confirm: "确认",
    invalidDate: "请输入有效的出生日期。",
    dobPrivacy: "出生日期仅在本设备上核验，不会发送至服务器或由服务器存储。",
    shareTitle: "分享记录",
    unavailable: "无法打开此分享记录，或该记录已不再公开。",
    imageAlt: "分享的旅行记录",
    hide: "隐藏此记录",
    blockInApp: "在应用中屏蔽此分享者",
    report: "举报",
    reason: "原因",
    comment: "说明（可选）",
    submitReport: "提交举报",
    reportSubmitting: "正在提交举报。",
    reportReceived: "举报已收到。",
    reportFailed: "无法提交举报。",
    reportReasons: {
      sexual_content: "色情内容",
      violence: "暴力",
      hate_or_harassment: "仇恨或骚扰",
      privacy: "隐私",
      copyright: "版权",
      spam: "垃圾信息",
      illegal: "违法内容",
      other: "其他",
    },
  },
  "zh-Hant": {
    brand: "DANYEODAM",
    checking: "正在檢查分享記錄。",
    ageTitle: "年齡確認",
    agePrompt: "請確認您已年滿18歲，以開啟此分享記錄。",
    dateOfBirth: "出生日期",
    confirm: "確認",
    invalidDate: "請輸入有效的出生日期。",
    dobPrivacy: "出生日期僅在本裝置上核驗，不會傳送至伺服器或由伺服器儲存。",
    shareTitle: "分享記錄",
    unavailable: "無法開啟此分享記錄，或該記錄已不再公開。",
    imageAlt: "分享的旅行記錄",
    hide: "隱藏此記錄",
    blockInApp: "在應用程式中封鎖此分享者",
    report: "檢舉",
    reason: "原因",
    comment: "說明（選填）",
    submitReport: "提交檢舉",
    reportSubmitting: "正在提交檢舉。",
    reportReceived: "檢舉已收到。",
    reportFailed: "無法提交檢舉。",
    reportReasons: {
      sexual_content: "色情內容",
      violence: "暴力",
      hate_or_harassment: "仇恨或騷擾",
      privacy: "隱私",
      copyright: "著作權",
      spam: "垃圾訊息",
      illegal: "違法內容",
      other: "其他",
    },
  },
  vi: {
    brand: "DANYEODAM",
    checking: "Đang kiểm tra bản ghi được chia sẻ.",
    ageTitle: "Xác nhận độ tuổi",
    agePrompt: "Hãy xác nhận bạn từ 18 tuổi trở lên để mở bản ghi được chia sẻ này.",
    dateOfBirth: "Ngày sinh",
    confirm: "Xác nhận",
    invalidDate: "Hãy nhập ngày sinh hợp lệ.",
    dobPrivacy: "Ngày sinh chỉ được kiểm tra trên thiết bị này, không được gửi đến hoặc lưu trên máy chủ.",
    shareTitle: "Bản ghi được chia sẻ",
    unavailable: "Không thể mở bản ghi này hoặc bản ghi không còn được công khai.",
    imageAlt: "Bản ghi chuyến đi được chia sẻ",
    hide: "Ẩn bản ghi này",
    blockInApp: "Chặn người chia sẻ này trong ứng dụng",
    report: "Báo cáo",
    reason: "Lý do",
    comment: "Chi tiết (không bắt buộc)",
    submitReport: "Gửi báo cáo",
    reportSubmitting: "Đang gửi báo cáo.",
    reportReceived: "Báo cáo đã được tiếp nhận.",
    reportFailed: "Không thể gửi báo cáo.",
    reportReasons: {
      sexual_content: "Nội dung tình dục",
      violence: "Bạo lực",
      hate_or_harassment: "Thù ghét hoặc quấy rối",
      privacy: "Quyền riêng tư",
      copyright: "Bản quyền",
      spam: "Thư rác",
      illegal: "Nội dung bất hợp pháp",
      other: "Khác",
    },
  },
};

export function selectPublicShareLocale(languages: readonly string[]): PublicShareLocale {
  for (const language of languages) {
    const normalized = language.trim().toLowerCase();
    if (/^zh-hant(?:-|$)/u.test(normalized) || /^zh-(tw|hk|mo)(-|$)/u.test(normalized)) {
      return "zh-Hant";
    }
    if (/^zh-hans(?:-|$)/u.test(normalized) || /^zh-(cn|sg)(-|$)/u.test(normalized)) {
      return "zh-Hans";
    }
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-Hans";
    if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
    if (normalized === "vi" || normalized.startsWith("vi-")) return "vi";
  }
  return "en";
}

export function selectPublicShareLocaleFromHeader(value: string | null): PublicShareLocale {
  if (value === null || value.length > 2_048) return "en";
  const weighted = value.split(",", 20).map((entry, index) => {
    const [language = "", ...parameters] = entry.trim().split(";");
    const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const quality = qualityParameter === undefined
      ? 1
      : Number(qualityParameter.trim().slice(2));
    return {
      language,
      quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0,
      index,
    };
  }).filter(({ language, quality }) => language !== "" && language !== "*" && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .map(({ language }) => language);
  return selectPublicShareLocale(weighted);
}
