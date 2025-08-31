import React from 'react';

/**
 * A standardized component for consuming an API store hook in tests.
 * It renders the hook's state and provides buttons for triggering actions.
 */
export const DataConsumer = ({
  useApiQuery,
  params = {},
}: {
  useApiQuery: (params?: Record<string, any>) => any;
  params?: Record<string, any>;
}) => {
  const { data, loading, error, refetch, clear } = useApiQuery(params);

  return (
    <div>
      <div data-testid="data">{data ? JSON.stringify(data) : 'null'}</div>
      <div data-testid="loading">{loading.toString()}</div>
      <div data-testid="error">{error ? error.message : 'null'}</div>
      <button onClick={refetch} data-testid="refetch-button">
        Refetch
      </button>
      <button onClick={clear} data-testid="clear-button">
        Clear
      </button>
    </div>
  );
};

/**
 * A specialized consumer component for testing rendering behavior.
 * It tracks render counts and includes interactive elements.
 */
export const RenderTracker = ({
  useApiQuery,
  params = {},
}: {
  useApiQuery: (params?: Record<string, any>) => any;
  params?: Record<string, any>;
}) => {
  const { data, loading, error, refetch } = useApiQuery(params);
  const renderCountRef = React.useRef(0);
  renderCountRef.current += 1;

  return (
    <div>
      <div data-testid="render-count">{renderCountRef.current}</div>
      <div data-testid="data">{data ? JSON.stringify(data) : 'null'}</div>
      <div data-testid="loading">{loading.toString()}</div>
      <div data-testid="error">{error ? error.message : 'null'}</div>
      <button onClick={refetch} data-testid="refetch-button">
        Refetch
      </button>
    </div>
  );
};
