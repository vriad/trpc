/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable @typescript-eslint/no-explicit-any */
import '@testing-library/jest-dom';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectTypeOf } from 'expect-type';
import hash from 'hash-sum';
import React, { Fragment, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import * as z from 'zod';
import { ZodError } from 'zod';
import { createReactQueryHooks, OutputWithCursor } from '../../react/src';
import * as trpc from '../src';
import { DefaultErrorShape } from '../src';
import { routerToServerAndClient } from './_testHelpers';

type Context = {};
type Post = {
  id: string;
  title: string;
  createdAt: number;
};

function createAppRouter() {
  const db: {
    posts: Post[];
  } = {
    posts: [
      { id: '1', title: 'first post', createdAt: 0 },
      { id: '2', title: 'second post', createdAt: 1 },
    ],
  };
  const postLiveInputs: unknown[] = [];

  const allPosts = jest.fn();
  const postById = jest.fn();
  const appRouter = trpc
    .router<Context>()
    .formatError(({ defaultShape, error }) => {
      return {
        $test: 'formatted',
        zodError:
          error.originalError instanceof ZodError
            ? error.originalError.flatten()
            : null,
        ...defaultShape,
      };
    })
    .query('allPosts', {
      resolve() {
        allPosts();
        return db.posts;
      },
    })
    .query('postById', {
      input: z.string(),
      resolve({ input }) {
        postById(input);
        const post = db.posts.find((p) => p.id === input);
        if (!post) {
          throw trpc.httpError.notFound();
        }
        return post;
      },
    })
    .query('paginatedPosts', {
      input: z.object({
        limit: z.number().min(1).max(100).optional(),
        cursor: z.number().optional(),
      }),
      resolve({ input: { limit = 50, cursor } }) {
        const items: typeof db.posts = [];
        let nextCursor: typeof cursor | undefined = undefined;
        for (let index = 0; index < db.posts.length; index++) {
          const element = db.posts[index];
          if (typeof cursor !== 'undefined' && element.createdAt < cursor) {
            continue;
          }
          items.push(element);
          if (items.length >= limit) {
            break;
          }
        }
        const last = items[items.length - 1];
        const nextIndex = db.posts.findIndex((item) => item === last) + 1;
        if (db.posts[nextIndex]) {
          nextCursor = db.posts[nextIndex].createdAt;
        }
        return {
          items,
          nextCursor,
        };
      },
    })
    .mutation('addPost', {
      input: z.object({
        title: z.string(),
      }),
      resolve({ input }) {
        db.posts.push({
          id: `${Math.random()}`,
          createdAt: Date.now(),
          title: input.title,
        });
      },
    })
    .subscription('newPosts', {
      input: z.number(),
      resolve({ input }) {
        return trpc.subscriptionPullFactory<Post>({
          intervalMs: 1,
          pull(emit) {
            db.posts.filter((p) => p.createdAt > input).forEach(emit.data);
          },
        });
      },
    })
    .subscription('postsLive', {
      input: z.object({
        cursor: z.string().nullable(),
      }),
      resolve({ input }) {
        const { cursor } = input;
        postLiveInputs.push(input);

        return trpc.subscriptionPullFactory<OutputWithCursor<Post[]>>({
          intervalMs: 10,
          pull(emit) {
            const newCursor = hash(db.posts);
            if (newCursor !== cursor) {
              emit.data({ data: db.posts, cursor: newCursor });
            }
          },
        });
      },
    });

  const { client, close } = routerToServerAndClient(appRouter);
  const queryClient = new QueryClient();
  const hooks = createReactQueryHooks({
    client,
    queryClient,
  });

  return {
    appRouter,
    hooks,
    close,
    db,
    postLiveInputs,
    resolvers: {
      postById,
      allPosts,
    },
  };
}
let factory: ReturnType<typeof createAppRouter>;
beforeEach(() => {
  factory = createAppRouter();
});
afterEach(() => {
  factory.close();
});

describe('useQuery()', () => {
  test('no input', async () => {
    const { hooks } = factory;
    function MyComponent() {
      const allPostsQuery = hooks.useQuery(['allPosts']);
      expectTypeOf(allPostsQuery.data!).toMatchTypeOf<Post[]>();

      return <pre>{JSON.stringify(allPostsQuery.data ?? 'n/a', null, 4)}</pre>;
    }
    function App() {
      return (
        <QueryClientProvider client={hooks.queryClient}>
          <MyComponent />
        </QueryClientProvider>
      );
    }

    const utils = render(<App />);
    await waitFor(() => {
      expect(utils.container).toHaveTextContent('first post');
    });
  });

  test('with input', async () => {
    const { hooks } = factory;
    function MyComponent() {
      const allPostsQuery = hooks.useQuery(['paginatedPosts', { limit: 1 }]);

      return <pre>{JSON.stringify(allPostsQuery.data ?? 'n/a', null, 4)}</pre>;
    }
    function App() {
      return (
        <QueryClientProvider client={hooks.queryClient}>
          <MyComponent />
        </QueryClientProvider>
      );
    }

    const utils = render(<App />);
    await waitFor(() => {
      expect(utils.container).toHaveTextContent('first post');
    });
    expect(utils.container).not.toHaveTextContent('second post');
  });
});

test('mutation on mount + subscribe for it', async () => {
  const { hooks } = factory;
  function MyComponent() {
    const [posts, setPosts] = useState<Post[]>([]);

    const addPosts = (newPosts?: Post[]) => {
      setPosts((nowPosts) => {
        const map: Record<Post['id'], Post> = {};
        for (const msg of nowPosts ?? []) {
          map[msg.id] = msg;
        }
        for (const msg of newPosts ?? []) {
          map[msg.id] = msg;
        }
        return Object.values(map);
      });
    };
    const input = posts.reduce(
      (num, post) => Math.max(num, post.createdAt),
      -1,
    );

    hooks.useSubscription(['newPosts', input], {
      onBatch(posts) {
        addPosts(posts);
      },
    });

    const mutation = hooks.useMutation('addPost');
    const mutate = mutation.mutate;
    useEffect(() => {
      if (posts.length === 2) {
        mutate({ title: 'third post' });
      }
    }, [posts.length, mutate]);

    return <pre>{JSON.stringify(posts, null, 4)}</pre>;
  }
  function App() {
    return (
      <QueryClientProvider client={hooks.queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  }

  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
  });
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('third post');
  });
});

