import React from 'react';
import { Icon, Card, Text, Button } from '@blueprintjs/core';
import styles from './styles.scss';
export const AddCardTrigger = function ({ onClick, highlight, label }) {
    return (React.createElement("div", { className: styles.addCardTriggerContainer },
        React.createElement(AddCardTriggerButton, { onClick: onClick, highlight: highlight, label: label })));
};
// If using separately from AddCardTrigger, wrap into element with addCardTriggerContainer class
export const AddCardTriggerButton = function ({ onClick, highlight, label }) {
    return React.createElement(Button, { icon: "plus", onClick: onClick, text: highlight ? (label || undefined) : undefined, minimal: highlight ? true : undefined, title: label ? label.toString() : "", intent: highlight ? "primary" : undefined, className: `${styles.addCardTrigger} ${highlight ? styles.addCardTriggerHighlighted : ''}` });
};
export const SimpleEditableCard = function (props) {
    let contents;
    const contentsClassName = `${styles.cardContents} ${props.contentsClassName || ''}`;
    if (props.extended) {
        contents = React.createElement("div", { className: contentsClassName }, props.children);
    }
    else {
        contents = (React.createElement(Text, { ellipsize: true, className: contentsClassName }, props.children));
    }
    return (React.createElement(Card, { className: `
          ${styles.editableCard}
          ${props.minimal ? styles.editableCardMinimal : ''}
          ${props.selected ? styles.editableCardSelected : ''}
          ${props.extended ? styles.editableCardExtended : ''}
          ${props.onSelect ? styles.editableCardSelectable : ''}
          ${props.onClick ? styles.editableCardInteractive : ''}
          ${props.onDelete ? styles.editableCardDeletable : ''}
          ${props.className || ''}
        `, interactive: (props.onClick || props.onSelect) ? true : false, onClick: props.onClick || props.onSelect },
        props.icon
            ? React.createElement(React.Fragment, null,
                React.createElement(Icon, { icon: props.icon }),
                "\u2002")
            : null,
        contents,
        props.onDelete
            ? React.createElement(Button, { onClick: (evt) => {
                    props.onDelete ? props.onDelete() : void 0;
                    evt.stopPropagation();
                    return false;
                }, intent: "danger", icon: "delete", title: "Delete this item", className: styles.editableCardDeleteButton, minimal: true, small: true })
            : null));
};
//# sourceMappingURL=index.js.map