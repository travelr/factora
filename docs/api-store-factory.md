# API Store Factory

---

## Introduction

The API Store Factory is a centralized, robust solution for fetching, caching, and managing server state in the application. It provides factory functions that generate a dedicated Zustand store and a corresponding React hook (`useApiQuery`) for a specific API resource.

The architecture is built on a **dependency-injected pure core** with optional adapters. This promotes a clear separation of concerns: the generated store acts as a powerful, centralized engine for all data fetching logic, while the hook provides a simple, declarative API for React components to consume that data. This design makes the library flexible, testable, and ensures consumers only bundle the dependencies they actually use.

`Sources: src/core/api-store-factory.ts, src/core/store-engine.ts, src/react/create-query-hook.ts, src/index.ts, src/pure.ts`

---

## Core Architecture & Design Philosophy

The system is built on a factory pattern. Instead of a single monolithic store for all API data, a new, isolated store instance is created for each logical API resource (e.g., `/assets`). This prevents state collisions and keeps the concerns for each data type separate.

The library now offers two distinct entry points to accommodate different project needs: a simple, pre-configured setup for convenience, and a pure, fully decoupled setup for advanced customization.

```mermaid
graph TD
subgraph Application
D[App Code]
end

    subgraph "Factora Public API"
        subgraph Convenient Pattern
            A["createApiStore()"]
        end
        subgraph Pure Pattern
            P["createApiFactoryPure()"]
        end
    end

    subgraph "Generated Instance (Internal)"
        B((Zustand Store Engine))
        C{useApiQuery Hook}
    end

    A -- Generates --> C;
    P -- Generates --> C;
    D -- Calls Hook --> C;
    C -- Subscribes to & Dispatches to --> B;

```

### The Role of Zustand: A Global State Engine

It is critical to understand that a Zustand store is a **single, global, non-React state object**. It lives outside the React component tree. The `useApiQuery` hook acts as a "window" or "selector" into this global state. When a component using the hook unmounts, it simply **unsubscribes** from updates. The data and any in-flight requests in the global store **persist**. This is the foundation of the shared cache model.

`Sources: src/core/store-engine.ts, src/react/create-query-hook.ts`

## How to Create a New API Store

Creating a new store involves two main steps: defining your data fetching logic and then using one of the factory functions to generate the hook.

### Pattern 1: Convenient Factory (`createApiStore`)

This is the recommended approach for most use cases. It provides a single function that has already been configured with standard adapters for error handling (`axiosErrorMapper`) and logging (`loglevelAdapter`). The developer only needs to provide their own data-fetching logic. `Sources: src/index.ts:39-76`

```typescript
// src/stores/firefly-store.ts
import { createApiStore } from 'factora'; // Import from the convenient entry point
import { FireflyAccount } from '@app-types/firefly-types';
import axios from 'axios';

// 1. Define the data-fetching logic.
// This allows for handling custom API response envelopes.
const fireflyFetcher = async (
  endpoint: string,
  params: Record<string, any>,
  signal?: AbortSignal,
): Promise<FireflyAccount[]> => {
  const response = await axios.get(endpoint, { params, signal });
  // Example of unwrapping a response: return response.data.payload;
  return response.data;
};

// 2. Call the factory with the path and fetcher, then export the hook.
export const useFireflyAccountStore = createApiStore(
  '/api/v1/accounts',
  fireflyFetcher,
  {
    cacheTTL: 10 * 60 * 1000, // 10-minute cache
    description: 'Firefly Accounts',
  },
);
```

### Pattern 2: Pure Factory (`createApiFactoryPure`)

This pattern provides maximum control and is intended for projects with custom requirements (e.g., using `fetch` instead of Axios). It requires the developer to explicitly construct the factory by providing all dependencies. `Sources: src/pure.ts, src/core/index.ts`

