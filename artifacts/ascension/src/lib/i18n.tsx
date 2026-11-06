import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Locale } from 'date-fns';
import { ar as arDateLocale, enUS } from 'date-fns/locale';
import { en, type Messages } from '@/locales/en';
import { ar } from '@/locales/ar';

export type Lang = 'ar' | 'en';

/**
 * Read by the inline script in index.html as well, so <html dir> is right
 * before React mounts and an English page never flashes in RTL.
 */
export const LANG_STORAGE_KEY = 'enstep.lang';

const MESSAGES: Record<Lang, Messages> = { ar, en };

/**
 * Arabic is the default: the people learning English here read Arabic first,
 * and the product was Arabic-only until now. Storage can throw in a private
 * window, which just means the choice is not remembered.
 */
function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (v === 'ar' || v === 'en') return v;
  } catch {
    /* ignore */
  }
  return 'ar';
}

function applyToDocument(lang: Lang) {
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

interface I18nValue {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  setLang: (lang: Lang) => void;
  t: Messages;
  /** For date-fns `format(..., { locale })`. */
  dateLocale: Locale;
  /** BCP 47 tag for Intl / toLocale* calls. */
  locale: string;
  /**
   * Chooses between the Arabic and English versions of a piece of content
   * (a lesson title, a level name), falling back to whichever exists.
   */
  pick: (arText: string | null | undefined, enText: string | null | undefined) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);

  useEffect(() => {
    applyToDocument(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      setLang,
      t: MESSAGES[lang],
      dateLocale: lang === 'ar' ? arDateLocale : enUS,
      locale: lang === 'ar' ? 'ar' : 'en',
      pick: (arText, enText) =>
        (lang === 'ar' ? arText || enText : enText || arText) ?? '',
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