test('useLiveQuery()', async () => {
  const { hooks, db, postLiveInputs } = factory;
  function MyComponent() {
    const postsQuery = hooks.useLiveQuery(['postsLive', {}]);

    return <pre>{JSON.stringify(postsQuery.data ?? null, null, 4)}</pre>;
  }
  function App() {
    return (
      <QueryClientProvider client={hooks.queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  }

  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
  });

  for (let index = 0; index < 3; index++) {
    const title = `a new post index:${index}`;
    db.posts.push({
      id: `r${index}`,
      createdAt: 0,
      title,
    });

    await waitFor(() => {
      expect(utils.container).toHaveTextContent(title);
    });
  }

  expect(utils.container.innerHTML).not.toContain('cursor');
  expect(postLiveInputs).toMatchInlineSnapshot(`
    Array [
      Object {
        "cursor": null,
      },
      Object {
        "cursor": "03bee962",
      },
      Object {
        "cursor": "712d2d40",
      },
      Object {
        "cursor": "7c5d7196",
      },
    ]
  `);
});

test('dehydrate', async () => {
  const { hooks, appRouter, db } = factory;
  const ssr = hooks.ssr(appRouter, {});

  await ssr.prefetchQuery('allPosts');

  const dehydrated = hooks.dehydrate().queries;
  expect(dehydrated).toHaveLength(1);

  const [cache] = dehydrated;
  expect(cache.queryHash).toMatchInlineSnapshot(
    `"[\\"allPosts\\",null,\\"TRPC_QUERY\\"]"`,
  );
  expect(cache.queryKey).toMatchInlineSnapshot(`
    Array [
      "allPosts",
      null,
      "TRPC_QUERY",
    ]
  `);
  expect(cache.state.data).toEqual(db.posts);
});

