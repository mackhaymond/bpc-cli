# Installation

Requires Node.js 22 or newer.

For optional PDF-to-Markdown conversion, install Poppler:

```sh
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt-get install poppler-utils
```

```sh
git clone https://github.com/mackhaymond/bpc-cli.git
cd bpc-cli
npm ci
npm run setup
npm link
```

On Linux, install Chromium's system dependencies if needed:

```sh
npx playwright install --with-deps chromium
```
