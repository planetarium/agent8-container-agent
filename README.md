# agent8-container-agent

To install dependencies:

```bash
bun install
```

## Environment Variables

The application uses the following environment variables:

```
PORT=3000
WORKDIR_NAME=/workspace
COEP=credentialless
FORWARD_PREVIEW_ERRORS=true
```

You can configure these variables in two ways:

1. For local development, create a `.env` file in the root directory with the values above.
2. When running the container, you can override the default values by setting environment variables:

```bash
docker run -e PORT=8080 -e WORKDIR_NAME=/custom-workspace ... agent8-container-agent
```

Default values are already set in the Containerfile.

## Running the Application

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.10. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
