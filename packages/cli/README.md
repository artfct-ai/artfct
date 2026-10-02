# artfct

The command line of [artfct](https://github.com/artfct-ai/artfct). It scaffolds a deployment repo, connects the vendors, and checks the repo before a deploy.

It needs Node.js 22 or later.

```sh
npx artfct init          # scaffold the deployment repo in the current directory
npx artfct connect code  # create and install the GitHub App
npx artfct check         # check the deployment repo before a deploy
```

Follow the [install guide](https://github.com/artfct-ai/artfct/blob/main/docs/index.md).

Licensed under the Apache License, Version 2.0. The text ships in `dist/LICENSE`, and the attribution in `dist/NOTICE`.
