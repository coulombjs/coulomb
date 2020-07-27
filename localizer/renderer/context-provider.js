import React, { useState } from 'react';
import { LangConfigContext } from './context';
const LocalizerContextProvider = function (props) {
    const [langConfig, setLangConfig] = useState({
        available: props.available,
        default: props.default,
        selected: props.selected,
        select: (langId) => {
            setLangConfig(langConfig => Object.assign({}, langConfig, { selected: langId }));
        },
    });
    return (React.createElement(LangConfigContext.Provider, { value: langConfig }, props.children));
};
export default LocalizerContextProvider;
//# sourceMappingURL=context-provider.js.map