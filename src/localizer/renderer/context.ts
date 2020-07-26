import React from 'react';

import { SupportedLanguages, LangConfig } from '../types';


interface LangConfigContextSpec extends LangConfig {
  available: SupportedLanguages,
  default: keyof SupportedLanguages & string,
  selected: keyof SupportedLanguages & string,
  select(id: string): void,
}


export const LangConfigContext = React.createContext<LangConfigContextSpec>({
  available: { en: 'English', zh: 'Chinese', ru: 'Russian' },
  default: 'en' as const,
  selected: 'en',
  select: (id: string) => {},
});