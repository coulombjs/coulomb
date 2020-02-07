export interface BackendDescription<Status> {
  /* Database backend description & status, reported to app windows. */

  verboseName: string
  status: Status
}