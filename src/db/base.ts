export interface BackendDescription<Status> {
  /* Database backend description & status, reported to app windows. */

  verboseNameLong?: string
  verboseName: string
  status: Status
}