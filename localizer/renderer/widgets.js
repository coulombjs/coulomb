import React, { useContext } from 'react';
import { Button, ButtonGroup } from '@blueprintjs/core';
import { LangConfigContext } from './context';
export const Trans = function ({ what }) {
    const lang = useContext(LangConfigContext);
    const translated = what[lang.selected];
    const untranslated = what[lang.default];
    // const translated = translatable[lang.selected.id];
    // if (!translated) {
    //   // Register missing translation
    // }
    return React.createElement("span", null, translated || untranslated || '(malformed translatable string)');
};
export const LangSelector = function ({ exclude, value, untranslatedProps, translatedProps, groupProps }) {
    const cfg = useContext(LangConfigContext);
    return (React.createElement(ButtonGroup, Object.assign({}, groupProps), Object.keys(cfg.available).
        filter(langID => (exclude || []).indexOf(langID) < 0).
        map(langId => React.createElement(LangSelectorButton, { key: langId, id: langId, title: cfg.available[langId], isSelected: langId === cfg.selected, onSelect: () => cfg.select(langId), untranslatedProps: untranslatedProps, translatedProps: translatedProps, hasTranslation: (value !== undefined) ? (value[langId] !== undefined) : undefined }))));
};
const LangSelectorButton = function (props) {
    return (React.createElement(Button, Object.assign({ active: props.isSelected, onClick: props.onSelect }, (!props.hasTranslation ? props.untranslatedProps : {}), (props.hasTranslation ? props.translatedProps : {})), props.id));
};
//# sourceMappingURL=widgets.js.map