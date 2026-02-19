!#/bin/bash

cd $HOME/openclaw
git reset --hard
git pull
git fetch --all

# checkout latest release tag
current_tag=$(git describe --tags --abbrev=0)
git checkout $current_tag

pnpm self-update
pnpm install
pnpm ui:build
pnpm build

#autoload -Uz compinit
#compinit

openclaw doctor --non-interactive --fix
openclaw gateway restart