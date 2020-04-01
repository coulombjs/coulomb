import React from 'react';
import { SupportedLanguages } from '../types';
import { ContextProviderConfig } from '../../config/renderer';
export declare type LocalizerProps<Languages extends SupportedLanguages> = {
    available: Languages;
    default: keyof Languages;
    selected: keyof Languages;
};
export declare type LocalizerContextProviderConfig = ContextProviderConfig<LocalizerProps<any>>;
declare const LocalizerContextProvider: React.FC<LocalizerProps<any>>;
export default LocalizerContextProvider;