```typescript
// src/api/api-factory-setup.ts
import { createApiFactoryPure } from 'factora/pure';
import { axiosErrorMapper } from 'factora/adapter/axios';
import { loglevelAdapter } from 'factora/adapter/loglevel';

// 1. Create a reusable, application-wide factory by providing all dependencies.
const myAppApiFactory = createApiFactoryPure({
  errorMapper: axiosErrorMapper,
  logger: loglevelAdapter,
});

// 2. Use the new factory to create store hooks, providing the fetcher each time.
// export const useSomeStore = myAppApiFactory('/api/other', someFetcher);
```

### Step 2: Use the Hook in Components

Once created, your new hook is ready to be used anywhere in your application.

```typescript
const { data, loading, error } = useFireflyAccountStore({ type: 'asset' });
```

---

## The Dependency Injection Contract

The entire library is built upon the principle of **Dependency Injection (DI)**, a form of Inversion of Control. Instead of the library's core creating its own dependencies (like a logger or an Axios instance), it requires them to be "injected" from the outside. This is the key to its flexibility, testability, and support for tree-shaking.

This contract is formally defined by a set of TypeScript interfaces, primarily the `FactoraDependencies` interface. The pure core of the library only ever interacts with these abstract contracts, not with any concrete implementation like Axios or Loglevel.

### The Core Contract: `FactoraDependencies`

This interface is the "shopping list" of services that the `createApiFactoryPure` function requires to operate. It bundles all external logic into a single object.

| Property          | Type Signature                             | Responsibility                                                                                            |
| :---------------- | :----------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **`fetcher`**     | `(endpoint, params, signal) => Promise<T>` | To perform the actual network request and return data. **This is provided by the application developer.** |
| **`errorMapper`** | `(error, context) => ApiError`             | To inspect any error thrown by the `fetcher` and normalize it into a standardized `ApiError` object.      |
| **`logger`**      | `FactoraLogger`                            | To handle internal logging within the library, such as for the Garbage Collector or unexpected errors.    |

`Sources: src/types/dependencies.ts:23`

The following diagram illustrates how the application provides concrete implementations (the adapters and the fetcher) that fulfill the contract required by the pure factory.

```mermaid
graph TD
   subgraph Application Code
       A["App-Specific Fetcher"]
       B["factora/adapter/axios<br/>(axiosErrorMapper)"]
       C["factora/adapter/loglevel<br/>(loglevelAdapter)"]
   end

   subgraph "Factora's Pure API"
       D["createApiFactoryPure()"]
   end

   subgraph "Factora's Pure Core"
       E((Core Store Logic))
   end

   A -- "Provides fetcher" --> D
   B -- "Provides errorMapper" --> D
   C -- "Provides logger" --> D
   D -- "Configures & Uses Dependencies" --> E
```

### Detailed Breakdown of the Contract

#### The `fetcher` Contract

This is the most critical part of the contract that the application developer implements. It defines the shape of the function responsible for actually fetching data. The library's core is unopinionated about _how_ you fetch data; it only cares that the function you provide returns a `Promise` that resolves with the expected data. This allows you to use `axios`, the native `fetch` API, or any other data-fetching client.

#### The `errorMapper` Contract

The `errorMapper`'s job is to act as a **normalizer**. Network errors can come in many shapes and sizes. This function's responsibility is to take any `unknown` error thrown by the `fetcher` and transform it into a predictable `ApiError` object. This is where library-specific knowledge is encapsulated.

The provided `axiosErrorMapper` is a sophisticated implementation of this contract that knows how to inspect an `AxiosError` for status codes, `Retry-After` headers, and timeout codes to correctly populate the `retryable` and `retryAfter` fields.

`Sources: src/adapter/axios.ts:74`

#### The `logger` Contract

This defines a simple interface for logging messages. The library's core uses the injected logger to report on internal events, such as the Garbage Collector cleaning up stores or an unexpected failure within one of the dependencies (like the `errorMapper` itself crashing).

The provided `loglevelAdapter` is a thin wrapper that implements this interface by delegating all calls to the `loglevel` library.

`Sources: src/adapter/loglevel.ts:11`

---

## The Global Cache

The "global cache" for each store instance is the `queries` object managed within the **Zustand store**. This object is the single source of truth for all data, loading, and error states for that specific API resource. The factory uses Zustand's `create` function to build a store that holds this state, living outside the React component tree, which allows it to persist and be shared across components.

