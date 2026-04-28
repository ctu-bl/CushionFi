FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json yarn.lock .yarnrc .yarnrc.yml ./
COPY .yarn ./.yarn
RUN yarn install --no-lockfile

COPY keeper ./keeper
COPY target ./target

CMD ["node", "--experimental-strip-types", "keeper/src/main.ts"]
