import { WindowOpenerParams } from '../main/window';


export interface Window {
  // The component ID will be assumed to be window name (ID) in config.
  openerParams: Omit<WindowOpenerParams, 'component'>,
}


export interface ModelInfo {
  shortName: string,
  verboseName: string,
  verboseNamePlural: string,
}


export interface DatabaseInfo {
  verboseName: string,
}


export interface AppConfig {
  data: Record<string, ModelInfo>
  databases: Record<string, DatabaseInfo>

  windows: {
    default: Window
    [windowName: string]: Window
  }

  settingsWindowID?: keyof this["windows"]
  splashWindowID?: keyof this["windows"]

  help: {
    rootURL: string
  }
}
