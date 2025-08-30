/**
 * @fileoverview Type definitions related to the API store's configuration and state.
 */

/**
 * Configuration options for an API store instance.
 */
export interface ApiStoreOptions {
  /** Time in milliseconds to keep successful fetch results cached. Defaults to 5 minutes. */
  cacheTTL?: number;
  /** Maximum number of retry attempts for a failed fetch. Defaults to 3. */
  retryAttempts?: number;
  /** Base delay in milliseconds before retrying a failed fetch. Defaults to 1000ms. */
  retryDelay?: number;
  /** A descriptive name for this API store instance, used in logs. */
  description?: string;
  /** Optional interval in minutes to automatically refetch data. Polling is managed by the store. */
  refetchIntervalMinutes?: number;
  /**
   * Grace period in milliseconds before a stale and unused query is evicted from memory by the
   * garbage collector. Defaults to a safe value based on cacheTTL.
   */
  gcGracePeriod?: number;
}