### What is Stored in the Cache?

The `queries` object is a JavaScript map where keys are stable, tagged in-memory identities and values are `QueryState` objects. The key identifies a specific endpoint and parameter shape; the original endpoint and parameter values are retained separately in the request descriptor used by the fetcher. Parameters are never reconstructed by decoding a cache key.

`Sources: src/core/store-engine.ts, src/utils/get-query-key.ts`

After a component calls `useFireflyAccounts({ type: 'asset' })`, the `queries` object inside the Zustand store's state would look like this:

```javascript
// Inside the Zustand store's state:
{
 queries: {
   // The unique, tagged in-memory key
   "[[\"string\",\"/api/v1/accounts\"],[\"object\",[[\"type\",[\"string\",\"asset\"]]]]]": {
     // The QueryState object for this specific query
     "data": [{...}, {...}],
     "error": null,
     "lastFetchTimestamp": 1678886400000,
     "lastSettledTimestamp": 1678886400000,
     "request": { "endpoint": "/api/v1/accounts", "params": { "type": "asset" } },
     "inFlightPromise": undefined,
     "abortController": undefined,
     "refetchTimerId": 123
   }
 },
 queryCount: 1
 // ...other global state properties
}
```

This granularity ensures that every unique combination of parameters gets its own separate entry in the cache, preventing data from one query from ever overwriting another.

---

## The `triggerFetch` Logic Flow

The `triggerFetch` function is the main entry point and "brain" of the store. It follows a clear, prioritized sequence to handle any request. The function first checks if a `forceFetch` is requested, which bypasses all checks and initiates a new fetch. If not, it checks for an in-flight request to prevent duplicates. Finally, it checks for fresh data in the cache. Only if none of these conditions are met will it proceed to initiate a new fetch cycle.

```mermaid
graph TD
  Start([Start triggerFetch]) --> A{forceFetch?};
  A -- Yes --> B[Abort Existing Request];
  A -- No --> C{Is Request In-Flight?};
  C -- Yes --> D[Deduplicate: Return Promise];
  C -- No --> E{Is Cache Fresh?};
  E -- Yes --> F[Return Cached Data];
  B --> G[Initiate New Fetch];
  E -- No --> G;
  G --> H[Atomic Slot Claim];
  H --> I[Execute Fetch Cycle];
  I --> J[Return New Promise];
  D --> End([End]);
  F --> End;
  J --> End;
```

`Sources: src/core/store-engine.ts (triggerFetch and executeFetchCycle)`

## Concurrency & Race Condition Mitigation

The core of this factory's design is its resilience to asynchronous race conditions. The store contains several specific mechanisms to handle dangerous edge cases that arise from overlapping network requests and state updates.

### Problem: Duplicate Requests on Initial Render

In React, two components can mount simultaneously (e.g., in `StrictMode`). Both could call `triggerFetch` for the same key _before_ the store's state has been updated to reflect that a fetch has started. This is a classic "Time-of-check to time-of-use" (TOCTOU) vulnerability that leads to redundant network calls.

```mermaid
sequenceDiagram
   participant CompA as Component A
   participant CompB as Component B
   participant Store
   participant API

   CompA->>Store: triggerFetch(key)
   note right of CompA: Checks store, sees no inFlightPromise. Proceeds...
   CompB->>Store: triggerFetch(key)
   note right of CompB: Checks store, ALSO sees no inFlightPromise. Proceeds...
   note over Store: The time gap between check and set allows a race.
   Store->>API: Network Request 1
   Store->>API: Network Request 2 (DUPLICATE!)
```

#### Solution: Atomic Slot Claim with a Deferred Promise

The store prevents this race condition by separating promise creation from async execution.

1. A `Promise` object is created using a `defer()` utility.
2. This `Promise` is **immediately and synchronously** stored in the state as `inFlightPromise`. This action acts as an atomic "slot claim."
3. Any other component calling `triggerFetch` will now instantly find this `inFlightPromise` and receive it back, effectively deduplicating the request.
4. Only _after_ the slot is claimed does the async `executeFetchCycle` begin.

