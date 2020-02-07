import * as React from 'react';
import { AppConfig } from './app';


export interface RendererConfig<App extends AppConfig> {
  app: App
  windowComponents: Record<
    keyof App["windows"],
    () => Promise<{ default: React.FC<WindowComponentProps> }>>
  contextProviders: ContextProviderConfig<any>[]
}


export interface ContextProviderConfig<Props> {
  cls: () => Promise<{ default: React.FC<Props> }>
  getProps: (config: RendererConfig<any>) => Props
}


export interface WindowComponentProps {
  query: URLSearchParams
}