import React from 'react';
interface PaneHeaderProps {
    major?: boolean;
    minor?: boolean;
    align?: 'left' | 'right';
    className?: string;
    actions?: JSX.Element;
    multiline?: boolean;
}
export declare const PaneHeader: React.FC<PaneHeaderProps>;
export {};
