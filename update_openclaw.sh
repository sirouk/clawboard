!#/bin/bash

cd $HOME/openclaw
git checkout package.json
git checkout main
git pull

pnpm self-update
pnpm install
pnpm ui:build
pnpm build

autoload -Uz compinit
compinit

openclaw doctor --non-interactive --fix
openclaw gateway restart