# Argus Tracker

Argus Tracker is a browser session replay and frontend observability SDK based
on [OpenReplay Tracker](https://github.com/openreplay/openreplay/tree/main/tracker/tracker).
It is maintained as an independent fork and is not affiliated with or endorsed
by OpenReplay.

## Documentation

Most constructor options and public methods are inherited from OpenReplay. See
the [OpenReplay tracker documentation](https://docs.openreplay.com/en/sdk/methods)
for the upstream API reference.

## Installation

```bash
npm install argus-tracker
```

## Usage

Initialize the package from your application entry point and start the tracker.
You need a `projectKey` issued by a compatible Argus or OpenReplay deployment.

```js
import Tracker from 'argus-tracker'

const tracker = new Tracker({
  projectKey: YOUR_PROJECT_KEY,
  revID: process.env.APP_RELEASE,
})
tracker
  .start({
    userID: 'Mr.Smith',
    metadata: {
      version: '3.5.0',
      balance: '10M',
      role: 'admin',
    },
  })
  .then((startedSession) => {
    if (startedSession.success) {
      console.log(startedSession)
    }
  })
```

You can then use the inherited tracker API anywhere in your application.

```js
tracker.setUserID('my_user_id')
tracker.setMetadata('env', 'prod')
```

## React Error Boundary

Use `captureException` in an Error Boundary to report handled React rendering
errors. The tracker automatically attaches the current URL and route; pass the
React component stack when it is available.

```tsx
import React from 'react'
import Tracker from 'argus-tracker'

const tracker = new Tracker({ projectKey: YOUR_PROJECT_KEY })

class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    tracker.captureException(error, {
      componentStack: info.componentStack ?? undefined,
    })
  }

  render() {
    if (this.state.hasError) {
      return <p>Something went wrong.</p>
    }
    return this.props.children
  }
}
```

Call `captureException` only after the tracker has started. The same `Error`
object will not be reported again by the global `error` or
`unhandledrejection` handlers.

## Automatic SourceMap upload

Generate hidden SourceMaps during the application build and use the same
release value for Tracker `revID` and the uploader:

```bash
VITE_APP_REVISION="$CI_COMMIT_SHA" npm run build
ARGUS_URL="https://argus.example.com" \
ARGUS_RELEASE="$CI_COMMIT_SHA" \
ARGUS_SOURCEMAP_TOKEN="$ARGUS_SOURCEMAP_TOKEN" \
npx --no-install argus-sourcemaps upload --dir dist --delete-after-upload
```

Create a project-scoped upload token in your Argus deployment and store it as a
protected CI secret. The uploader does not print the token and deletes `.map`
files only after the corresponding upload succeeds.

## Development

Use [Bun](https://bun.sh/) for dependency installation and npm scripts for the
project tasks:

```bash
bun install --frozen-lockfile
npm test
npm run build
npm run pack:check
```

Pull requests should pass the full test and build pipeline.

## Security and privacy

Session replay can collect application and user interaction data. Configure
the inherited sanitization options before production use and never commit
project keys or upload tokens to source control. Report security issues through
the repository's private GitHub security advisory feature.

## License and attribution

Released under the MIT License. This project contains code derived from
OpenReplay Tracker; see [NOTICE](./NOTICE) for attribution.
