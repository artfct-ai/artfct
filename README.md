# artfct

art(i)f(a)ct is a framework designed for professional software engineers to minimize cognitive load and retain context about how their systems work while working with coding agents.

Please note this project is still under early development and hasn't been released yet in any form. A docs site and more detail on the project will be published prior to the initial release.

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