This pattern ensures that only one fetch cycle can be initiated for a given key. `Sources: src/core/store-engine.ts (request-slot claim)`

### Problem: Stale Data from Superseded Requests

A user might trigger a `refetch` while a previous, slower request for the same key is still in its retry-delay phase. If the new fetch succeeds, the old request's `finally` block (the "stale worker") could incorrectly clear the loading state or otherwise modify the new, correct state.

#### Solution: The `inFlightToken` Guard

Each fetch cycle is assigned a unique `Symbol` called an `inFlightToken`, which is stored in the query's state. When a fetch cycle completes, its `finally` block reads the current state. It will only proceed with state modification if the `inFlightToken` in the store **is the exact same one** it was created with. If a newer fetch has started, the token will have changed, and the stale worker will do nothing.

`Sources: src/core/store-engine.ts (in-flight token guard)`

### Problem: "Zombie" State After Clearing

A user could call the `clear()` function for a query while a fetch for that same query is still in-flight. If the fetch eventually resolves with data, it could attempt to write that data back into the store, "resurrecting" a query that was meant to be destroyed.

#### Solution: Post-Resolution State Validation

Each fetch cycle validates both the query's existence and its in-flight token before committing state. If `clear()` removed the query, or a newer cycle owns the token, the old worker cannot resurrect or overwrite state.

`Sources: src/core/store-engine.ts (cycle finalization)`

---

## Error Handling & The Retry Cycle (`executeFetchCycle`)

The `executeFetchCycle` function is the "workhorse" that handles the actual network requests and retry logic.

```mermaid
graph TD
   Start([Start executeFetchCycle]) --> A{Loop through attempts};
   A -- Next Attempt --> B{Is Request Aborted?};
   B -- Yes --> End([End Cycle]);
   B -- No --> C[runFetchAttempt];
   C --> D{Success?};
   D -- Yes --> E[Update State with Data];
   E --> F[Schedule Poll Timer];
   F --> End;
   D -- No --> G{Should Retry?};
   G -- No --> H[Update State with Error];
   H --> End;
   G -- Yes --> I[Wait for Abort-Aware Delay];
   I --> A;
```

- **Standardization:** All errors are processed by the **injected `errorMapper`**, which classifies them and returns a standardized `ApiError` object. `Sources: src/core/store-engine.ts, src/adapter/axios.ts`
- **Abort-Aware Delays:** As shown in step `I`, the retry delay is abort-aware. It's wrapped in a `Promise` that will `reject` if the request's `AbortSignal` is fired, correctly terminating the retry cycle. `Sources: src/core/store-engine.ts`
- **Server-Driven Retries:** The retry logic correctly prioritizes a valid server-provided `retryAfter` value over the client-side exponential backoff. `Sources: src/core/store-engine.ts, src/adapter/axios.ts`

---

## Lifecycle & Memory Management

The factory is designed for long-running single-page applications (SPAs), where preventing memory leaks is critical. The system employs a two-pronged approach to memory management: deliberate **manual cache clearing** by the developer and a robust **automatic garbage collection** safety net.

### Runtime Services and Global Coordination

The internal `RuntimeServices` instance owns the unified store registry, GC scheduler, clock, logger, and internal-error reporter. The default runtime is used by the public global functions. The convenient root entry configures its Loglevel logger; the pure entry uses a no-op logger unless the application supplies one. Store registration is automatic and begins only after a store contains a cached query.

`Sources: src/core/runtime.ts, src/core/api-store-gc.ts, src/index.ts, src/pure.ts`

```typescript
// In your main App.tsx
import {
  initializeApiRegistry,
  startApiStoreGarbageCollector,
  stopApiStoreGarbageCollector,
} from 'factora';
import { loglevelAdapter } from 'factora/adapter/loglevel';
import log from 'loglevel';
import React, { useEffect } from 'react';

// 1. Initialize loglevel itself.
log.setLevel('info');

// 2. Configure the default runtime logger.
initializeApiRegistry({ logger: loglevelAdapter });

function App() {
  useEffect(() => {
    // 3. Start the shared GC scheduler.
    startApiStoreGarbageCollector({ logger: loglevelAdapter });
    return () => stopApiStoreGarbageCollector();
  }, []);

  // ... rest of your application ...
}
```

