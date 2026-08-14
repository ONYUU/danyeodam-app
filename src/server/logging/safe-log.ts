type SafeLogContext = {
  requestId: string;
  operation: string;
  category: "configuration" | "authentication" | "database" | "unexpected";
  locationComplianceCounts?: {
    failed_items: number;
    object_failed_items: number;
    pending_jobs: number;
    overdue_jobs: number;
    high_attempt_jobs: number;
    max_attempt_count: number;
    open_corrections: number;
    overdue_open_corrections: number;
    pending_object_reconciliations: number;
    overdue_object_reconciliations: number;
    high_attempt_object_reconciliations: number;
  };
  accountDeletionCounts?: {
    retrying: number;
    failed_external_operations: number;
    pending_jobs: number;
    overdue_jobs: number;
    high_attempt_jobs: number;
    max_attempt_count: number;
    retrying_jobs: number;
  };
};

export function logSafeServerError(context: SafeLogContext): void {
  console.error(JSON.stringify({
    level: "error",
    request_id: context.requestId,
    operation: context.operation,
    category: context.category,
    ...(context.locationComplianceCounts === undefined
      ? {}
      : { location_compliance_counts: context.locationComplianceCounts }),
    ...(context.accountDeletionCounts === undefined
      ? {}
      : { account_deletion_counts: context.accountDeletionCounts }),
  }));
}
