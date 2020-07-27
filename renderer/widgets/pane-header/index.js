import React from 'react';
import { Text } from '@blueprintjs/core';
import styles from './styles.scss';
export const PaneHeader = function (props) {
    let alignmentClass;
    if (props.align === 'left') {
        alignmentClass = styles.paneHeaderAlignedLeft;
    }
    else if (props.align === 'right') {
        alignmentClass = styles.paneHeaderAlignedRight;
    }
    else {
        alignmentClass = '';
    }
    return (React.createElement("h2", { className: `
      ${styles.paneHeader}
      ${alignmentClass}
      ${props.className ? props.className : ''}
      ${props.major ? styles.paneHeaderMajor : ''}
      ${props.minor ? styles.paneHeaderMinor : ''}
    ` },
        React.createElement(Text, { className: styles.title, ellipsize: !props.multiline }, props.children),
        props.actions
            ? React.createElement("div", { className: styles.actions }, props.actions)
            : null));
};
//# sourceMappingURL=index.js.map