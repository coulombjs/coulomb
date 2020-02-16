import React from 'react';
import { SupportedLanguages, LangConfig } from '../types';
interface LangConfigContextSpec extends LangConfig {
    available: SupportedLanguages;
    default: keyof SupportedLanguages & string;
    selected: keyof SupportedLanguages & string;
    select(id: string): void;
}
export declare const LangConfigContext: React.Context<LangConfigContextSpec>;
export {};