test('prefetchQuery', async () => {
  const { hooks } = factory;
  function MyComponent() {
    const [state, setState] = useState<string>('nope');
    useEffect(() => {
      async function prefetch() {
        await hooks.prefetchQuery(['postById', '1']);
        setState(JSON.stringify(hooks.dehydrate()));
      }
      prefetch();
    }, []);

    return <>{JSON.stringify(state)}</>;
  }
  function App() {
    return (
      <QueryClientProvider client={hooks.queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  }

  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
  });
});

test('useInfiniteQuery()', async () => {
  const { hooks } = factory;

  function MyComponent() {
    const q = hooks.useInfiniteQuery(
      [
        'paginatedPosts',
        {
          limit: 1,
        },
      ],
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
    );
    expectTypeOf(q.data?.pages[0].items).toMatchTypeOf<undefined | Post[]>();

    return q.status === 'loading' ? (
      <p>Loading...</p>
    ) : q.status === 'error' ? (
      <p>Error: {q.error.message}</p>
    ) : (
      <>
        {q.data?.pages.map((group, i) => (
          <Fragment key={i}>
            {group.items.map((msg) => (
              <Fragment key={msg.id}>
                <div>{msg.title}</div>
              </Fragment>
            ))}
          </Fragment>
        ))}
        <div>
          <button
            onClick={() => q.fetchNextPage()}
            disabled={!q.hasNextPage || q.isFetchingNextPage}
            data-testid="loadMore"
          >
            {q.isFetchingNextPage
              ? 'Loading more...'
              : q.hasNextPage
              ? 'Load More'
              : 'Nothing more to load'}
          </button>
        </div>
        <div>
          {q.isFetching && !q.isFetchingNextPage ? 'Fetching...' : null}
        </div>
      </>
    );
  }
  function App() {
    return (
      <QueryClientProvider client={hooks.queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  }

  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
  });
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
    expect(utils.container).not.toHaveTextContent('second post');
    expect(utils.container).toHaveTextContent('Load More');
  });
  userEvent.click(utils.getByTestId('loadMore'));
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('Loading more...');
  });
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('first post');
    expect(utils.container).toHaveTextContent('second post');
    expect(utils.container).toHaveTextContent('Nothing more to load');
  });

  expect(utils.container).toMatchInlineSnapshot(`
    <div>
      <div>
        first post
      </div>
      <div>
        second post
      </div>
      <div>
        <button
          data-testid="loadMore"
          disabled=""
        >
          Nothing more to load
        </button>
      </div>
      <div />
    </div>
  `);
});

test('prefetchInfiniteQuery()', async () => {
  const { hooks, appRouter } = factory;
  const ssr = hooks.ssr(appRouter, {});

  await ssr.prefetchInfiniteQuery('paginatedPosts', { limit: 1 });

  const data = JSON.stringify(hooks.dehydrate());
  expect(data).toContain('first post');
  expect(data).not.toContain('second post');
});

