import React, { useContext } from 'react';
import { Button, ButtonGroup, IButtonGroupProps } from '@blueprintjs/core';

import { Translatable } from '../types';

import { LangConfigContext } from './context';


interface TranslatableComponentProps {
  what: Translatable<string>
}
export const Trans: React.FC<TranslatableComponentProps> = function ({ what }) {
  const lang = useContext(LangConfigContext);
  const translated = what[lang.selected];
  const untranslated = what[lang.default];

  // const translated = translatable[lang.selected.id];
  // if (!translated) {
  //   // Register missing translation
  // }

  return <span>{translated || untranslated || '(malformed translatable string)'}</span>;
};


interface LangSelectorProps {
  value?: Translatable<any>
  disableUnlessTranslated?: boolean
  groupProps?: IButtonGroupProps
}
export const LangSelector: React.FC<LangSelectorProps> = function ({ value, disableUnlessTranslated, groupProps }) {
  const cfg = useContext(LangConfigContext);

  return (
    <ButtonGroup {...groupProps}>
      {Object.keys(cfg.available).map((langId: string) =>
        <LangSelectorButton
          id={langId}
          title={cfg.available[langId]}
          isSelected={langId === cfg.selected}
          onSelect={() => cfg.select(langId)}
          disableUnlessTranslated={disableUnlessTranslated}
          hasTranslation={(value !== undefined) ? (value[langId] !== undefined) : undefined}
        />
      )}
    </ButtonGroup>
  );
};


interface LangSelectorButtonProps {
  id: string
  title: string
  isSelected: boolean
  onSelect: () => void
  hasTranslation?: boolean
  disableUnlessTranslated?: boolean
}
const LangSelectorButton: React.FC<LangSelectorButtonProps> = function (props) {
  return (
    <Button
        active={props.isSelected}
        disabled={props.hasTranslation === false && props.disableUnlessTranslated === true}
        onClick={props.onSelect}>
      {props.id}
    </Button>
  );
};
