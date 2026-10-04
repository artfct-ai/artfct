# artfct

artfct runs software engineering requests through coding agents on your Cloudflare account. A person asks for work in Slack or Linear. The orchestrator agent splits the request into stages, and a coding agent in a sandbox does each stage. Each stage ends in an artifact the humans review, such as a design page, a set of issues, or a pull request.

## Deploy

You need a Cloudflare account, Node.js 22 or later, and an empty GitHub repository for your install. You do not need to clone this repository.

```sh
git clone <deployment-repo-url>
cd <deployment-repo>
npx artfct init
npm install
```

`init` scaffolds the repository and creates its database. The [install guide](docs/index.md#install) covers the remaining steps: the settings, the vendors, and the deploy.

## Documentation

The [documentation](docs/index.md) covers the architecture, the install, the deploy, and each vendor's setup.

## Contributing

The [contributing guide](CONTRIBUTING.md) covers the development setup and the checks a pull request must pass.

## License

Copyright 2026 Matthew A. Kuritz. The source is licensed under the [Apache License, Version 2.0](LICENSE). [`NOTICE`](NOTICE) holds the attribution that copies must keep.
