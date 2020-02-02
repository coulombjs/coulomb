import React from 'react';
import { Icon, Card, Text, Button } from '@blueprintjs/core';
import { IconName } from '@blueprintjs/icons';
import styles from './styles.scss';


interface AddCardTriggerProps {
  onClick?: (...args: any[]) => void,
  highlight?: boolean,
  label?: string | JSX.Element,
}


export const AddCardTrigger: React.FC<AddCardTriggerProps> = function ({ onClick, highlight, label }) {
  return (
    <div className={styles.addCardTriggerContainer}>
      <AddCardTriggerButton onClick={onClick} highlight={highlight} label={label} />
    </div>
  );
};


// If using separately from AddCardTrigger, wrap into element with addCardTriggerContainer class
export const AddCardTriggerButton: React.FC<AddCardTriggerProps> = function ({ onClick, highlight, label }) {
  return <Button
    icon="plus"
    onClick={onClick}
    text={highlight ? (label || undefined) : undefined}
    minimal={highlight ? true : undefined}
    title={label ? label.toString() : ""}
    intent={highlight ? "primary" : undefined}
    className={`${styles.addCardTrigger} ${highlight ? styles.addCardTriggerHighlighted : ''}`}
  />;
};


interface SimpleEditableCardProps {
  icon?: IconName,
  selected?: boolean,
  onDelete?: () => void,
  onSelect?: () => void,
  onClick?: () => void,
  minimal?: boolean,
  extended?: boolean,
  contentsClassName?: string,
  className?: string,
}
export const SimpleEditableCard: React.FC<SimpleEditableCardProps> = function (props) {
  let contents: JSX.Element;
  const contentsClassName = `${styles.cardContents} ${props.contentsClassName || ''}`;

  if (props.extended) {
    contents = <div className={contentsClassName}>{props.children}</div>;
  } else {
    contents = (
      <Text ellipsize={true} className={contentsClassName}>
        {props.children}
      </Text>
    );
  }

  return (
    <Card
        className={`
          ${styles.editableCard}
          ${props.minimal ? styles.editableCardMinimal : ''}
          ${props.selected ? styles.editableCardSelected : ''}
          ${props.extended ? styles.editableCardExtended : ''}
          ${props.onSelect ? styles.editableCardSelectable : ''}
          ${props.onClick ? styles.editableCardInteractive : ''}
          ${props.onDelete ? styles.editableCardDeletable : ''}
          ${props.className || ''}
        `}
        interactive={props.onClick ? true : false}
        onClick={props.onClick || props.onSelect}>

      {props.icon
        ? <><Icon icon={props.icon} />&ensp;</>
        : null}

      {contents}

      {props.onDelete
        ? <Button
            onClick={(evt: any) => {
              props.onDelete ? props.onDelete() : void 0;
              evt.stopPropagation();
              return false;
            }}
            intent="danger"
            icon="delete"
            title="Delete this item"
            className={styles.editableCardDeleteButton}
            minimal={true}
            small={true}
          />
        : null}

    </Card>
  );
};
