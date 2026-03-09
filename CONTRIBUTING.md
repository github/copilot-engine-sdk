## Contributing

Hi there! We're thrilled that you'd like to contribute to this project. Your help is essential for keeping it great.

Contributions to this project are released to the public under the project's open source license.

Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

## Development setup

This repository contains a TypeScript SDK and a Go CLI for local engine testing.

### Prerequisites

- Node.js 20+
- npm
- Go (for working on the CLI in `cli/`)

### Install dependencies

```bash
npm install
```

## Building and testing

Run the existing build commands before submitting a pull request:

```bash
npm run build
cd cli && go build ./cmd/engine-cli
```

If you change the SDK and use it from a linked local engine checkout, rebuild the SDK after your changes:

```bash
npm run build
```

## Submitting a pull request

1. Fork the repository and clone your fork.
2. Create a new branch for your change.
3. Make your change and keep it focused.
4. Run the relevant build and test commands locally.
5. Open a pull request with a clear description of the problem and solution.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Using Pull Requests](https://docs.github.com/pull-requests)
- [GitHub Docs](https://docs.github.com)
