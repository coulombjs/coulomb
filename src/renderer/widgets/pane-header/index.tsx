import React from 'react';
import { Text } from '@blueprintjs/core';
import styles from './styles.scss';


interface PaneHeaderProps {
  major?: boolean,
  minor?: boolean,
  align?: 'left' | 'right',
  className?: string,
  actions?: JSX.Element,
  multiline?: boolean,
}
export const PaneHeader: React.FC<PaneHeaderProps> = function (props) {
  let alignmentClass: string;
  if (props.align === 'left') {
    alignmentClass = styles.paneHeaderAlignedLeft;
  } else if (props.align === 'right') {
    alignmentClass = styles.paneHeaderAlignedRight;
  } else {
    alignmentClass = '';
  }

  return (
    <h2 className={`
      ${styles.paneHeader}
      ${alignmentClass}
      ${props.className ? props.className : ''}
      ${props.major ? styles.paneHeaderMajor : ''}
      ${props.minor ? styles.paneHeaderMinor : ''}
    `}>

      <Text className={styles.title} ellipsize={!props.multiline}>
        {props.children}
      </Text>

      {props.actions
        ? <div className={styles.actions}>{props.actions}</div>
        : null}

    </h2>
  )
};
