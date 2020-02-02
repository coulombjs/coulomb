import React from 'react';
import { SupportedLanguages } from '../types';
declare type LocalizerOptions<Languages extends SupportedLanguages> = {
    available: Languages;
    default: keyof Languages;
    selected: keyof Languages;
};
declare const LocalizerContextProvider: React.FC<LocalizerOptions<any>>;
export default LocalizerContextProvider;