### Developer's Role in Manual Memory Management

The `useEffect` in `useApiQuery` **deliberately does not clear data or abort its request on component unmount.** This is a critical design choice for a **shared cache architecture**. If one component unmounts, the request and its data must persist for any other components subscribed to the same query.

This design gives developers explicit control over the cache's lifecycle. The `useApiQuery` hook returns `clear()` and a static `clearAll()` function to manage the data for its specific store.

`Sources: src/react/create-query-hook.ts`

#### Cache Clearing Strategies

The following strategies are recommended for managing the cache manually:

| Strategy         | Action                                                             | Pro                             | Con                                                | When to Use It                                                                   |
| :--------------- | :----------------------------------------------------------------- | :------------------------------ | :------------------------------------------------- | :------------------------------------------------------------------------------- |
| **Aggressive**   | Call `clear()` on unmount of a detail view.                        | Keeps memory usage low.         | Slower UI if user toggles back (requires refetch). | Ideal for "drill-down" UIs or when data payloads are very large.                 |
| **Conservative** | Do NOT call `clear()` on unmount.                                  | Instantaneous UI for toggling.  | Higher memory usage.                               | Ideal for "tab-switching" UIs where users frequently reuse a small set of views. |
| **Global**       | Call `clearAll()` or `clearAllApiStores()` on major state changes. | Predictable, wholesale cleanup. | Less granular.                                     | Essential for logout or switching user profiles/workspaces.                      |

#### Global vs. Local Clearing

It is crucial to distinguish between the local `clearAll` function provided by a hook and the global `clearAllApiStores` function used for app-wide events like logout.

| Function                | Scope      | Where it's defined                                                                                            | Common Use Case                                                           |
| :---------------------- | :--------- | :------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------ |
| `useMyStore.clearAll()` | **Local**  | Attached to a specific store hook (e.g., `useFireflyAccountStore`). `Sources: src/react/create-query-hook.ts` | Clearing all _account_ data when leaving the accounts section of the app. |
| `clearAllApiStores()`   | **Global** | Exported from `factora/pure`. `Sources: src/pure.ts`                                                          | Clearing data from _every single API store_ when the user logs out.       |

### Automatic Garbage Collection

For any data that is not manually cleared, the system provides an automatic garbage collection (GC) safety net to evict stale and unused query data from the store's cache.

#### Architectural Pattern: Subscription-Aware GC

The chosen pattern is a **centralized, subscription-aware garbage collector**. This avoids putting GC logic inside every hook or component. Each store has its own subscription manager, while `RuntimeServices` maintains one registry of `StoreHandle` objects. A handle exposes `clearAllQueryStates`, `clearStaleQueries`, and `refetchStaleQueries`.

```mermaid
graph TD
subgraph Global Process
A["api-store-gc<br/>(Global Interval)"]
end

    subgraph Store Instance
        C["createApiStore<br/>(clearStaleQueries logic)"]
    end

    subgraph Runtime
        B["RuntimeServices<br/>(StoreHandle registry)"]
    end

    A -- "Sweeps periodically" --> C;
    C -- "Uses its subscription manager" --> C;
    B -- "Invokes store handles" --> C;
    C -- "Evicts if No and stale" --> D((Memory Freed));

```

1. **Global Garbage Collector (`api-store-gc.ts`):** A compatibility facade over the runtime scheduler. It runs a bounded `setInterval` sweep and delegates to registered store handles. `Sources: src/core/api-store-gc.ts, src/core/runtime.ts`
2. **Per-store subscriptions (`subscription-registry.ts`):** Each store owns its subscription manager, so stores with identical endpoints cannot share subscriber state. The GC will **never** evict a query key that still has an active subscriber in that store. `Sources: src/utils/subscription-registry.ts, src/core/store-engine.ts`
3. **Store cleanup logic (`store-engine.ts`):** The engine atomically identifies stale, unused queries, captures their resources, removes them, and then performs best-effort abort/timer cleanup. `Sources: src/core/store-engine.ts`

