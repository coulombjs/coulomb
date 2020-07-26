import { BackendDescription as BaseBackendDescription } from '../base';


export interface GitStatus {
  isOnline: boolean
  isMisconfigured: boolean
  hasLocalChanges: boolean
  needsPassword: boolean
  statusRelativeToLocal: 'ahead' | 'behind' | 'diverged' | 'updated' | undefined
  lastSynchronized: Date | null
  isPushing: boolean
  isPulling: boolean
}

export type BackendStatus = GitStatus

export interface BackendDescription extends BaseBackendDescription<BackendStatus> {
  gitRepo?: string
  gitUsername?: string
  localClonePath?: string
}