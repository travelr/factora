import { act, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { DataConsumer } from '@test-helper/test-components';
import { createTestableApiStore } from '@test-helper/test-helpers';
import { flushPromises } from '@test-helper/async-helpers';

describe('safe diagnostics', () => {
  test('Verifies that automatic logs never contain request secrets', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('failed'));
    const { useApiQuery, logger } = createTestableApiStore(
      '/api/secrets',
      fetcher,
      { retryAttempts: 1 },
    );
    render(
      <DataConsumer
        useApiQuery={useApiQuery}
        params={{ accessToken: 'top-secret' }}
      />,
    );
    await act(flushPromises);
    const calls = [
      logger.info,
      logger.warn,
      logger.error,
      logger.debug,
    ].flatMap((method) => (method as ReturnType<typeof vi.fn>).mock.calls);
    expect(JSON.stringify(calls)).not.toContain('top-secret');
  });
});
