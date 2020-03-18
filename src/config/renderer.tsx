import * as React from 'react';
import { AppConfig } from './app';
import { BackendDescription } from '../db/base';


export interface RendererConfig<App extends AppConfig> {
  app: App
  windowComponents: Record<
    keyof App["windows"],
    () => Promise<{ default: React.FC<WindowComponentProps> }>>
  contextProviders?: ContextProviderConfig<any>[]
  databaseStatusComponents: Record<
    keyof App["databases"],
    () => Promise<{ default: React.FC<DatabaseStatusComponentProps<any, any>> }>>
}


export interface ContextProviderConfig<Props> {
  cls: () => Promise<{ default: React.FC<Props> }>
  getProps: (config: RendererConfig<any>) => Props
}


export interface WindowComponentProps {
  query: URLSearchParams
}


export interface DatabaseStatusComponentProps<Desc extends BackendDescription<Status>, Status> {
  dbIPCPrefix: string
  description: Desc
  status: Status
}