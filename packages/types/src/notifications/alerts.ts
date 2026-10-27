/** Where a project's failure alerts go (Plunk Lite): addresses that only receive alerts. */
export interface AlertSettings {
  recipients: string[];
  fromEmail: string;
  fromName: string | null;
}

/**
 * A source of failures not reviewed since its last one, as the dashboard banner shows it. `lastAt`
 * is what the banner sends back to mark it reviewed, so a failure after it stays open.
 */
export interface FailureAlert {
  id: string;
  /**
   * `workflow:<id>`, `campaign:<id>` or `transactional` for failures. For conditions (see
   * `isFailureNotice` in `@plunk/shared`): `project`, `project:reactivated`, `brake:campaign:<id>`,
   * `brake:workflow:<id>`, `security:warning`, `security:critical`, `security:check`,
   * `domain:<id>`, `sns:<what>`, `ses:<what>`, `aws:alarm:<name>` or `aws:alarm-subscription`
   */
  sourceKey: string;
  label: string;
  count: number;
  lastError: string;
  lastContactEmail: string | null;
  firstAt: string;
  lastAt: string;
  /** Where the dashboard shows the source's failures, e.g. `/workflows/<id>?tab=executions` */
  reviewPath: string;
}
