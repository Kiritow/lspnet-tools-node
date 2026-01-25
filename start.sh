#!/bin/bash
npm run build
node --enable-source-maps $(pwd)/dist/index.js run -d "$@"
