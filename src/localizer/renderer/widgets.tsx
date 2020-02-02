import React, { useContext } from 'react';
import { Icon } from '@blueprintjs/core';

import { Translatable } from '../types';

import { LangConfigContext } from './context';

import styles from './styles.scss';


interface TranslatableComponentProps { what: Translatable<string> }
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
  value?: Translatable<any>,
}
export const LangSelector: React.FC<LangSelectorProps> = function ({ value }) {
  const cfg = useContext(LangConfigContext);

  return (
    <p className={styles.langSelector}>
      {Object.keys(cfg.available).map((langId: string) =>
        <LangSelectorButton
          id={langId}
          title={cfg.available[langId]}
          isSelected={langId === cfg.selected}
          onSelect={() => cfg.select(langId)}
          hasTranslation={(value !== undefined) ? (value[langId] === undefined) : undefined}
        />
      )}
    </p>
  );
};


interface LangSelectorButtonProps {
  id: string,
  title: string,
  isSelected: boolean,
  onSelect: () => void,
  hasTranslation: boolean | undefined,
}
const LangSelectorButton: React.FC<LangSelectorButtonProps> = function (props) {
  return (
    <>

      {props.isSelected
        ? <strong className={styles.lang}>
            {props.id}
          </strong>
        : <a
              className={styles.lang}
              title={`Select ${props.title}`}
              href="javascript: void 0;"
              onClick={props.onSelect}>
            <span>{props.id}</span>
          </a>}

      {props.hasTranslation === false
        ? <Icon
            icon="error"
            intent="danger"
            title={`Missing translation for ${props.title}`}
            htmlTitle={`Missing translation for ${props.title}`}
          />
        : ''}

    </>
  );
};
