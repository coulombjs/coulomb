import React from 'react';
import { IButtonGroupProps, IButtonProps } from '@blueprintjs/core';
import { Translatable } from '../types';
interface TranslatableComponentProps {
    what: Translatable<string>;
}
export declare const Trans: React.FC<TranslatableComponentProps>;
interface LangSelectorProps {
    value?: Translatable<any>;
    groupProps?: IButtonGroupProps;
    exclude?: string[];
    untranslatedProps?: IButtonProps;
    translatedProps?: IButtonProps;
}
export declare const LangSelector: React.FC<LangSelectorProps>;
export {};
