#!/bin/bash
npm run build
INSTALL_DIR=$(pwd) node --enable-source-maps $(pwd)/dist/index.js run -d "$@"
