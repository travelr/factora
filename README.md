# factora

[![NPM Version](https://img.shields.io/npm/v/factora?style=flat&color=blue)](https://www.npmjs.com/package/factora)
[![GitHub Stars](https://img.shields.io/github/stars/travelr/factora?style=social)](https://github.com/travelr/factora)
[![License](https://img.shields.io/npm/l/factora?style=flat&color=brightgreen)](https://github.com/travelr/factora/blob/main/LICENSE)

**`factora` is a factory that creates zero-config, singleton data-fetching hooks for React — with caching, retries, and garbage collection built in.**

---

### Key Benefits

- ⚡️ **Snappy UI with smart caching:** When returning to a page, freshly cached data (within its TTL) is shown instantly, often eliminating loading spinners.
- 💪 **Resilient UI with automatic retries:** Transient network errors are retried automatically with an exponential backoff. So that temporary glitches don’t break your UI.
- 🗑️ **Effortless memory management:** Queries no longer used by any component are garbage-collected automatically. This avoids memory leaks in long-running apps.
- 🏛️ **Build a True Data Layer:** `factora` provides the foundation to separate your data-fetching _infrastructure_ from your _business logic_, enabling a clean, scalable, and type-safe architecture.

---

### The Factory Pattern: A Centralized Data Layer

`factora` follows a simple principle: centralize data-fetching logic to keep it consistent and reusable. The `createApiStore` factory lets you define each data source once and use the resulting hooks everywhere.

This provides immediate benefits for teams:

1.  **Consistency Guaranteed:** Every component relies on the same pre-configured hook, keeping caching and retry behavior identical across your entire application.
2.  **Simpler Components:** UI code focuses purely on rendering state—not on the complex mechanics of how or when to fetch data.
3.  **Easy Maintenance:** Change how an endpoint is fetched or cached in one place, and the whole app updates automatically.

This approach naturally encourages a clean separation of concerns that aligns with principles like Domain-Driven Design (DDD). You can structure your application into distinct layers:

- **Infrastructure Layer:** The `factora` hooks you create become your reusable, application-wide "repositories." They handle the mechanics of data fetching.
- **Business Layer:** You can create your own custom hooks that contain your business logic. They orchestrate calls to the infrastructure hooks to compose data perfect aligned to your UI components.
- **Presentation Layer:** Your React components become the clean, declarative presentation layer.

This separation makes your components simpler, your business logic more explicit and testable, and your data-fetching consistent by default.

---

### Installation

```bash
npm install factora
```

### Peer Dependencies

factora requires React and Zustand to be installed in your project:

```bash
npm install react zustand
```

---

### The Core Architecture

`factora` provides out-of-the-box solutions to difficult async problems.

```mermaid
flowchart TD
A["API Fetcher<br>(e.g., Axios/fetch)"] --> B(createApiStore Factory);
B --> C(("Singleton Store<br>(Zustand-based)"));
C --> D[useUserStore Hook];
C --> E[usePostStore Hook];
```

| Feature                            | Description                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Request Deduplication**          | If 10 components call `useUserStore({ userId: 3 })` at once, only **one** network request runs.                                      |
| **Configurable Caching (TTL)**     | Define a `cacheTTL` (ms). Data within its TTL is served instantly from cache, skipping the network.                                  |
| **Automatic Retries**              | Configure `retryAttempts` and `retryDelay`. Failed requests retry automatically with exponential backoff.                            |
| **Race Condition Prevention**      | An internal token system ensures slower responses never overwrite newer ones.                                                        |
| **Automatic Garbage Collection**   | The store tracks subscribers. Once none remain, the cache entry clears after a grace period.                                         |
| **Automatic Refetching (Polling)** | Set `refetchIntervalMinutes` to refresh data periodically, keeping your UI up to date.                                               |
| **Manual Actions**                 | The hooks return stable `refetch()` and `clear()` methods, giving you control to refresh or clear a specific query’s cache manually. |

---

### Architecture & Testing Strategy

`factora` is built for resilience in real-world apps and is covered by a comprehensive test suite.

Tests cover everything from low-level utilities to full integration flows, including caching, retries, garbage collection, and complex race conditions.

For more details:

- 📘 **[Architecture](docs/api-store-factory.md)**
- 🧪 **[Testing Strategy](docs/api-store-factory.tests.md)**

---

### A Practical Example: Building a Data Layer

Here’s a simple example of how to centralize hooks for a blog.

#### Step 1: Create a Centralized API Fetcher (`blog-api.ts`)

This file contains raw data-fetching logic specific to an endpoint

```ts
// src/blog-api.ts.ts
import axios, { type AbortSignal } from 'axios';

// Define your data shapes
export interface Post {
  id: number;
  title: string;
  body: string;
  userId: number;
}
export interface User {
  id: number;
  name: string;
}

const apiClient = axios.create({
  baseURL: 'https://jsonplaceholder.typicode.com',
});

// Generic fetcher
export const apiFetcher = async <T>(
  endpoint: string,
  params: Record<string, any>,
  signal?: AbortSignal,
): Promise<T> => {
  const response = await apiClient.get(endpoint, { params, signal });
  return response.data;
};
```

#### Step 2: Create Your Store Hooks (`blog-stores.ts`)

This file is the single source of truth for your data layer.
Create one data layer per API source

```ts
// src/blog-stores.ts
import { createApiStore } from 'factora';
import { apiFetcher, type Post, type User } from './api';

const defaultOptions = {
cacheTTL: 5 _ 60 _ 1000, // 5 minutes
retryAttempts: 2,
};

// Singleton hooks for each data type
export const usePostsStore = createApiStore<Post[]>(
  '/posts',
  apiFetcher,
  defaultOptions,
);
export const usePostStore = createApiStore<Post>(
  '/posts/:postId',
  apiFetcher,
  defaultOptions,
);
export const useUserStore = createApiStore<User>(
  '/users/:userId',
  apiFetcher,
  defaultOptions,
);
```

#### Step 3: Use the Hooks in Your Components

Your UI components import the pre-configured hooks and remain clean, declarative, and decoupled from the fetching implementation.

```tsx
// src/components/PostDetails.tsx
import { usePostStore, useUserStore } from '../blog-stores';

function AuthorDetails({ userId }: { userId: number }) {
  // Only one netowrk request per userId, even if called multiple times (within TTL)
  const { data: author, isLoading } = useUserStore({ userId });

  if (isLoading) return <p>Loading author...</p>;
  return <p>By: {author?.name ?? 'Unknown'}</p>;
}

function PostDetails({ postId }: { postId: string }) {
  // Fetch the post
  const { data: post, isLoading: isPostLoading } = usePostStore({ postId });

  if (isPostLoading) return <div>Loading post...</div>;
  if (!post) return <div>Post not found.</div>;

  return (
    <article>
      <h1>{post.title}</h1>
      {/* Conditionally render the AuthorDetails component to fetch the author */}
      {post.userId && <AuthorDetails userId={post.userId} />}
      <p>{post.body}</p>
    </article>
  );
}
```

> **Best Practice: Separating Concerns with Domain Hooks**
>
> The example above is simplified for clarity. In a larger application, this pattern truly shines when you create your own **custom "business logic" hooks** that compose multiple store hooks:
>
> - **`factora` Stores (`usePostStore`)** handle the _infrastructure_ concern of data fetching.
> - **Your Custom Hooks (`usePostWithAuthor`)** handle the _domain_ concern of business logic (e.g., orchestrating dependent queries).
> - **Your Components** handle the _presentation_ concern and remain simple.
>
> This separation makes your codebase more modular, scalable, and easier to test.

---

### Contributing & License

Contributions are welcome! Open an issue or submit a pull request.  
This project is released under the [MIT license](https://github.com/travelr/factora/blob/main/LICENSE).
