# `src/routes/`

Route components that are more than one screen.

Most admin routes mount a screen directly, so `router.tsx` can name the screen in
its `lazyRouteComponent(...)` and there is nothing else to keep. The nine files
here are the routes that adapt something first (read a search param, pick
between a list and a detail view, hand a screen a navigation callback), and that
adapter used to live in `router.tsx` as a small function above the route.

They moved out for ONE reason: a route component is only code-split if it is the
thing `lazyRouteComponent` imports. An adapter defined in `router.tsx` has to
import its screens at the top of `router.tsx`, which puts Invoices, Directory,
KinTales and the rest back in the entry chunk and undoes the split for exactly
the heaviest screens in the app.

They read their own search/params with `useSearch({ from })` / `useParams({ from })`
rather than `someRoute.useSearch()`, so nothing here imports `router.tsx`. The
`from` ids are checked against the route tree at compile time, same as the route
objects were, so a renamed path still fails the build.
