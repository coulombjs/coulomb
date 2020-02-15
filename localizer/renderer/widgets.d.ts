import React from 'react';
import { Translatable } from '../types';
interface TranslatableComponentProps {
    what: Translatable<string>;
}
export declare const Trans: React.FC<TranslatableComponentProps>;
interface LangSelectorProps {
    value?: Translatable<any>;
}
export declare const LangSelector: React.FC<LangSelectorProps>;
export {};
