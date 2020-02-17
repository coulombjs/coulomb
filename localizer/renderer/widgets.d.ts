import React from 'react';
import { IButtonGroupProps } from '@blueprintjs/core';
import { Translatable } from '../types';
interface TranslatableComponentProps {
    what: Translatable<string>;
}
export declare const Trans: React.FC<TranslatableComponentProps>;
interface LangSelectorProps {
    value?: Translatable<any>;
    disableUnlessTranslated?: boolean;
    groupProps?: IButtonGroupProps;
}
export declare const LangSelector: React.FC<LangSelectorProps>;
export {};
