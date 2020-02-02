import * as React from 'react';
import { AppConfig } from './app';


export interface RendererConfig<App extends AppConfig> {
  app: App
  windowComponents: Record<
    keyof App["windows"],
    () => Promise<{ default: React.FC<WindowComponentProps> }>>
  contextProviders: ContextProviderConfig<any>[]
}


export interface ContextProviderConfig<O extends object> {
  id: string
  cls: () => Promise<{ default: React.FC<O> }>
  opts: (config: RendererConfig<any>) => O
}


export interface WindowComponentProps {
  query: URLSearchParams
}