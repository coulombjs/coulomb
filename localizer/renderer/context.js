import React from 'react';
export const LangConfigContext = React.createContext({
    available: { en: 'English', zh: 'Chinese', ru: 'Russian' },
    default: 'en',
    selected: 'en',
    select: (id) => { },
});
//# sourceMappingURL=context.js.map