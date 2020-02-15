import React from 'react';
import { WindowComponentProps } from '../config/renderer';
interface SettingHook<T> {
    value: T;
    remoteValue: T;
    commit: () => Promise<void>;
    set: (value: T) => void;
    changed: () => boolean;
}
export declare function useSetting<T>(name: string, initialValue: T): SettingHook<T>;
declare const SettingsScreen: React.FC<WindowComponentProps>;
export default SettingsScreen;
