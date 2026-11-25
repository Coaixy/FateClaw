import { enMessages } from './messages/en';
import { zhCNMessages } from './messages/zh-cn';
import { zhTWMessages } from './messages/zh-tw';

export const messages = {
  'zh-CN': zhCNMessages,
  'zh-TW': zhTWMessages,
  en: enMessages,
} as const;
