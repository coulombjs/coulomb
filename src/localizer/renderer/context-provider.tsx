import React, { useState } from 'react';

import { SupportedLanguages } from '../types';
import { LangConfigContext } from './context';


type LocalizerOptions<Languages extends SupportedLanguages> = {
  available: Languages
  default: keyof Languages
  selected: keyof Languages
};


const LocalizerContextProvider: React.FC<LocalizerOptions<any>> = function (props) {
  const [langConfig, setLangConfig] = useState({
    available: props.available,
    default: props.default as string,
    selected: props.selected as string,
    select: (langId: keyof typeof props.available) => {
      setLangConfig(langConfig => Object.assign({}, langConfig, { selected: langId }));
    },
  });

  return (
    <LangConfigContext.Provider value={langConfig}>
      {props.children}
    </LangConfigContext.Provider>
  );
};


export default LocalizerContextProvider;
