!#/bin/bash

cd $HOME/openclaw
git checkout main
git pull

pnpm install
pnpm ui:build
pnpm build