describe('invalidate queries', () => {
  test('queryClient.invalidateQueries()', async () => {
    const { hooks, resolvers } = factory;
    function MyComponent() {
      const allPostsQuery = hooks.useQuery(['allPosts'], {
        staleTime: Infinity,
      });
      const postByIdQuery = hooks.useQuery(['postById', '1'], {
        staleTime: Infinity,
      });

      return (
        <>
          <pre>
            allPostsQuery:{allPostsQuery.status} allPostsQuery:
            {allPostsQuery.isStale ? 'stale' : 'not-stale'}{' '}
          </pre>
          <pre>
            postByIdQuery:{postByIdQuery.status} postByIdQuery:
            {postByIdQuery.isStale ? 'stale' : 'not-stale'}
          </pre>
          <button
            data-testid="refetch"
            onClick={() => {
              hooks.queryClient.invalidateQueries(['allPosts']);
              hooks.queryClient.invalidateQueries(['postById']);
            }}
          />
        </>
      );
    }
    function App() {
      return (
        <QueryClientProvider client={hooks.queryClient}>
          <MyComponent />
        </QueryClientProvider>
      );
    }

    const utils = render(<App />);

    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:success');
      expect(utils.container).toHaveTextContent('allPostsQuery:success');

      expect(utils.container).toHaveTextContent('postByIdQuery:not-stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:not-stale');
    });

    expect(resolvers.allPosts).toHaveBeenCalledTimes(1);
    expect(resolvers.postById).toHaveBeenCalledTimes(1);

    utils.getByTestId('refetch').click();

    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:stale');
    });
    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:not-stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:not-stale');
    });

    expect(resolvers.allPosts).toHaveBeenCalledTimes(2);
    expect(resolvers.postById).toHaveBeenCalledTimes(2);
  });

  test('invalidateQuery()', async () => {
    const { hooks, resolvers } = factory;
    function MyComponent() {
      const allPostsQuery = hooks.useQuery(['allPosts'], {
        staleTime: Infinity,
      });
      const postByIdQuery = hooks.useQuery(['postById', '1'], {
        staleTime: Infinity,
      });

      return (
        <>
          <pre>
            allPostsQuery:{allPostsQuery.status} allPostsQuery:
            {allPostsQuery.isStale ? 'stale' : 'not-stale'}{' '}
          </pre>
          <pre>
            postByIdQuery:{postByIdQuery.status} postByIdQuery:
            {postByIdQuery.isStale ? 'stale' : 'not-stale'}
          </pre>
          <button
            data-testid="refetch"
            onClick={() => {
              hooks.invalidateQuery(['allPosts']);
              hooks.invalidateQuery(['postById', '1']);
            }}
          />
        </>
      );
    }
    function App() {
      return (
        <QueryClientProvider client={hooks.queryClient}>
          <MyComponent />
        </QueryClientProvider>
      );
    }

    const utils = render(<App />);

    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:success');
      expect(utils.container).toHaveTextContent('allPostsQuery:success');

      expect(utils.container).toHaveTextContent('postByIdQuery:not-stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:not-stale');
    });

    expect(resolvers.allPosts).toHaveBeenCalledTimes(1);
    expect(resolvers.postById).toHaveBeenCalledTimes(1);

    utils.getByTestId('refetch').click();

    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:stale');
    });
    await waitFor(() => {
      expect(utils.container).toHaveTextContent('postByIdQuery:not-stale');
      expect(utils.container).toHaveTextContent('allPostsQuery:not-stale');
    });

    expect(resolvers.allPosts).toHaveBeenCalledTimes(2);
    expect(resolvers.postById).toHaveBeenCalledTimes(2);
  });
});

test('formatError() react types test', async () => {
  const { hooks } = factory;
  function MyComponent() {
    const mutation = hooks.useMutation('addPost');

    useEffect(() => {
      mutation.mutate({ title: 123 as any });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (mutation.error && mutation.error.json && mutation.error.shape) {
      expectTypeOf(mutation.error.json.error).toMatchTypeOf<
        DefaultErrorShape & {
          $test: string;
        }
      >();
      expectTypeOf(mutation.error.shape).toMatchTypeOf<
        DefaultErrorShape & {
          $test: string;
        }
      >();
      return (
        <pre data-testid="err">
          {JSON.stringify(mutation.error.shape.zodError, null, 2)}
        </pre>
      );
    }
    return <></>;
  }
  function App() {
    return (
      <QueryClientProvider client={hooks.queryClient}>
        <MyComponent />
      </QueryClientProvider>
    );
  }

  const utils = render(<App />);
  await waitFor(() => {
    expect(utils.container).toHaveTextContent('fieldErrors');
    expect(utils.getByTestId('err').innerText).toMatchInlineSnapshot(
      `undefined`,
    );
  });
});
