import { createPendingEmailLinkStore } from './email-link-pending';
import { sessionStorage } from './session-storage';

export const pendingEmailLinkStore = createPendingEmailLinkStore(sessionStorage);
