// Job lifecycle. Every state change goes through canTransition(); nothing skips the
// human gate at MR_DRAFT (no transition leads from automation to an approved/merged MR -
// MERGED is only ever set by observing GitLab after a human merges).
export const TRANSITIONS = Object.freeze({
  QUEUED: ['FETCHING', 'CANCELLED'],
  FETCHING: ['ANALYZING', 'NEEDS_INFO', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  ANALYZING: ['IMPLEMENTING', 'NEEDS_INFO', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  IMPLEMENTING: ['VALIDATING', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  VALIDATING: ['VALIDATED', 'PUSHING', 'VALIDATION_FAILED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  // Compiled OK, committed locally, waiting for Phase 6 to push + open the Draft MR.
  VALIDATED: ['PUSHING', 'QUEUED', 'CANCELLED'],
  PUSHING: ['MR_DRAFT', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  MR_DRAFT: ['MERGED', 'CHANGES_REQUESTED', 'MR_CLOSED', 'CANCELLED'],
  CHANGES_REQUESTED: ['IMPLEMENTING', 'MR_CLOSED', 'CANCELLED'],
  MERGED: ['STAGING_PENDING', 'CANCELLED'],
  STAGING_PENDING: ['PIPELINE_RUNNING', 'CANCELLED'],
  PIPELINE_RUNNING: ['STAGING_DEPLOYED', 'PIPELINE_FAILED'],
  PIPELINE_FAILED: ['STAGING_PENDING', 'CANCELLED'],
  NEEDS_INFO: ['QUEUED', 'CANCELLED'],
  VALIDATION_FAILED: ['QUEUED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  INTERRUPTED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
  MR_CLOSED: [],
  STAGING_DEPLOYED: [],
});

export const STATES = Object.freeze(Object.keys(TRANSITIONS));

// Finished for good: a new assignment of the same issue may start a new job.
export const TERMINAL_STATES = Object.freeze(['CANCELLED', 'MR_CLOSED', 'STAGING_DEPLOYED']);

// States where a process is doing work; after a crash/restart they become INTERRUPTED
// and only resume when the user explicitly runs `ngauto resume`.
export const TRANSIENT_STATES = Object.freeze(['FETCHING', 'ANALYZING', 'IMPLEMENTING', 'VALIDATING', 'PUSHING']);

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}