#### Preventing Race Conditions in Garbage Collection

The GC process is highly sensitive to race conditions. The implementation includes specific guards against several dangerous scenarios.

- **Time-of-Check to Time-of-Use (TOCTOU):** All checks (staleness, subscription status) and the state mutation are performed **atomically within a single `set()` callback**, which operates on a consistent state snapshot. `Sources: src/core/store-engine.ts`

- **Stale Resource Cleanup:** To prevent leaking timers or aborting newly created requests, the GC uses a two-phase "Capture and Unconditional Cleanup" pattern.
  1. **Capture & Delete:** Inside the atomic `set()` block, it captures the resources (`abortController`, `refetchTimerId`) of an entry marked for eviction and then deletes the entry from state.
  2. **Unconditional Cleanup:** _After_ the `set()` operation completes, it **unconditionally** cleans up the captured resources. This is safe because a new fetch for the same key will _always_ create a brand-new `AbortController` and timer ID.

  `Sources: src/core/store-engine.ts`

#### Scheduler Ownership

The runtime records the scheduler that created the active interval and always stops the interval through that same scheduler. This keeps custom schedulers deterministic in tests and prevents a mismatched stop call from leaking a GC job.

`Sources: src/core/runtime.ts, src/core/api-store-gc.ts`

## Runtime Registry: Global Coordination

While each store is isolated, some actions need to be coordinated globally. The internal `RuntimeServices` owns one `StoreHandle` registry. The compatibility module `api-store-registry.ts` proxies the default runtime, preserving the existing public functions.

`Sources: src/core/runtime.ts, src/core/api-store-registry.ts`

Each store registers when its first query is created, remains registered while cached queries exist, and deregisters after it becomes empty. It can register again if a later query reuses the same factory. Global `refetchAllStaleQueries()` and `clearAllApiStores()` snapshot the registry and isolate failures so one store cannot prevent other stores from being processed.

### Host-Triggered Aged Revalidation

`revalidateAgedQueries()` is a separate global lifecycle action, exported by both `factora` and `factora/pure`. It is intended for a host application to call from its own reconnect or foreground lifecycle callback; Factora does not attach browser listeners or schedule a revalidation timer.

Configure a store with `revalidateAfterMs` to opt into this behavior:

```typescript
import { createApiStore, revalidateAgedQueries } from 'factora';

export const useProjectsStore = createApiStore('/projects', fetchProjects, {
  cacheTTL: 10 * 60 * 1000,
  revalidateAfterMs: 60 * 1000,
});

host.onReconnect(() => revalidateAgedQueries());
host.onForeground(() => revalidateAgedQueries());
```

The three freshness settings have distinct responsibilities:

| Setting                  | Meaning                                                                                                                    |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| `cacheTTL`               | Normal reads use a successful cached result while it remains fresh. Once it is stale, the next normal read fetches.        |
| `refetchIntervalMinutes` | The store schedules polling fetches at the configured interval.                                                            |
| `revalidateAfterMs`      | Enables a query for a host-invoked revalidation once its age is **strictly greater than** the threshold. It does not poll. |

When invoked, `revalidateAgedQueries()` force-fetches eligible successful cached queries even if their `cacheTTL` is still fresh. Queries that are already in flight or in an error state are skipped. Omit `revalidateAfterMs` (or pass a non-positive value) to disable the feature; existing stores therefore retain their previous behavior without migration.

### `clearAll()` vs. `clearAllApiStores()`

It's important to understand the difference between these two functions:

| Function                | Scope      | Where it's defined                                                                                            | Common Use Case                                                           |
| :---------------------- | :--------- | :------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------ |
| `useMyStore.clearAll()` | **Local**  | Attached to a specific store hook (e.g., `useFireflyAccountStore`). `Sources: src/react/create-query-hook.ts` | Clearing all _account_ data when leaving the accounts section of the app. |
| `clearAllApiStores()`   | **Global** | Exported from `factora/pure`. `Sources: src/pure.ts`                                                          | Clearing data from _every single API store_ when the user logs out.       |
