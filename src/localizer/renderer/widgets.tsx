import React, { useContext } from 'react';
import { Button, ButtonGroup, IButtonGroupProps, IButtonProps } from '@blueprintjs/core';

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
  groupProps?: IButtonGroupProps
  exclude?: string[]
  untranslatedProps?: IButtonProps
  translatedProps?: IButtonProps
}
export const LangSelector: React.FC<LangSelectorProps> =
function ({ exclude, value, untranslatedProps, translatedProps, groupProps }) {
  const cfg = useContext(LangConfigContext);

  return (
    <ButtonGroup {...groupProps}>
      {Object.keys(cfg.available).
          filter(langID => (exclude || []).indexOf(langID) < 0).
          map(langId =>
        <LangSelectorButton
          key={langId}
          id={langId}
          title={cfg.available[langId]}
          isSelected={langId === cfg.selected}
          onSelect={() => cfg.select(langId)}
          untranslatedProps={untranslatedProps}
          translatedProps={translatedProps}
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
  untranslatedProps?: IButtonProps
  translatedProps?: IButtonProps
}
const LangSelectorButton: React.FC<LangSelectorButtonProps> = function (props) {
  return (
    <Button
        active={props.isSelected}
        onClick={props.onSelect}
        {...(!props.hasTranslation ? props.untranslatedProps : {})}
        {...(props.hasTranslation ? props.translatedProps : {})}>
      {props.id}
    </Button>
  );
};
